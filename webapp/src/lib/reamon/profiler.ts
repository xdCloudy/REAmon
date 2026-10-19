import type { TargetProfile, TargetType } from './types'

const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'lua', 'luau',
  'go', 'rs', 'swift', 'kt', 'kts', 'cs', 'php', 'html', 'css', 'json', 'xml',
  'yaml', 'yml', 'toml', 'md', 'sql', 'sh', 'bash', 'ps1', 'txt',
])

function extensionOf(name: string): string {
  const last = name.toLowerCase().split('/').pop() || ''
  const match = last.match(/\.([a-z0-9]{1,16})$/)
  return match?.[1] || ''
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length))
}

function readUInt16(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.length) return null
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readUInt32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

function readUInt32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0
}

interface UnityIl2CppApkMembers {
  metadataPath: string
  libraryPaths: string[]
  libraryPathsTruncated: boolean
}

/**
 * Inspect only the APK ZIP central directory. This avoids decompressing any
 * untrusted member just to classify the container and keeps the evidence tied
 * to exact stored member paths for a later bounded extractor.
 */
function unityIl2CppApkMembers(bytes: Uint8Array): UnityIl2CppApkMembers | null {
  const minimumOffset = Math.max(0, bytes.length - 65_557)
  let eocdOffset = -1
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUInt32(bytes, offset) !== 0x06054b50) continue
    const commentLength = readUInt16(bytes, offset + 20)
    if (commentLength !== null && offset + 22 + commentLength === bytes.length) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) return null

  const entryCount = readUInt16(bytes, eocdOffset + 10)
  const centralDirectorySize = readUInt32(bytes, eocdOffset + 12)
  const centralDirectoryOffset = readUInt32(bytes, eocdOffset + 16)
  if (entryCount === null || entryCount === 0xffff || entryCount > 100_000
      || centralDirectorySize === null || centralDirectoryOffset === null
      || centralDirectoryOffset + centralDirectorySize > eocdOffset) return null

  const decoder = new TextDecoder('utf-8')
  let cursor = centralDirectoryOffset
  const end = centralDirectoryOffset + centralDirectorySize
  let metadataPath: string | null = null
  const libraryPaths: string[] = []
  let libraryPathsTruncated = false
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > end || readUInt32(bytes, cursor) !== 0x02014b50) return null
    const nameLength = readUInt16(bytes, cursor + 28)
    const extraLength = readUInt16(bytes, cursor + 30)
    const commentLength = readUInt16(bytes, cursor + 32)
    if (nameLength === null || extraLength === null || commentLength === null
        || nameLength === 0 || cursor + 46 + nameLength + extraLength + commentLength > end) return null

    const memberPath = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).replaceAll('\\', '/')
    const lowerPath = memberPath.toLowerCase()
    if (!metadataPath && /(?:^|\/)global-metadata\.dat$/.test(lowerPath)) metadataPath = memberPath
    if (/^lib\/[^/]+\/libil2cpp\.so$/i.test(memberPath)) {
      if (libraryPaths.length < 32) libraryPaths.push(memberPath)
      else libraryPathsTruncated = true
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return metadataPath && libraryPaths.length ? { metadataPath, libraryPaths, libraryPathsTruncated } : null
}

function hasPyInstallerCookie(bytes: Uint8Array): boolean {
  const signature = [0x4d, 0x45, 0x49, 0x0c, 0x0b, 0x0a, 0x0b, 0x0e]
  const searchStart = Math.max(0, bytes.length - 1024 * 1024)
  for (let offset = bytes.length - signature.length; offset >= searchStart; offset -= 1) {
    let matches = true
    for (let index = 0; index < signature.length; index += 1) {
      if (bytes[offset + index] !== signature[index]) {
        matches = false
        break
      }
    }
    if (!matches) continue
    const packageLength = readUInt32BE(bytes, offset + 8)
    const tocOffset = readUInt32BE(bytes, offset + 12)
    const tocLength = readUInt32BE(bytes, offset + 16)
    if (packageLength === null || tocOffset === null || tocLength === null) continue
    if (packageLength === 0 || packageLength > offset) continue
    if (tocLength === 0 || tocOffset > packageLength || tocLength > packageLength - tocOffset) continue
    return true
  }
  return false
}

