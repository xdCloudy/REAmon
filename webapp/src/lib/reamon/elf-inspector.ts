import { runBoundedProcess } from './bounded-process'
import type { ObservationAttributes, ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export const elfInspectorManifest: ToolPluginManifest = {
  id: 'reamon-elf-inspector',
  name: 'REAmon ELF Inspector',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf'],
  capabilities: ['inspect_binary_header'],
  produces: ['BinaryHeader'],
  requirements: [
    { key: 'executable', value: 'readelf' },
    { key: 'artifactPath' },
  ],
}

export interface ElfHeader {
  class: string | null
  data: string | null
  osAbi: string | null
  abiVersion: number | null
  type: string | null
  machine: string | null
  entryPoint: string | null
  programHeaderCount: number | null
  sectionHeaderCount: number | null
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function optionNumber(options: Record<string, unknown> | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = options?.[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'ELF provider failed'
}

function field(output: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`^\\s*${escaped}:\\s*(.+?)\\s*$`, 'm'))
  return match?.[1] || null
}

function decimal(value: string | null): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseReadelfHeader(output: string): ElfHeader | null {
  if (!/^ELF Header:/m.test(output)) return null
  return {
    class: field(output, 'Class'),
    data: field(output, 'Data'),
    osAbi: field(output, 'OS/ABI'),
    abiVersion: decimal(field(output, 'ABI Version')),
    type: field(output, 'Type')?.split(' (', 1)[0] || null,
    machine: field(output, 'Machine'),
    entryPoint: field(output, 'Entry point address'),
    programHeaderCount: decimal(field(output, 'Number of program headers')),
    sectionHeaderCount: decimal(field(output, 'Number of section headers')),
  }
}

function observationAttributes(header: ElfHeader): ObservationAttributes {
  return {
    format: 'elf',
    class: header.class,
    data: header.data,
    osAbi: header.osAbi,
    abiVersion: header.abiVersion,
    type: header.type,
    machine: header.machine,
    entryPoint: header.entryPoint,
    programHeaderCount: header.programHeaderCount,
    sectionHeaderCount: header.sectionHeaderCount,
  }
}

export async function executeElfInspection(input: ToolExecutionInput): Promise<ToolResult> {
  const baseResult = {
    toolId: elfInspectorManifest.id,
    capabilities: elfInspectorManifest.capabilities,
    produced: elfInspectorManifest.produces,
  }
  if (!input.artifactPath) {
    return { status: 'failed', ...baseResult, data: {}, error: 'Controlled artifact path is required' }
  }

  const maxOutputBytes = optionNumber(input.options, 'maxOutputBytes', boundedEnvNumber('REAMON_MAX_PROCESS_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES, 4 * 1024, MAX_OUTPUT_BYTES), 4 * 1024, MAX_OUTPUT_BYTES)
  const timeoutMs = boundedEnvNumber('REAMON_PROCESS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS)

  try {
    const result = await runBoundedProcess({
      executable: 'readelf',
      args: ['-h', '--', input.artifactPath],
      signal: input.signal,
      maxOutputBytes,
      timeoutMs,
      timeoutError: (value) => `readelf provider timed out after ${Math.ceil(value / 1000)} seconds`,
    })
    const header = parseReadelfHeader(result.stdout)
    if (!header?.class || !header.machine) {
      return { status: 'failed', ...baseResult, data: {}, error: 'readelf returned an incomplete ELF header' }
    }
    const attributes = observationAttributes(header)
    return {
      status: 'completed',
      ...baseResult,
      data: {
        header,
        observations: [{
          kind: 'entity',
          type: 'elf_header',
          key: `artifact:${input.artifactId || 'unknown'}:elf-header`,
          label: [header.class, header.machine, header.type].filter(Boolean).join(' '),
          attributes,
        }],
        truncated: result.truncated,
        stderr: result.stderr.slice(0, 4000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...baseResult, data: {}, error: boundedError(error) }
  }
}

export const elfInspectorPlugin: ToolPlugin = {
  manifest: elfInspectorManifest,
  analyze: executeElfInspection,
}
