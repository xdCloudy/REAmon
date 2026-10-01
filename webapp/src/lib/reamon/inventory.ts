import type { TargetProfile, WorkspaceProfile } from './types'

export interface WorkspaceManifestEntry {
  relativePath: string
  size: number
  lastModified: number | null
}

export interface InventoryArtifact {
  relativePath: string
  sizeBytes: number
  profile: TargetProfile
}

const CONFIG_EXTENSIONS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'properties', 'env'])
const INTERESTING_FORMATS = new Set(['pe', 'pe-dll', 'elf', 'macho', 'apk', 'jar', 'sqlite', 'pcap'])
const INTERESTING_EXTENSIONS = new Set(['exe', 'dll', 'sys', 'so', 'dylib', 'app', 'bin', 'img', 'iso', 'wasm'])

function extensionOf(relativePath: string): string {
  const name = relativePath.split('/').pop() || ''
  const match = name.toLowerCase().match(/\.([a-z0-9]{1,16})$/)
  return match?.[1] || ''
}

export function isLogicalTargetCandidate(artifact: InventoryArtifact): boolean {
  return INTERESTING_FORMATS.has(artifact.profile.format) || INTERESTING_EXTENSIONS.has(extensionOf(artifact.relativePath))
}

export function buildWorkspaceProfile(artifacts: InventoryArtifact[]): WorkspaceProfile {
  const directories = new Set<string>()
  const platforms = new Set<string>()
  const runtimes = new Set<string>()
  const entrypoints: string[] = []
  let totalBytes = 0
  let sourceFileCount = 0
  let configurationFileCount = 0
  let interestingArtifacts = 0

  for (const artifact of artifacts) {
    totalBytes += artifact.sizeBytes
    const segments = artifact.relativePath.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'))
    }
    if (artifact.profile.platform) platforms.add(artifact.profile.platform)
    for (const runtime of artifact.profile.runtimes) runtimes.add(runtime)
    if (artifact.profile.format === 'source') sourceFileCount += 1
    if (CONFIG_EXTENSIONS.has(extensionOf(artifact.relativePath))) configurationFileCount += 1
    if (isLogicalTargetCandidate(artifact)) {
      interestingArtifacts += 1
      if (entrypoints.length < 20 && ['pe', 'elf', 'macho', 'apk'].includes(artifact.profile.format)) {
        entrypoints.push(artifact.relativePath)
      }
    }
  }

  return {
    targetType: 'DIRECTORY',
    format: 'directory',
    mimeType: 'inode/directory',
    extension: '',
    architecture: null,
    platform: platforms.size === 1 ? [...platforms][0] : null,
    runtimes: [...runtimes].sort(),
    embeddedArtifacts: [],
    entropy: null,
    metadata: {
      byteLength: totalBytes,
      hasMagic: false,
      extensionHint: null,
    },
    fileCount: artifacts.length,
    directoryCount: directories.size,
    totalBytes,
    detectedPlatforms: [...platforms].sort(),
    detectedRuntimes: [...runtimes].sort(),
    sourceFileCount,
    configurationFileCount,
    interestingArtifacts,
    potentialEntrypoints: entrypoints,
  }
}