function hasCliHeader(bytes: Uint8Array): boolean {
  const peOffset = readUInt32(bytes, 0x3c)
  if (peOffset === null || peOffset + 24 > bytes.length || readAscii(bytes, peOffset, 4) !== 'PE\u0000\u0000') return false
  const optionalHeaderSize = readUInt16(bytes, peOffset + 20)
  if (optionalHeaderSize === null) return false
  const optionalHeader = peOffset + 24
  const optionalMagic = readUInt16(bytes, optionalHeader)
  const numberOfDirectoriesOffset = optionalMagic === 0x10b ? 92 : optionalMagic === 0x20b ? 108 : -1
  const directoriesOffset = optionalMagic === 0x10b ? 96 : optionalMagic === 0x20b ? 112 : -1
  if (numberOfDirectoriesOffset < 0 || optionalHeaderSize < directoriesOffset + (15 * 8)) return false
  const numberOfDirectories = readUInt32(bytes, optionalHeader + numberOfDirectoriesOffset)
  if (numberOfDirectories === null || numberOfDirectories <= 14) return false
  const cliHeaderRva = readUInt32(bytes, optionalHeader + directoriesOffset + (14 * 8))
  const cliHeaderSize = readUInt32(bytes, optionalHeader + directoriesOffset + (14 * 8) + 4)
  return cliHeaderRva !== null && cliHeaderRva > 0 && cliHeaderSize !== null && cliHeaderSize > 0
}

