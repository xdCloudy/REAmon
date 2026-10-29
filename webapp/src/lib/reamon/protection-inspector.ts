import { open } from 'node:fs/promises'
import { runBoundedProcess } from './bounded-process'
import type { ObservationAttributes, ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const MAX_HEADER_BYTES = 1024 * 1024
const MAX_SECTION_SAMPLE_BYTES = 64 * 1024
const MAX_TOTAL_SAMPLE_BYTES = 256 * 1024
const MAX_PE_IMPORT_BYTES = 64 * 1024
const MAX_PE_IMPORT_LIBRARIES = 32
const MAX_PE_IMPORTS_PER_LIBRARY = 64
const MAX_PE_IMPORTS_TOTAL = 256
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
  indicatorStatus: 'detected' | 'suspected' | 'unknown'
  family: 'UPX' | null
  evidence: string[]
  architecture: string | null
  entryPoint: string | null
  loadSegments: ElfLoadSegmentEvidence[]
  sectionNames: string[]
  sections: ElfSectionEvidence[]
  inspectedBytes: number
  sampledBytes: number
  outputTruncated: boolean
  scope: 'ELF headers, program headers, section metadata, and bounded executable-region samples; no execution or unpacking'
}

export interface ElfLoadSegmentEvidence {
  index: number
  fileOffset: number
  fileSize: number
  virtualAddress: string
  memorySize: string
  flags: string
  sampledBytes: number
  entropyBits: number | null
  upxSignatureOffsets: number[]
  rawDataTruncated: boolean
}

export interface ElfSectionEvidence {
  index: number
  name: string
  type: string
  fileOffset: number
  fileSize: number
  executable: boolean
  sampledBytes: number
  entropyBits: number | null
  rawDataTruncated: boolean
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

function parseElfSectionRows(output: string): Array<{ index: number; name: string; type: string; fileOffset: number; fileSize: number; executable: boolean }> {
  return [...output.matchAll(/^\s*\[\s*(\d+)\]\s+(\S+)\s+(\S+)\s+([\da-f]+)\s+([\da-f]+)\s+([\da-f]+)\s+\S+\s+(\S*)/gim)]
    .flatMap((match) => {
      const index = Number(match[1])
      const fileOffset = Number.parseInt(match[5], 16)
      const fileSize = Number.parseInt(match[6], 16)
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(fileOffset) || !Number.isSafeInteger(fileSize)) return []
      return [{ index, name: match[2], type: match[3], fileOffset, fileSize, executable: match[7].includes('X') }]
    })
}

