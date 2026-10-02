import { createHash } from 'node:crypto'
import { runBoundedProcess } from './bounded-process'
import type { ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_STRINGS = 500
const MAX_STRINGS = 2_000

export const sourceInspectorManifest: ToolPluginManifest = {
  id: 'reamon-source-inspector',
  name: 'REAmon Source Inspector',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['source'],
  capabilities: ['extract_strings'],
  produces: ['String', 'CodeEntity'],
  requirements: [
    { key: 'executable', value: 'strings' },
    { key: 'artifactPath' },
  ],
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
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Process provider failed'
}

function runStrings(artifactPath: string, signal: AbortSignal | undefined, maxOutputBytes: number, timeoutMs: number) {
  return runBoundedProcess({
    executable: 'strings',
    args: ['-a', '-n', '4', '--', artifactPath],
    signal,
    maxOutputBytes,
    timeoutMs,
    timeoutError: (value) => `strings provider timed out after ${Math.ceil(value / 1000)} seconds`,
  })
}

export function extractStrings(output: string, artifactId: string | undefined, maxStrings: number): { strings: string[]; observations: Array<Record<string, unknown>> } {
  const strings: string[] = []
  const observations: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const rawValue of output.split(/\r?\n/)) {
    const value = rawValue.trim().slice(0, 512)
    if (value.length < 4 || seen.has(value)) continue
    seen.add(value)
    strings.push(value)
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 24)
    observations.push({
      kind: 'entity',
      type: 'string',
      key: `artifact:${artifactId || 'unknown'}:string:${digest}`,
      label: value,
      attributes: { value },
    })
    if (strings.length >= maxStrings) break
  }
  return { strings, observations }
}

export async function executeSourceInspection(input: ToolExecutionInput): Promise<ToolResult> {
  const baseResult = {
    toolId: sourceInspectorManifest.id,
    capabilities: sourceInspectorManifest.capabilities,
    produced: sourceInspectorManifest.produces,
  }
  if (!input.artifactPath) {
    return { status: 'failed', ...baseResult, data: {}, error: 'Controlled artifact path is required' }
  }

  const options = input.options
  const maxOutputBytes = optionNumber(options, 'maxOutputBytes', boundedEnvNumber('REAMON_MAX_PROCESS_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES, 4 * 1024, MAX_OUTPUT_BYTES), 4 * 1024, MAX_OUTPUT_BYTES)
  const maxStrings = optionNumber(options, 'maxStrings', DEFAULT_MAX_STRINGS, 1, MAX_STRINGS)
  const timeoutMs = boundedEnvNumber('REAMON_PROCESS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS)

  try {
    const result = await runStrings(input.artifactPath, input.signal, maxOutputBytes, timeoutMs)
    const extracted = extractStrings(result.stdout, input.artifactId, maxStrings)
    return {
      status: 'completed',
      ...baseResult,
      data: {
        strings: extracted.strings,
        observations: extracted.observations,
        truncated: result.truncated || extracted.strings.length >= maxStrings,
        stderr: result.stderr.slice(0, 4000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...baseResult, data: {}, error: boundedError(error) }
  }
}

export const sourceInspectorPlugin: ToolPlugin = {
  manifest: sourceInspectorManifest,
  analyze: executeSourceInspection,
}
