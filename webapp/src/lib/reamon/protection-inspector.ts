import { open } from 'node:fs/promises'
import { runBoundedProcess } from './bounded-process'
import type { ObservationAttributes, ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const MAX_HEADER_BYTES = 1024 * 1024
const MAX_SECTION_SAMPLE_BYTES = 64 * 1024
const MAX_TOTAL_SAMPLE_BYTES = 256 * 1024
const HIGH_ENTROPY_THRESHOLD = 7.2

export const protectionInspectorManifest: ToolPluginManifest = {
  id: 'reamon-protection-inspector',
  name: 'REAmon Static Protection Inspector',
  category: 'profiling',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['pe', 'elf'],
  capabilities: ['inspect_protection'],
  produces: ['ProtectionHypothesis'],
  requirements: [{ key: 'artifactPath' }, { key: 'executable', value: 'readelf' }],
}

const ELF_MAX_OUTPUT_BYTES = 1024 * 1024
const ELF_TIMEOUT_MS = 30_000

export interface ElfProtectionAssessment {
  status: 'suspected' | 'unknown'
  family: 'UPX' | null
  evidence: string[]
  architecture: string | null
  entryPoint: string | null
  loadSegments: Array<{ virtualAddress: string; memorySize: string; flags: string }>
  sectionNames: string[]
  inspectedBytes: number
  sampledBytes: 0
  outputTruncated: boolean
  scope: 'ELF headers, program headers, and section names; no execution or unpacking'
}

function readElfField(output: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return output.match(new RegExp(`^\\s*${escaped}:\\s*(.+?)\\s*$`, 'm'))?.[1] || null
}

function readHex(value: string | null): bigint | null {
  if (!value || !/^0x[\da-f]+$/i.test(value)) return null
  try { return BigInt(value) } catch { return null }
}

function protectionObservationKey(artifactId: string | undefined, key: string, taskId?: string): string {
  const artifactKey = `artifact:${artifactId || 'unknown'}`
  return taskId ? `${artifactKey}:${key}:task:${taskId}` : `${artifactKey}:${key}`
}

export function assessElfProtection(output: string, inspectedBytes: number, outputTruncated = false): ElfProtectionAssessment {
  const evidence: string[] = []
  let structuralIndicator = false
  const sectionNames = [...output.matchAll(/^\s*\[\s*\d+\]\s+([^\s]+)/gm)].map((match) => match[1])
  const family = sectionNames.some((name) => /^\.?UPX(?:0|1|2|!)$/i.test(name)) ? 'UPX' : null
  if (family) {
    structuralIndicator = true
    evidence.push('An ELF section name matches a conventional UPX marker; this is a protection hypothesis, not confirmation of UPX packing.')
  }

  const entryPoint = readElfField(output, 'Entry point address')
  const architecture = readElfField(output, 'Machine')
  const loadSegments = output.split(/\r?\n/).flatMap((line) => {
    const columns = line.trim().split(/\s+/)
    if (columns[0] !== 'LOAD' || columns.length < 8) return []
    const flags = columns.slice(6, -1).join('')
    return [{ virtualAddress: columns[2], memorySize: columns[5], flags }]
  })
  const entry = readHex(entryPoint)
  const executableSegments = loadSegments.filter((segment) => segment.flags.includes('E'))
  if (entry !== null && executableSegments.length > 0) {
    const mapped = executableSegments.some((segment) => {
      const start = readHex(segment.virtualAddress)
      const size = readHex(segment.memorySize)
      return start !== null && size !== null && entry >= start && entry - start < size
    })
    if (!mapped) {
      structuralIndicator = true
      evidence.push('The ELF entry point does not map into a declared executable LOAD segment.')
    }
  }
  if (loadSegments.some((segment) => segment.flags.includes('W') && segment.flags.includes('E'))) {
    structuralIndicator = true
    evidence.push('An ELF LOAD segment is both writable and executable; this is a structural indicator and can also occur in legitimate binaries.')
  }
  const completeHeader = output.includes('ELF Header:') && Boolean(architecture)
  if (!completeHeader) {
    evidence.push('The bounded readelf output did not contain a complete ELF header.')
  }
  if (outputTruncated) evidence.push('readelf output reached the configured byte limit; later section evidence may be missing.')
  return {
    status: structuralIndicator ? 'suspected' : 'unknown',
    family,
    evidence: evidence.length ? evidence : ['No recognized UPX marker or protection-related ELF structure was observed; protection may still be present.'],
    architecture,
    entryPoint,
    loadSegments,
    sectionNames,
    inspectedBytes,
    sampledBytes: 0,
    outputTruncated,
    scope: 'ELF headers, program headers, and section names; no execution or unpacking',
  }
}

export function elfProtectionObservation(assessment: ElfProtectionAssessment, artifactId?: string, taskId?: string) {
  return {
    kind: 'fact' as const,
    type: 'protection_assessment',
    key: protectionObservationKey(artifactId, 'protection-static-v1', taskId),
    label: assessment.family ? `Suspected ${assessment.family} protection`
      : assessment.status === 'suspected' ? 'Protection indicator observed; family unknown' : 'Protection status unknown',
    attributes: {
      assessment: assessment.status,
      family: assessment.family,
      architecture: assessment.architecture,
      entryPoint: assessment.entryPoint,
      evidence: assessment.evidence.join(' '),
      inspectedBytes: assessment.inspectedBytes,
      outputTruncated: assessment.outputTruncated,
      scope: assessment.scope,
      confirmed: false,
    } satisfies ObservationAttributes,
  }
}

export interface PeProtectionAssessment {
  status: 'suspected' | 'unknown'
  family: 'UPX' | null
  evidence: string[]
  architecture: string | null
  entryPointRva: number | null
  entryPointSection: string | null
  importDirectory: { rva: number; size: number } | null
  certificateTable: { fileOffset: number; size: number } | null
  sections: PeSectionEvidence[]
  inspectedBytes: number
  sampledBytes: number
  scope: 'PE headers plus bounded executable-section samples; no execution or unpacking'
}

export interface PeSectionEvidence {
  index: number
  name: string
  virtualAddress: number
  virtualSize: number
  rawOffset: number
  rawSize: number
  characteristics: number
  executable: boolean
  code: boolean
  sampledBytes: number
  entropyBits: number | null
  rawDataTruncated: boolean
  rawDataOverlapsHeaders: boolean
}

function readUInt16LE(bytes: Buffer, offset: number): number | null {
  return offset >= 0 && offset + 2 <= bytes.length ? bytes.readUInt16LE(offset) : null
}

function readUInt32LE(bytes: Buffer, offset: number): number | null {
  return offset >= 0 && offset + 4 <= bytes.length ? bytes.readUInt32LE(offset) : null
}

function completePeSectionTableEnd(bytes: Buffer): number | null {
  const peOffset = readUInt32LE(bytes, 0x3c)
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || peOffset === null
      || peOffset + 24 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null
  const sectionCount = readUInt16LE(bytes, peOffset + 6)
  const optionalHeaderSize = readUInt16LE(bytes, peOffset + 20)
  if (sectionCount === null || sectionCount > 96 || optionalHeaderSize === null) return null
  const tableEnd = peOffset + 24 + optionalHeaderSize + sectionCount * 40
  return tableEnd <= bytes.length ? tableEnd : null
}

function shannonEntropy(bytes: Buffer): number | null {
  if (!bytes.length) return null
  const counts = new Uint32Array(256)
  for (const value of bytes) counts[value] += 1
  let entropy = 0
  for (const count of counts) {
    if (!count) continue
    const probability = count / bytes.length
    entropy -= probability * Math.log2(probability)
  }
  return Math.round(entropy * 1000) / 1000
}

export function assessPeProtection(
  bytes: Buffer,
  sectionSamples: Map<number, Buffer> = new Map(),
  truncatedSections: Set<number> = new Set(),
  headerOverlappingSections: Set<number> = new Set(),
): PeProtectionAssessment {
  const evidence: string[] = []
  const sections: PeSectionEvidence[] = []
  let sampledBytes = 0
  let upxMarkerPresent = false
  const peOffset = readUInt32LE(bytes, 0x3c)
  if (bytes.length < 2 || bytes.toString('ascii', 0, 2) !== 'MZ'
      || peOffset === null || peOffset + 24 > bytes.length
      || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    return {
      status: 'unknown', family: null, evidence: ['A complete PE header was not available in the bounded header read.'],
      architecture: null, entryPointRva: null, entryPointSection: null,
      importDirectory: null, certificateTable: null, sections,
      inspectedBytes: bytes.length, sampledBytes,
      scope: 'PE headers plus bounded executable-section samples; no execution or unpacking',
    }
  }

  const sectionCount = readUInt16LE(bytes, peOffset + 6)
  const optionalHeaderSize = readUInt16LE(bytes, peOffset + 20)
  if (sectionCount === null || optionalHeaderSize === null || sectionCount > 96) {
    return {
      status: 'unknown', family: null, evidence: ['PE section-table dimensions were missing or outside the supported bounds.'],
      architecture: null, entryPointRva: null, entryPointSection: null,
      importDirectory: null, certificateTable: null, sections,
      inspectedBytes: bytes.length, sampledBytes,
      scope: 'PE headers plus bounded executable-section samples; no execution or unpacking',
    }
  }

  const sectionTable = peOffset + 24 + optionalHeaderSize
  const machine = readUInt16LE(bytes, peOffset + 4)
  const architecture = machine === 0x014c ? 'x86'
    : machine === 0x8664 ? 'x86_64'
      : machine === 0xaa64 ? 'ARM64'
        : machine === null ? null : `PE-machine-0x${machine.toString(16)}`
  const optionalHeader = peOffset + 24
  const optionalMagic = readUInt16LE(bytes, optionalHeader)
  const directoryOffset = optionalMagic === 0x10b ? 96 : optionalMagic === 0x20b ? 112 : null
  const directoryCountOffset = optionalMagic === 0x10b ? 92 : optionalMagic === 0x20b ? 108 : null
  const directoryCount = directoryCountOffset === null ? null : readUInt32LE(bytes, optionalHeader + directoryCountOffset)
  const entryPointRva = readUInt32LE(bytes, optionalHeader + 16)
  const readDirectory = (index: number): { rva: number; size: number } | null => {
    if (directoryOffset === null || directoryCount === null || directoryCount <= index
        || optionalHeaderSize < directoryOffset + (index + 1) * 8) return null
    const offset = optionalHeader + directoryOffset + index * 8
    const rva = readUInt32LE(bytes, offset)
    const size = readUInt32LE(bytes, offset + 4)
    return rva === null || size === null || (rva === 0 && size === 0) ? null : { rva, size }
  }
  const importDirectory = readDirectory(1)
  const certificateEntry = readDirectory(4)
  const certificateTable = certificateEntry ? { fileOffset: certificateEntry.rva, size: certificateEntry.size } : null
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTable + index * 40
    if (offset + 40 > bytes.length) {
      evidence.push('The PE section table extends beyond the bounded header read.')
      break
    }
    const name = bytes.toString('ascii', offset, offset + 8).replace(/\0.*$/, '').trim()
    const virtualSize = readUInt32LE(bytes, offset + 8) ?? 0
    const virtualAddress = readUInt32LE(bytes, offset + 12) ?? 0
    const rawSize = readUInt32LE(bytes, offset + 16) ?? 0
    const rawOffset = readUInt32LE(bytes, offset + 20) ?? 0
    const characteristics = readUInt32LE(bytes, offset + 36) ?? 0
    const executable = (characteristics & 0x20000000) !== 0
    const sectionSample = executable ? sectionSamples.get(index) : undefined
    const entropyBits = sectionSample ? shannonEntropy(sectionSample) : null
    if (sectionSample) sampledBytes += sectionSample.length
    sections.push({
      index,
      name,
      virtualAddress,
      virtualSize,
      rawOffset,
      rawSize,
      characteristics,
      executable,
      code: (characteristics & 0x00000020) !== 0,
      sampledBytes: sectionSample?.length ?? 0,
      entropyBits,
      rawDataTruncated: truncatedSections.has(index),
      rawDataOverlapsHeaders: headerOverlappingSections.has(index),
    })
    if (/^UPX(?:0|1|2|!)$/i.test(name)) {
      upxMarkerPresent = true
      evidence.push(`PE section name "${name}" matches a conventional UPX section marker.`)
    }
    if (entropyBits !== null && entropyBits >= HIGH_ENTROPY_THRESHOLD) {
      evidence.push(`Executable PE section "${name || index}" has high sampled entropy (${entropyBits} bits per byte); this can result from packing, encryption, or other data and does not identify a protection family.`)
    }
    if (truncatedSections.has(index)) {
      evidence.push(`PE section "${name || index}" declares raw bytes beyond the artifact boundary; its section data is truncated.`)
    }
    if (headerOverlappingSections.has(index)) {
      evidence.push(`PE section "${name || index}" declares raw data overlapping its headers; the section was not sampled.`)
    }
  }
  const entryPointSectionEvidence = entryPointRva === null ? undefined : sections.find((section) => {
    const mappedSize = Math.max(section.virtualSize, section.rawSize)
    return mappedSize > 0 && entryPointRva >= section.virtualAddress && entryPointRva - section.virtualAddress < mappedSize
  })
  const entryPointSection = entryPointSectionEvidence?.name ?? null
  if (entryPointRva && !entryPointSection) evidence.push('The PE entry-point RVA did not map to a declared section in the bounded section table.')
  if (entryPointRva && entryPointSectionEvidence && !entryPointSectionEvidence.executable) {
    evidence.push(`The PE entry-point RVA maps to non-executable section "${entryPointSection}".`)
  }

  return {
    status: evidence.length ? 'suspected' : 'unknown',
    family: upxMarkerPresent ? 'UPX' : null,
    evidence: evidence.length ? evidence : ['No recognized UPX section-name marker was found; other protection may still be present.'],
    architecture,
    entryPointRva,
    entryPointSection,
    importDirectory,
    certificateTable,
    sections,
    inspectedBytes: bytes.length,
    sampledBytes,
    scope: 'PE headers plus bounded executable-section samples; no execution or unpacking',
  }
}