function detectFormat(bytes: Uint8Array, extension: string): {
  format: string
  targetType: TargetType
  architecture: string | null
  platform: string | null
  runtimes: string[]
  embeddedArtifacts: string[]
  containerFormat?: string
  unityIl2Cpp?: UnityIl2CppApkMembers
} {
  if (bytes.length >= 8 && readAscii(bytes, 0, 4) === 'YARB') {
    return {
      format: 'cruby-iseq',
      targetType: 'FILE',
      architecture: null,
      platform: 'cruby',
      runtimes: ['ruby'],
      embeddedArtifacts: ['ruby-source'],
    }
  }

  const pyInstaller = hasPyInstallerCookie(bytes)
  if (bytes.length >= 4 && bytes[0] === 0x7f && readAscii(bytes, 1, 3) === 'ELF') {
    const elfClass = bytes[4] === 2 ? '64-bit' : bytes[4] === 1 ? '32-bit' : null
    const machine = bytes.length >= 20
      ? bytes[18] | (bytes[19] << 8)
      : 0
    const architecture = machine === 0x3e
      ? 'x86_64'
      : machine === 0xb7
        ? 'aarch64'
        : machine === 0x28
          ? 'arm'
          : machine === 0x03
            ? 'x86'
            : elfClass
    return {
      format: 'elf',
      targetType: 'FILE',
      architecture,
      platform: 'unix-like',
      runtimes: [...(extension === 'so' ? ['native-library'] : ['native']), ...(pyInstaller ? ['python'] : [])],
      embeddedArtifacts: pyInstaller ? ['python-bytecode'] : [],
      ...(pyInstaller ? { containerFormat: 'pyinstaller' } : {}),
    }
  }

  if (bytes.length >= 8 && readAscii(bytes,0,4) === '\u0000asm' && bytes[4] === 1 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0) {
    return { format: 'wasm', targetType: 'FILE', architecture: 'wasm32', platform: 'webassembly', runtimes: ['wasm'], embeddedArtifacts: [] }
  }

  if (bytes.length >= 8 && /^dex\n\d{3}\u0000$/.test(readAscii(bytes, 0, 8))) {
    return {
      format: 'dex',
      targetType: 'FILE',
      architecture: null,
      platform: 'android',
      runtimes: ['dalvik', 'art'],
      embeddedArtifacts: [],
    }
  }

  if (bytes.length >= 16 && (extension === 'pyc' || extension === 'pyo')
      && bytes[2] === 0x0d && bytes[3] === 0x0a) {
    return {
      format: 'python-bytecode',
      targetType: 'FILE',
      architecture: null,
      platform: 'python',
      runtimes: ['python'],
      embeddedArtifacts: ['python-source'],
    }
  }

  if (bytes.length >= 4 && bytes[0] === 0x1b && readAscii(bytes, 1, 2) === 'LJ') {
    return {
      format: 'luajit-bytecode',
      targetType: 'FILE',
      architecture: null,
      platform: 'luajit',
      runtimes: ['luajit'],
      embeddedArtifacts: ['lua-source'],
    }
  }

  if (bytes.length >= 5 && readAscii(bytes, 0, 4) === '\u001bLua'
      && bytes[4] === 0x55) {
    return {
      format: 'lua-bytecode-5.5',
      targetType: 'FILE',
      architecture: null,
      platform: 'lua',
      runtimes: ['lua'],
      embeddedArtifacts: ['lua-source'],
    }
  }

  if (bytes.length >= 5 && readAscii(bytes, 0, 4) === '\u001bLua'
      && bytes[4] === 0x50) {
    return {
      format: 'lua-bytecode-5.0',
      targetType: 'FILE',
      architecture: null,
      platform: 'lua',
      runtimes: ['lua'],
      embeddedArtifacts: ['lua-source'],
    }
  }

  if (bytes.length >= 5 && readAscii(bytes, 0, 4) === '\u001bLua'
      && [0x51, 0x52, 0x53, 0x54].includes(bytes[4])) {
    return {
      format: 'lua-bytecode',
      targetType: 'FILE',
      architecture: null,
      platform: 'lua',
      runtimes: ['lua'],
      embeddedArtifacts: ['lua-source'],
    }
  }

  // Luau chunks start with a version byte instead of Lua's ESC-Lua signature.
  // Require a bytecode-oriented extension, then validate through unluac-rs.
  if (bytes.length >= 8 && ['luac', 'luauc', 'lbc', 'luau', 'luau-bytecode'].includes(extension)
      && bytes[0] >= 3 && bytes[0] <= 14) {
    return {
      format: 'luau-bytecode',
      targetType: 'FILE',
      architecture: null,
      platform: 'luau',
      runtimes: ['luau'],
      embeddedArtifacts: ['luau-source'],
    }
  }

  if (bytes.length >= 8 && extension === 'class'
      && bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) {
    return {
      format: 'class',
      targetType: 'FILE',
      architecture: null,
      platform: 'jvm',
      runtimes: ['jvm'],
      embeddedArtifacts: [],
    }
  }

  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const managed = hasCliHeader(bytes)
    return {
      format: managed ? 'pe-dotnet' : extension === 'dll' ? 'pe-dll' : 'pe',
      targetType: 'FILE',
      architecture: null,
      platform: 'windows',
      runtimes: [...(managed ? ['dotnet'] : ['native']), ...(pyInstaller ? ['python'] : [])],
      embeddedArtifacts: pyInstaller ? ['python-bytecode'] : [],
      ...(pyInstaller ? { containerFormat: 'pyinstaller' } : {}),
    }
  }

  const magic = bytes.length >= 4
    ? ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
    : 0
  if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) {
    return {
      format: 'macho',
      targetType: 'FILE',
      architecture: magic === 0xfeedfacf || magic === 0xcffaedfe ? '64-bit' : '32-bit',
      platform: 'macos',
      runtimes: [...(pyInstaller ? ['native', 'python'] : ['native'])],
      embeddedArtifacts: pyInstaller ? ['python-bytecode'] : [],
      ...(pyInstaller ? { containerFormat: 'pyinstaller' } : {}),
    }
  }

  if (bytes.length >= 4 && readAscii(bytes, 0, 4) === 'PK\u0003\u0004') {
    const format = extension === 'apk' ? 'apk' : extension === 'jar' ? 'jar' : 'zip'
    const unityIl2Cpp = extension === 'apk' ? unityIl2CppApkMembers(bytes) : null
    return {
      format,
      targetType: 'FILE',
      architecture: null,
      platform: extension === 'apk' ? 'android' : null,
      runtimes: extension === 'apk' ? ['dalvik', 'art', ...(unityIl2Cpp ? ['unity-il2cpp'] : [])] : extension === 'jar' ? ['jvm'] : [],
      embeddedArtifacts: extension === 'apk'
        ? ['dex', 'resources', ...(unityIl2Cpp ? ['il2cpp-metadata', 'il2cpp-native-library'] : [])]
        : [],
      ...(unityIl2Cpp ? { containerFormat: 'unity-il2cpp', unityIl2Cpp } : {}),
    }
  }

  if (bytes.length >= 4 && readAscii(bytes, 0, 4) === '%PDF') {
    return {
      format: 'pdf',
      targetType: 'FILE',
      architecture: null,
      platform: null,
      runtimes: [],
      embeddedArtifacts: [],
    }
  }

  if (bytes.length >= 16 && readAscii(bytes, 0, 16) === 'SQLite format 3\u0000') {
    return {
      format: 'sqlite',
      targetType: 'FILE',
      architecture: null,
      platform: null,
      runtimes: [],
      embeddedArtifacts: [],
    }
  }

  if (extension === 'json') {
    return {
      format: 'json',
      targetType: 'FILE',
      architecture: null,
      platform: null,
      runtimes: [],
      embeddedArtifacts: [],
    }
  }

  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) {
    return {
      format: 'javascript-source',
      targetType: 'FILE',
      architecture: null,
      platform: 'javascript',
      runtimes: ['javascript'],
      embeddedArtifacts: ['deobfuscated-source', 'bundle-modules'],
    }
  }

  if (bytes.length >= 4 && [0xa1b2c3d4, 0xd4c3b2a1, 0x0a0d0d0a].includes(magic)) {
    return {
      format: 'pcap',
      targetType: 'CAPTURE',
      architecture: null,
      platform: null,
      runtimes: [],
      embeddedArtifacts: [],
    }
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return {
      format: 'source',
      targetType: 'FILE',
      architecture: null,
      platform: null,
      runtimes: [],
      embeddedArtifacts: [],
    }
  }

  return {
    format: 'unknown',
    targetType: 'UNKNOWN',
    architecture: null,
    platform: null,
    runtimes: [],
    embeddedArtifacts: [],
  }
}

