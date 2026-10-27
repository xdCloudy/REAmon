import { open } from 'node:fs/promises'
import type { ObservationAttributes, ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const MAX_HEADER_BYTES = 1024 * 1024

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
  scope: 'PE section table only; no execution, unpacking, or payload inspection'
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
}

function readUInt16LE(bytes: Buffer, offset: number): number | null {
  return offset >= 0 && offset + 2 <= bytes.length ? bytes.readUInt16LE(offset) : null
}

function readUInt32LE(bytes: Buffer, offset: number): number | null {
  return offset >= 0 && offset + 4 <= bytes.length ? bytes.readUInt32LE(offset) : null
}

export function assessPeProtection(bytes: Buffer): PeProtectionAssessment {
  const evidence: string[] = []
  const sections: PeSectionEvidence[] = []
  const peOffset = readUInt32LE(bytes, 0x3c)
  if (bytes.length < 2 || bytes.toString('ascii', 0, 2) !== 'MZ'
      || peOffset === null || peOffset + 24 > bytes.length
      || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    return {
      status: 'unknown', family: null, evidence: ['A complete PE header was not available in the bounded header read.'],
      architecture: null, entryPointRva: null, sections,
      inspectedBytes: bytes.length, scope: 'PE section table only; no execution, unpacking, or payload inspection',
    }
  }

  const sectionCount = readUInt16LE(bytes, peOffset + 6)
  const optionalHeaderSize = readUInt16LE(bytes, peOffset + 20)
  if (sectionCount === null || optionalHeaderSize === null || sectionCount > 96) {
    return {
      status: 'unknown', family: null, evidence: ['PE section-table dimensions were missing or outside the supported bounds.'],
      architecture: null, entryPointRva: null, sections,
      inspectedBytes: bytes.length, scope: 'PE section table only; no execution, unpacking, or payload inspection',
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
    sections.push({
      index,
      name,
      virtualAddress,
      virtualSize,
      rawOffset,
      rawSize,
      characteristics,
      executable: (characteristics & 0x20000000) !== 0,
      code: (characteristics & 0x00000020) !== 0,
    })
    if (/^UPX(?:0|1|2|!)$/i.test(name)) evidence.push(`PE section name "${name}" matches a conventional UPX section marker.`)
  }

  return {
    status: evidence.length ? 'suspected' : 'unknown',
    family: evidence.length ? 'UPX' : null,
    evidence: evidence.length ? evidence : ['No recognized UPX section-name marker was found; other protection may still be present.'],
    architecture,
    entryPointRva,
    sections,
    inspectedBytes: bytes.length,
    scope: 'PE section table only; no execution, unpacking, or payload inspection',
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
    label: assessment.family ? `Suspected ${assessment.family} protection` : 'Protection status unknown',
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
    const assessment = assessPeProtection(header.subarray(0, bytesRead))
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
