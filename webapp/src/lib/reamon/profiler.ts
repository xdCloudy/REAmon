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
    return {
      format: extension === 'dll' ? 'pe-dll' : 'pe',
      targetType: 'FILE',
      architecture: null,
      platform: 'windows',
      runtimes: ['native'],
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
  if (format === 'pe' || format === 'pe-dll') return 'application/vnd.microsoft.portable-executable'
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