function mimeTypeFor(format: string, extension: string, providedMimeType: string): string {
  if (providedMimeType && providedMimeType !== 'application/octet-stream') return providedMimeType
  if (format === 'source') return 'text/plain'
  if (format === 'javascript-source') return 'text/javascript'
  if (format === 'elf') return 'application/x-executable'
  if (format === 'wasm') return 'application/wasm'
  if (format === 'pe' || format === 'pe-dll' || format === 'pe-dotnet') return 'application/vnd.microsoft.portable-executable'
  if (format === 'apk' || format === 'jar' || format === 'zip') return 'application/zip'
  if (format === 'dex') return 'application/vnd.android.dex'
  if (format === 'class') return 'application/java-vm'
  if (format === 'python-bytecode') return 'application/x-python-bytecode'
  if (format === 'luajit-bytecode') return 'application/x-luajit-bytecode'
  if (format === 'lua-bytecode' || format === 'lua-bytecode-5.5') return 'application/x-lua-bytecode'
  if (format === 'luau-bytecode') return 'application/x-luau-bytecode'
  if (format === 'pdf') return 'application/pdf'
  if (format === 'pcap') return 'application/vnd.tcpdump.pcap'
  if (format === 'sqlite') return 'application/vnd.sqlite3'
  if (format === 'json') return 'application/json'
  return extension ? 'application/octet-stream' : 'application/octet-stream'
}

function entropyOf(bytes: Uint8Array): number | null {
  if (!bytes.length) return 0
  const counts = new Uint32Array(256)
  for (const byte of bytes) counts[byte] += 1
  let entropy = 0
  for (const count of counts) {
    if (!count) continue
    const probability = count / bytes.length
    entropy -= probability * Math.log2(probability)
  }
  return Number(entropy.toFixed(4))
}

export function profileArtifact(
  bytes: Uint8Array,
  fileName: string,
  providedMimeType = 'application/octet-stream',
  fullSizeBytes = bytes.byteLength,
): TargetProfile {
  const extension = extensionOf(fileName)
  const detected = detectFormat(bytes, extension)
  const { containerFormat, unityIl2Cpp, ...profile } = detected
  const mimeType = mimeTypeFor(detected.format, extension, providedMimeType)

  return {
    ...profile,
    mimeType,
    extension,
    entropy: entropyOf(bytes),
    metadata: {
      byteLength: fullSizeBytes,
      profileSampled: fullSizeBytes > bytes.byteLength,
      hasMagic: detected.format !== 'unknown',
      extensionHint: extension || null,
      containerFormat: containerFormat || null,
      ...(unityIl2Cpp ? {
        unityIl2CppMetadataPath: unityIl2Cpp.metadataPath,
        unityIl2CppLibraryPaths: unityIl2Cpp.libraryPaths.join('\n'),
        unityIl2CppLibraryPathsTruncated: unityIl2Cpp.libraryPathsTruncated,
      } : {}),
    },
  }
}
