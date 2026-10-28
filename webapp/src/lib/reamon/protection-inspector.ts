import { open } from 'node:fs/promises'
import type { ObservationAttributes, ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const MAX_HEADER_BYTES = 1024 * 1024
const MAX_SECTION_SAMPLE_BYTES = 64 * 1024
const MAX_TOTAL_SAMPLE_BYTES = 256 * 1024
const HIGH_ENTROPY_THRESHOLD = 7.2

export const protectionInspectorManifest: ToolPluginManifest = {
  id: 'reamon-protection-inspector',
  name: 'REAmon Static Protection Inspector',
  category: 'profiling',
  integration: 'native',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['pe'],
  capabilities: ['inspect_protection'],
  produces: ['ProtectionHypothesis'],
  requirements: [{ key: 'artifactPath' }],
}

export interface PeProtectionAssessment {
  status: 'suspected' | 'unknown'
  family: 'UPX' | null
  evidence: string[]
  architecture: string | null
  entryPointRva: number | null
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
}

function readUInt16LE(bytes: Buffer, offset: number): number | null {
  return offset >= 0 && offset + 2 <= bytes.length ? bytes.readUInt16LE(offset) : null
}

function readUInt32LE(bytes: Buffer, offset: number): number | null {
  return offset >= 0 && offset + 4 <= bytes.length ? bytes.readUInt32LE(offset) : null
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

export function assessPeProtection(bytes: Buffer, sectionSamples: Map<number, Buffer> = new Map()): PeProtectionAssessment {
  const evidence: string[] = []
  const sections: PeSectionEvidence[] = []
  let sampledBytes = 0
  const peOffset = readUInt32LE(bytes, 0x3c)
  if (bytes.length < 2 || bytes.toString('ascii', 0, 2) !== 'MZ'
      || peOffset === null || peOffset + 24 > bytes.length
      || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    return {
      status: 'unknown', family: null, evidence: ['A complete PE header was not available in the bounded header read.'],
      architecture: null, entryPointRva: null, sections,
      inspectedBytes: bytes.length, sampledBytes,
      scope: 'PE headers plus bounded executable-section samples; no execution or unpacking',
    }
  }

  const sectionCount = readUInt16LE(bytes, peOffset + 6)
  const optionalHeaderSize = readUInt16LE(bytes, peOffset + 20)
  if (sectionCount === null || optionalHeaderSize === null || sectionCount > 96) {
    return {
      status: 'unknown', family: null, evidence: ['PE section-table dimensions were missing or outside the supported bounds.'],
      architecture: null, entryPointRva: null, sections,
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
  const entryPointRva = readUInt32LE(bytes, peOffset + 24 + 16)
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
    })
    if (/^UPX(?:0|1|2|!)$/i.test(name)) evidence.push(`PE section name "${name}" matches a conventional UPX section marker.`)
    if (entropyBits !== null && entropyBits >= HIGH_ENTROPY_THRESHOLD) {
      evidence.push(`Executable PE section "${name || index}" has high sampled entropy (${entropyBits} bits per byte); this can result from packing, encryption, or other data and does not identify a protection family.`)
    }
  }

  return {
    status: evidence.length ? 'suspected' : 'unknown',
    family: evidence.length ? 'UPX' : null,
    evidence: evidence.length ? evidence : ['No recognized UPX section-name marker was found; other protection may still be present.'],
    architecture,
    entryPointRva,
    sections,
    inspectedBytes: bytes.length,
    sampledBytes,
    scope: 'PE headers plus bounded executable-section samples; no execution or unpacking',
  }
}

export function peSectionObservations(sections: PeSectionEvidence[], artifactId?: string) {
  return sections.map((section) => ({
    kind: 'fact' as const,
    type: 'pe_section_region',
    key: `artifact:${artifactId || 'unknown'}:pe-section:${section.index}`,
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
    },
  }))
}

export function protectionObservation(assessment: PeProtectionAssessment, artifactId?: string) {
  const attributes: ObservationAttributes = {
    assessment: assessment.status,
    family: assessment.family,
    evidence: assessment.evidence.join(' '),
    inspectedBytes: assessment.inspectedBytes,
    scope: assessment.scope,
    confirmed: false,
  }
  return {
    kind: 'fact' as const,
    type: 'protection_assessment',
    key: `artifact:${artifactId || 'unknown'}:protection-static-v1`,
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
    const header = Buffer.alloc(MAX_HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const headerBytes = header.subarray(0, bytesRead)
    const initial = assessPeProtection(headerBytes)
    const stat = await handle.stat()
    const sectionSamples = new Map<number, Buffer>()
    let sampleBudget = MAX_TOTAL_SAMPLE_BYTES
    if (stat.isFile()) {
      for (const section of initial.sections) {
        if (!section.executable || !section.rawSize || !sampleBudget || section.rawOffset >= stat.size) continue
        const availableBytes = Math.min(section.rawSize, stat.size - section.rawOffset)
        const sampleSize = Math.min(availableBytes, MAX_SECTION_SAMPLE_BYTES, sampleBudget)
        if (sampleSize <= 0) continue
        const sample = Buffer.alloc(sampleSize)
        const { bytesRead: sampled } = await handle.read(sample, 0, sampleSize, section.rawOffset)
        if (sampled > 0) {
          sectionSamples.set(section.index, sample.subarray(0, sampled))
          sampleBudget -= sampled
        }
      }
    }
    const assessment = assessPeProtection(headerBytes, sectionSamples)
    const observations = [
      protectionObservation(assessment, input.artifactId),
      ...peSectionObservations(assessment.sections, input.artifactId),
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
