import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
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

interface ProcessResult {
  stdout: string
  stderr: string
  truncated: boolean
}

function runStrings(artifactPath: string, signal: AbortSignal | undefined, maxOutputBytes: number, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Provider execution cancelled'))
      return
    }

    const child = spawn('strings', ['-a', '-n', '4', '--', artifactPath], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let aborted = false
    let timedOut = false
    let finished = false
    let killTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      killTimer.unref?.()
    }, timeoutMs)
    timeout.unref?.()

    const finishError = (error: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      killTimer.unref?.()
    }
    const appendStdout = (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) {
        truncated = true
        return
      }
      const remaining = maxOutputBytes - stdoutBytes
      const bounded = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
      stdout.push(bounded)
      stdoutBytes += bounded.byteLength
      if (bounded.byteLength < chunk.byteLength) {
        truncated = true
        child.kill('SIGTERM')
      }
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', appendStdout)
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = 64 * 1024 - stderrBytes
      if (remaining <= 0) return
      const bounded = chunk.subarray(0, remaining)
      stderr.push(bounded)
      stderrBytes += bounded.byteLength
    })
    child.once('error', (error) => finishError(error instanceof Error ? error : new Error(String(error))))
    child.once('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      if (aborted) {
        reject(new Error('Provider execution cancelled'))
        return
      }
      if (timedOut) {
        reject(new Error(`strings provider timed out after ${Math.ceil(timeoutMs / 1000)} seconds`))
        return
      }
      if (code !== 0 && !truncated) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(new Error(detail || `strings provider exited with code ${code ?? 'unknown'}`))
        return
      }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated })
    })
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