export function peSectionObservations(sections: PeSectionEvidence[], artifactId?: string, taskId?: string) {
  return sections.map((section) => ({
    kind: 'fact' as const,
    type: 'pe_section_region',
    key: protectionObservationKey(artifactId, `pe-section:${section.index}`, taskId),
    label: section.name || `PE section ${section.index}`,
    attributes: {
      index: section.index,
      name: section.name,
      virtualAddress: section.virtualAddress,
      virtualSize: section.virtualSize,
      rawOffset: section.rawOffset,
      rawSize: section.rawSize,
      characteristics: section.characteristics,
      executable: section.executable,
      code: section.code,
      sampledBytes: section.sampledBytes,
      entropyBits: section.entropyBits,
      rawDataTruncated: section.rawDataTruncated,
      rawDataOverlapsHeaders: section.rawDataOverlapsHeaders,
    },
  }))
}

export function protectionObservation(assessment: PeProtectionAssessment, artifactId?: string, taskId?: string) {
  const attributes: ObservationAttributes = {
    assessment: assessment.status,
    family: assessment.family,
    architecture: assessment.architecture,
    entryPointRva: assessment.entryPointRva,
    entryPointSection: assessment.entryPointSection,
    importDirectoryRva: assessment.importDirectory?.rva ?? null,
    importDirectorySize: assessment.importDirectory?.size ?? null,
    certificateTableOffset: assessment.certificateTable?.fileOffset ?? null,
    certificateTableSize: assessment.certificateTable?.size ?? null,
    evidence: assessment.evidence.join(' '),
    inspectedBytes: assessment.inspectedBytes,
    scope: assessment.scope,
    confirmed: false,
  }
  return {
    kind: 'fact' as const,
    type: 'protection_assessment',
    key: protectionObservationKey(artifactId, 'protection-static-v1', taskId),
    label: assessment.family ? `Suspected ${assessment.family} protection`
      : assessment.status === 'suspected' ? 'Protection indicator observed; family unknown' : 'Protection status unknown',
    attributes,
  }
}

