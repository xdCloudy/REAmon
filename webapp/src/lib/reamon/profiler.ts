import type { TargetProfile, TargetType } from './types'

const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb',
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
} {
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
      runtimes: extension === 'so' ? ['native-library'] : ['native'],
      embeddedArtifacts: [],
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
      runtimes: managed ? ['dotnet'] : ['native'],
      embeddedArtifacts: [],
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
      runtimes: ['native'],
      embeddedArtifacts: [],
    }
  }

  if (bytes.length >= 4 && readAscii(bytes, 0, 4) === 'PK\u0003\u0004') {
    const format = extension === 'apk' ? 'apk' : extension === 'jar' ? 'jar' : 'zip'
    return {
      format,
      targetType: 'FILE',
      architecture: null,
      platform: extension === 'apk' ? 'android' : null,
      runtimes: extension === 'apk' ? ['dalvik', 'art'] : extension === 'jar' ? ['jvm'] : [],
      embeddedArtifacts: extension === 'apk' ? ['dex', 'resources'] : [],
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
  if (format === 'elf') return 'application/x-executable'
  if (format === 'wasm') return 'application/wasm'
  if (format === 'pe' || format === 'pe-dll' || format === 'pe-dotnet') return 'application/vnd.microsoft.portable-executable'
  if (format === 'apk' || format === 'jar' || format === 'zip') return 'application/zip'
  if (format === 'dex') return 'application/vnd.android.dex'
  if (format === 'class') return 'application/java-vm'
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
): TargetProfile {
  const extension = extensionOf(fileName)
  const detected = detectFormat(bytes, extension)
  const mimeType = mimeTypeFor(detected.format, extension, providedMimeType)

  return {
    ...detected,
    mimeType,
    extension,
    entropy: entropyOf(bytes),
    metadata: {
      byteLength: bytes.byteLength,
      hasMagic: detected.format !== 'unknown',
      extensionHint: extension || null,
    },
  }
}
