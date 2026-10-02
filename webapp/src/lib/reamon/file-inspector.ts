import { runBoundedProcess } from './bounded-process'
import type { ObservationAttributes, ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 2 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024

export const fileInspectorManifest: ToolPluginManifest = {
  id: 'reamon-file-inspector',
  name: 'REAmon File Inspector',
  category: 'profiling',
  integration: 'process',
  acceptsTargetTypes: ['FILE', 'CAPTURE', 'UNKNOWN'],
  acceptsFormats: ['*'],
  capabilities: ['extract_metadata'],
  produces: ['FileIdentification'],
  requirements: [
    { key: 'executable', value: 'file' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'File provider failed'
}

function descriptionFrom(output: string): string {
  return output.trim().replace(/\s+/g, ' ').slice(0, 4000)
}

export function fileObservation(description: string, artifactId?: string): { observation: { kind: 'fact'; type: string; key: string; label: string; attributes: ObservationAttributes } } {
  return {
    observation: {
      kind: 'fact',
      type: 'file_identification',
      key: `artifact:${artifactId || 'unknown'}:file-identification`,
      label: description.slice(0, 256),
      attributes: { description },
    },
  }
}

export async function executeFileInspection(input: ToolExecutionInput): Promise<ToolResult> {
  const baseResult = {
    toolId: fileInspectorManifest.id,
    capabilities: fileInspectorManifest.capabilities,
    produced: fileInspectorManifest.produces,
  }
  if (!input.artifactPath) {
    return { status: 'failed', ...baseResult, data: {}, error: 'Controlled artifact path is required' }
  }

  const timeoutMs = boundedEnvNumber('REAMON_FILE_PROCESS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS)
  const maxOutputBytes = boundedEnvNumber('REAMON_FILE_PROCESS_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES, 1_024, MAX_OUTPUT_BYTES)

  try {
    const result = await runBoundedProcess({
      executable: 'file',
      args: ['--brief', '--dereference', '--', input.artifactPath],
      signal: input.signal,
      maxOutputBytes,
      timeoutMs,
      timeoutError: (value) => `file provider timed out after ${Math.ceil(value / 1000)} seconds`,
    })
    const description = descriptionFrom(result.stdout)
    if (!description) return { status: 'failed', ...baseResult, data: {}, error: 'file returned no identification' }
    const { observation } = fileObservation(description, input.artifactId)
    return {
      status: 'completed',
      ...baseResult,
      data: {
        description,
        observations: [observation],
        truncated: result.truncated,
        stderr: result.stderr.slice(0, 4000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...baseResult, data: {}, error: boundedError(error) }
  }
}

export const fileInspectorPlugin: ToolPlugin = {
  manifest: fileInspectorManifest,
  analyze: executeFileInspection,
}