export async function executeProtectionInspection(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: protectionInspectorManifest.id,
    capabilities: protectionInspectorManifest.capabilities,
    produced: protectionInspectorManifest.produces,
  }
  if (!input.artifactPath) return { status: 'failed', ...base, data: {}, error: 'Controlled artifact path is required' }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(input.artifactPath, 'r')
    if (input.targetProfile.format === 'elf') {
      const artifactStats = await handle.stat()
      const result = await runBoundedProcess({
        executable: 'readelf',
        args: ['-W', '-h', '-l', '-S', '--', input.artifactPath],
        signal: input.signal,
        maxOutputBytes: ELF_MAX_OUTPUT_BYTES,
        timeoutMs: ELF_TIMEOUT_MS,
        timeoutError: (value) => `readelf protection inspection timed out after ${Math.ceil(value / 1000)} seconds`,
      })
      const assessment = assessElfProtection(result.stdout, artifactStats.size, result.truncated)
      return {
        status: 'completed', ...base,
        data: { assessment, observations: [elfProtectionObservation(assessment, input.artifactId, input.taskId)], stderr: result.stderr.slice(0, 4000) },
      }
    }
    const header = Buffer.alloc(MAX_HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const headerBytes = header.subarray(0, bytesRead)
    const initial = assessPeProtection(headerBytes)
    const stat = await handle.stat()
    const sectionSamples = new Map<number, Buffer>()
    const truncatedSections = new Set<number>()
    const headerOverlappingSections = new Set<number>()
    let sampleBudget = MAX_TOTAL_SAMPLE_BYTES
    const sectionTableEnd = completePeSectionTableEnd(headerBytes)
    if (stat.isFile() && sectionTableEnd !== null) {
      for (const section of initial.sections) {
        if (!section.rawSize) continue
        if (section.rawOffset < sectionTableEnd) {
          headerOverlappingSections.add(section.index)
          continue
        }
        if (section.rawOffset >= stat.size) {
          truncatedSections.add(section.index)
          continue
        }
        const availableBytes = Math.min(section.rawSize, stat.size - section.rawOffset)
        if (availableBytes < section.rawSize) truncatedSections.add(section.index)
        if (!section.executable || !sampleBudget) continue
        const sampleSize = Math.min(availableBytes, MAX_SECTION_SAMPLE_BYTES, sampleBudget)
        if (sampleSize <= 0) continue
        const sample = Buffer.alloc(sampleSize)
        const { bytesRead: sampled } = await handle.read(sample, 0, sampleSize, section.rawOffset)
        if (sampled > 0) {
          sectionSamples.set(section.index, sample.subarray(0, sampled))
          sampleBudget -= sampled
        }
        if (sampled < sampleSize) truncatedSections.add(section.index)
      }
    }
    const assessment = assessPeProtection(headerBytes, sectionSamples, truncatedSections, headerOverlappingSections)
    const observations = [
      protectionObservation(assessment, input.artifactId, input.taskId),
      ...peSectionObservations(assessment.sections, input.artifactId, input.taskId),
    ]
    return { status: 'completed', ...base, data: { assessment, observations } }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export const protectionInspectorPlugin: ToolPlugin = {
  manifest: protectionInspectorManifest,
  analyze: executeProtectionInspection,
}