export function assessElfProtection(
  output: string,
  inspectedBytes: number,
  outputTruncated = false,
  sectionSamples: Map<number, Buffer> = new Map(),
  truncatedSections: Set<number> = new Set(),
  segmentSamples: Map<number, Buffer> = new Map(),
  truncatedSegments: Set<number> = new Set(),
): ElfProtectionAssessment {
  const evidence: string[] = []
  let structuralIndicator = false
  const sectionNames = [...output.matchAll(/^\s*\[\s*\d+\]\s+([^\s]+)/gm)].map((match) => match[1])
  const sections = parseElfSectionRows(output).map((section): ElfSectionEvidence => {
    const sample = sectionSamples.get(section.index)
    const entropyBits = sample ? shannonEntropy(sample) : null
    return {
      ...section,
      sampledBytes: sample?.length ?? 0,
      entropyBits,
      rawDataTruncated: truncatedSections.has(section.index),
    }
  })
  const sectionFamily = sectionNames.some((name) => /^\.?UPX(?:0|1|2|!)$/i.test(name)) ? 'UPX' : null
  let markerObserved = sectionFamily !== null
  let family: 'UPX' | null = sectionFamily
  if (sectionFamily) {
    structuralIndicator = true
    evidence.push('An ELF section name matches a conventional UPX marker; this is a protection hypothesis, not confirmation of UPX packing.')
  }

  const entryPoint = readElfField(output, 'Entry point address')
  const architecture = readElfField(output, 'Machine')
  const rawLoadSegments = output.split(/\r?\n/).flatMap((line) => {
    const columns = line.trim().split(/\s+/)
    if (columns[0] !== 'LOAD' || columns.length < 8) return []
    const fileOffset = readHex(columns[1])
    const fileSize = readHex(columns[4])
    if (fileOffset === null || fileSize === null || fileOffset > BigInt(Number.MAX_SAFE_INTEGER) || fileSize > BigInt(Number.MAX_SAFE_INTEGER)) return []
    const flags = columns.slice(6, -1).join('')
    return [{ index: 0, fileOffset: Number(fileOffset), fileSize: Number(fileSize), virtualAddress: columns[2], memorySize: columns[5], flags }]
  })
  const loadSegments = rawLoadSegments.map((segment, index): ElfLoadSegmentEvidence => {
    const sample = segmentSamples.get(index)
    const upxSignatureOffsets: number[] = []
    if (sample) {
      const marker = Buffer.from('UPX!')
      let markerIndex = sample.indexOf(marker)
      while (markerIndex >= 0) {
        upxSignatureOffsets.push(segment.fileOffset + markerIndex)
        markerIndex = sample.indexOf(marker, markerIndex + marker.length)
      }
    }
    return {
      ...segment,
      sampledBytes: sample?.length ?? 0,
      entropyBits: sample ? shannonEntropy(sample) : null,
      upxSignatureOffsets,
      rawDataTruncated: truncatedSegments.has(index),
    }
  })
  const sampledBytes = sections.reduce((total, section) => total + section.sampledBytes, 0)
    + loadSegments.reduce((total, segment) => total + segment.sampledBytes, 0)
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
  for (const segment of loadSegments) {
    if (segment.upxSignatureOffsets.length) {
      markerObserved = true
      structuralIndicator = true
      family = 'UPX'
      evidence.push(`UPX! marker observed at file offset ${segment.upxSignatureOffsets.map((offset) => `0x${offset.toString(16)}`).join(', ')} in an ELF LOAD segment; this signature is a hypothesis, not confirmation of UPX packing.`)
    }
    if (segment.flags.includes('E') && segment.entropyBits !== null && segment.entropyBits >= HIGH_ENTROPY_THRESHOLD) {
      structuralIndicator = true
      evidence.push(`Executable ELF LOAD segment at file offset 0x${segment.fileOffset.toString(16)} has high sampled entropy (${segment.entropyBits} bits per byte); this can result from packing, encryption, or other data and does not identify a protection family.`)
    }
    if (segment.rawDataTruncated) {
      evidence.push(`ELF LOAD segment at file offset 0x${segment.fileOffset.toString(16)} declares raw bytes beyond the artifact boundary; its data is truncated.`)
    }
  }
  for (const section of sections) {
    if (section.executable && section.entropyBits !== null && section.entropyBits >= HIGH_ENTROPY_THRESHOLD) {
      structuralIndicator = true
      evidence.push(`Executable ELF section "${section.name || section.index}" has high sampled entropy (${section.entropyBits} bits per byte); this can result from packing, encryption, or other data and does not identify a protection family.`)
    }
    if (section.rawDataTruncated) {
      evidence.push(`ELF section "${section.name || section.index}" declares raw bytes beyond the artifact boundary; its section data is truncated.`)
    }
  }
  const completeHeader = output.includes('ELF Header:') && Boolean(architecture)
  if (!completeHeader) {
    evidence.push('The bounded readelf output did not contain a complete ELF header.')
  }
  if (outputTruncated) evidence.push('readelf output reached the configured byte limit; later section evidence may be missing.')
  return {
    status: structuralIndicator ? 'suspected' : 'unknown',
    indicatorStatus: markerObserved ? 'detected' : structuralIndicator ? 'suspected' : 'unknown',
    family,
    evidence: evidence.length ? evidence : ['No recognized UPX marker or protection-related ELF structure was observed; protection may still be present.'],
    architecture,
    entryPoint,
    loadSegments,
    sectionNames,
    sections,
    inspectedBytes,
    sampledBytes,
    outputTruncated,
    scope: 'ELF headers, program headers, section metadata, and bounded executable-region samples; no execution or unpacking',
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
      indicatorStatus: assessment.indicatorStatus,
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

export function elfSectionObservations(sections: ElfSectionEvidence[], artifactId?: string, taskId?: string) {
  return sections.map((section) => ({
    kind: 'fact' as const,
    type: 'elf_section_region',
    key: protectionObservationKey(artifactId, `elf-section:${section.index}`, taskId),
    label: section.name || `ELF section ${section.index}`,
    attributes: {
      index: section.index,
      name: section.name,
      sectionType: section.type,
      fileOffset: section.fileOffset,
      fileSize: section.fileSize,
      executable: section.executable,
      sampledBytes: section.sampledBytes,
      entropyBits: section.entropyBits,
      rawDataTruncated: section.rawDataTruncated,
    } satisfies ObservationAttributes,
  }))
}

export function elfLoadSegmentObservations(segments: ElfLoadSegmentEvidence[], artifactId?: string, taskId?: string) {
  return segments.map((segment) => ({
    kind: 'fact' as const,
    type: 'elf_load_segment',
    key: protectionObservationKey(artifactId, `elf-load-segment:${segment.index}`, taskId),
    label: `ELF LOAD segment ${segment.index}`,
    attributes: {
      index: segment.index,
      fileOffset: segment.fileOffset,
      fileSize: segment.fileSize,
      virtualAddress: segment.virtualAddress,
      memorySize: segment.memorySize,
      flags: segment.flags,
      sampledBytes: segment.sampledBytes,
      entropyBits: segment.entropyBits,
      upxSignatureOffsets: segment.upxSignatureOffsets.map((offset) => `0x${offset.toString(16)}`).join(', '),
      rawDataTruncated: segment.rawDataTruncated,
    } satisfies ObservationAttributes,
  }))
}

export interface PeProtectionAssessment {
  status: 'suspected' | 'unknown'
  indicatorStatus: 'detected' | 'suspected' | 'unknown'
  family: 'UPX' | null
  evidence: string[]
  architecture: string | null
  entryPointRva: number | null
  entryPointSection: string | null
  importDirectory: { rva: number; size: number } | null
  imports: PeImportLibraryEvidence[]
  importTableStatus: 'parsed' | 'truncated' | 'unavailable' | 'not_present'
  certificateTable: { fileOffset: number; size: number } | null
  sections: PeSectionEvidence[]
  inspectedBytes: number
  sampledBytes: number
  scope: 'PE headers plus bounded executable-section samples; no execution or unpacking'
}

export interface PeImportLibraryEvidence {
  library: string
  symbols: string[]
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
  imports: PeImportLibraryEvidence[] = [],
  importTableStatus: PeProtectionAssessment['importTableStatus'] = 'not_present',
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
      status: 'unknown', indicatorStatus: 'unknown', family: null, evidence: ['A complete PE header was not available in the bounded header read.'],
      architecture: null, entryPointRva: null, entryPointSection: null,
      importDirectory: null, certificateTable: null, sections,
      imports, importTableStatus,
      inspectedBytes: bytes.length, sampledBytes,
      scope: 'PE headers plus bounded executable-section samples; no execution or unpacking',
    }
  }

  const sectionCount = readUInt16LE(bytes, peOffset + 6)
  const optionalHeaderSize = readUInt16LE(bytes, peOffset + 20)
  if (sectionCount === null || optionalHeaderSize === null || sectionCount > 96) {
    return {
      status: 'unknown', indicatorStatus: 'unknown', family: null, evidence: ['PE section-table dimensions were missing or outside the supported bounds.'],
      architecture: null, entryPointRva: null, entryPointSection: null,
      importDirectory: null, certificateTable: null, sections,
      imports, importTableStatus,
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
    indicatorStatus: upxMarkerPresent ? 'detected' : evidence.length ? 'suspected' : 'unknown',
    family: upxMarkerPresent ? 'UPX' : null,
    evidence: evidence.length ? evidence : ['No recognized UPX section-name marker was found; other protection may still be present.'],
    architecture,
    entryPointRva,
    entryPointSection,
    importDirectory,
    imports,
    importTableStatus,
    certificateTable,
    sections,
    inspectedBytes: bytes.length,
    sampledBytes,
    scope: 'PE headers plus bounded executable-section samples; no execution or unpacking',
  }
}

async function readPeImportEvidence(
  handle: Awaited<ReturnType<typeof open>>,
  headerBytes: Buffer,
  artifactSize: number,
  assessment: PeProtectionAssessment,
): Promise<{ imports: PeImportLibraryEvidence[]; status: PeProtectionAssessment['importTableStatus'] }> {
  const directory = assessment.importDirectory
  if (!directory) return { imports: [], status: 'not_present' }
  if (!directory.rva && !directory.size) return { imports: [], status: 'not_present' }
  if (!directory.rva || directory.size < 20) return { imports: [], status: 'unavailable' }
  const sections = assessment.sections
  let readBytes = 0
  let capped = false
  const readAt = async (offset: number, length: number): Promise<Buffer | null> => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= artifactSize || length <= 0) return null
    const available = Math.min(length, artifactSize - offset, MAX_PE_IMPORT_BYTES - readBytes)
    if (available <= 0) { capped = true; return null }
    if (MAX_PE_IMPORT_BYTES - readBytes < length) capped = true
    const buffer = Buffer.alloc(available)
    const { bytesRead } = await handle.read(buffer, 0, available, offset)
    readBytes += bytesRead
    return bytesRead ? buffer.subarray(0, bytesRead) : null
  }
  const rvaToOffset = (rva: number): number | null => {
    const section = sections.find((candidate) => {
      const span = Math.max(candidate.virtualSize, candidate.rawSize)
      return span > 0 && rva >= candidate.virtualAddress && rva - candidate.virtualAddress < span
    })
    if (!section) return rva < headerBytes.length ? rva : null
    const delta = rva - section.virtualAddress
    if (delta >= section.rawSize) return null
    const offset = section.rawOffset + delta
    return Number.isSafeInteger(offset) && offset < artifactSize ? offset : null
  }
  const readRva = async (rva: number, length: number): Promise<Buffer | null> => {
    const offset = rvaToOffset(rva)
    return offset === null ? null : readAt(offset, length)
  }
  const readName = async (rva: number): Promise<string | null> => {
    if (!rva) return null
    const bytes = await readRva(rva, 256)
    if (!bytes) return null
    const end = bytes.indexOf(0)
    if (end <= 0) { capped ||= bytes.length === 256; return null }
    return bytes.toString('ascii', 0, end).replace(/[^\x20-\x7e]/g, '?')
  }
  const descriptorOffset = rvaToOffset(directory.rva)
  if (descriptorOffset === null) return { imports: [], status: 'unavailable' }
  const imports: PeImportLibraryEvidence[] = []
  const descriptorCount = Math.min(Math.floor(directory.size / 20), MAX_PE_IMPORT_LIBRARIES)
  const is64Bit = assessment.architecture === 'x86_64' || assessment.architecture === 'ARM64'
  const thunkWidth = is64Bit ? 8 : 4
  const ordinalMask = is64Bit ? (1n << 63n) : (1n << 31n)
  let descriptorsTerminated = false
  for (let descriptorIndex = 0; descriptorIndex < descriptorCount; descriptorIndex += 1) {
    const descriptor = await readAt(descriptorOffset + descriptorIndex * 20, 20)
    if (!descriptor || descriptor.length < 20) { capped = true; break }
    const originalThunk = descriptor.readUInt32LE(0)
    const nameRva = descriptor.readUInt32LE(12)
    const firstThunk = descriptor.readUInt32LE(16)
    if (originalThunk === 0 && nameRva === 0 && firstThunk === 0) { descriptorsTerminated = true; break }
    const library = await readName(nameRva)
    if (!library) { capped = true; continue }
    const thunkRva = originalThunk || firstThunk
    const symbols: string[] = []
    if (thunkRva) {
      let symbolsTerminated = false
      for (let symbolIndex = 0; symbolIndex < MAX_PE_IMPORTS_PER_LIBRARY && imports.reduce((total, item) => total + item.symbols.length, 0) + symbols.length < MAX_PE_IMPORTS_TOTAL; symbolIndex += 1) {
        const thunk = await readRva(thunkRva + symbolIndex * thunkWidth, thunkWidth)
        if (!thunk || thunk.length < thunkWidth) { capped = true; break }
        const value = is64Bit ? thunk.readBigUInt64LE(0) : BigInt(thunk.readUInt32LE(0))
        if (value === 0n) { symbolsTerminated = true; break }
        if ((value & ordinalMask) !== 0n) {
          symbols.push(`#${Number(value & 0xffffn)}`)
          continue
        }
        if (value > 0xffffffffn) { capped = true; break }
        const namePointer = Number(value)
        const hintAndName = await readRva(namePointer, 2)
        if (!hintAndName || hintAndName.length < 2) { capped = true; break }
        const symbol = await readName(namePointer + 2)
        if (!symbol) { capped = true; break }
        symbols.push(symbol)
      }
      if (!symbolsTerminated) capped = true
    }
    imports.push({ library, symbols })
  }
  if (!descriptorsTerminated || directory.size / 20 > MAX_PE_IMPORT_LIBRARIES || imports.reduce((total, item) => total + item.symbols.length, 0) >= MAX_PE_IMPORTS_TOTAL) capped = true
  return { imports, status: capped ? 'truncated' : imports.length ? 'parsed' : 'unavailable' }
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
    indicatorStatus: assessment.indicatorStatus,
    family: assessment.family,
    architecture: assessment.architecture,
    entryPointRva: assessment.entryPointRva,
    entryPointSection: assessment.entryPointSection,
    importDirectoryRva: assessment.importDirectory?.rva ?? null,
    importDirectorySize: assessment.importDirectory?.size ?? null,
    importTableStatus: assessment.importTableStatus,
    importedLibraries: assessment.imports.length,
    imports: JSON.stringify(assessment.imports),
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
      const sectionRows = parseElfSectionRows(result.stdout)
      const sectionSamples = new Map<number, Buffer>()
      const truncatedSections = new Set<number>()
      const segmentSamples = new Map<number, Buffer>()
      const truncatedSegments = new Set<number>()
      let sampleBudget = MAX_TOTAL_SAMPLE_BYTES
      const hasExecutableFileBackedSections = sectionRows.some((section) => section.executable && section.type !== 'NOBITS' && section.fileSize > 0)
      if (hasExecutableFileBackedSections) {
        for (const section of sectionRows) {
          if (!section.executable || section.type === 'NOBITS' || !section.fileSize) continue
          if (section.fileOffset >= artifactStats.size) {
            truncatedSections.add(section.index)
            continue
          }
          const availableBytes = Math.min(section.fileSize, artifactStats.size - section.fileOffset)
          if (availableBytes < section.fileSize) truncatedSections.add(section.index)
          if (!sampleBudget) continue
          const sampleSize = Math.min(availableBytes, MAX_SECTION_SAMPLE_BYTES, sampleBudget)
          if (sampleSize <= 0) continue
          const sample = Buffer.alloc(sampleSize)
          const { bytesRead: sampled } = await handle.read(sample, 0, sampleSize, section.fileOffset)
          if (sampled > 0) {
            sectionSamples.set(section.index, sample.subarray(0, sampled))
            sampleBudget -= sampled
          }
          if (sampled < sampleSize) truncatedSections.add(section.index)
        }
      } else {
        let segmentIndex = 0
        for (const line of result.stdout.split(/\r?\n/)) {
          const columns = line.trim().split(/\s+/)
          if (columns[0] !== 'LOAD' || columns.length < 8) continue
          const fileOffset = readHex(columns[1])
          const fileSize = readHex(columns[4])
          if (fileOffset === null || fileSize === null || fileOffset > BigInt(Number.MAX_SAFE_INTEGER) || fileSize > BigInt(Number.MAX_SAFE_INTEGER)) continue
          const index = segmentIndex++
          if (fileSize === 0n) continue
          const offset = Number(fileOffset)
          const size = Number(fileSize)
          if (offset >= artifactStats.size) {
            truncatedSegments.add(index)
            continue
          }
          const availableBytes = Math.min(size, artifactStats.size - offset)
          if (availableBytes < size) truncatedSegments.add(index)
          if (!sampleBudget) continue
          const sampleSize = Math.min(availableBytes, MAX_SECTION_SAMPLE_BYTES, sampleBudget)
          if (sampleSize <= 0) continue
          const sample = Buffer.alloc(sampleSize)
          const { bytesRead: sampled } = await handle.read(sample, 0, sampleSize, offset)
          if (sampled > 0) {
            segmentSamples.set(index, sample.subarray(0, sampled))
            sampleBudget -= sampled
          }
          if (sampled < sampleSize) truncatedSegments.add(index)
        }
      }
      const assessment = assessElfProtection(result.stdout, artifactStats.size, result.truncated, sectionSamples, truncatedSections, segmentSamples, truncatedSegments)
      return {
        status: 'completed', ...base,
        data: {
          assessment,
          observations: [
            elfProtectionObservation(assessment, input.artifactId, input.taskId),
            ...elfSectionObservations(assessment.sections, input.artifactId, input.taskId),
            ...elfLoadSegmentObservations(assessment.loadSegments, input.artifactId, input.taskId),
          ],
          stderr: result.stderr.slice(0, 4000),
        },
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
    const preliminary = assessPeProtection(headerBytes, sectionSamples, truncatedSections, headerOverlappingSections)
    const importEvidence = await readPeImportEvidence(handle, headerBytes, stat.size, preliminary)
    const assessment = assessPeProtection(headerBytes, sectionSamples, truncatedSections, headerOverlappingSections, importEvidence.imports, importEvidence.status)
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
