import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_CLASSES = 500
const DEFAULT_TIMEOUT_MS = 20 * 60_000

interface DexDecompilerResponse {
  status: 'completed'
  toolVersion: string
  input: { sha256: string; relativePath: string }
  discoveredClassCount: number
  returnedClassCount: number
  codeBytes: number
  truncated: boolean
  units: Array<{ name: string; relativePath: string; codeArtifactId: string; sizeBytes: number }>
  warnings?: string
}

export const dexDecompilerManifest: ToolPluginManifest = {
  id: 'reamon-dex-decompiler',
  name: 'Rust DEX-to-Java Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['apk', 'dex'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource'],
  requirements: [
    { key: 'service', value: 'Isolated dex-decompiler analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4_000) || 'DEX-to-Java analysis failed'
}

function timeoutMs(): number {
  const value = Number(process.env.REAMON_DEX_DECOMPILER_REQUEST_TIMEOUT_MS)
  return Number.isFinite(value) ? Math.min(30 * 60_000, Math.max(60_000, Math.floor(value))) : DEFAULT_TIMEOUT_MS
}

function isResponse(value: unknown): value is DexDecompilerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const input = response.input
  return response.status === 'completed'
    && typeof response.toolVersion === 'string' && /^[a-f0-9]{40}$/i.test(response.toolVersion)
    && !!input && typeof input === 'object' && !Array.isArray(input)
    && typeof (input as Record<string, unknown>).sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test((input as Record<string, unknown>).sha256 as string)
    && typeof (input as Record<string, unknown>).relativePath === 'string'
    && ((input as Record<string, unknown>).relativePath as string).length > 0
    && ((input as Record<string, unknown>).relativePath as string).length <= 1_000
    && Number.isSafeInteger(response.discoveredClassCount) && (response.discoveredClassCount as number) >= 0
    && Number.isSafeInteger(response.returnedClassCount) && (response.returnedClassCount as number) >= 0
    && typeof response.codeBytes === 'number' && Number.isSafeInteger(response.codeBytes) && response.codeBytes >= 0
    && typeof response.truncated === 'boolean'
    && Array.isArray(response.units) && response.units.length <= MAX_CLASSES
    && response.returnedClassCount === response.units.length
    && (response.discoveredClassCount as number) >= response.units.length
    && response.units.every((unit) => !!unit && typeof unit === 'object' && !Array.isArray(unit)
      && typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
      && typeof unit.relativePath === 'string' && unit.relativePath.length > 0 && unit.relativePath.length <= 1_000
      && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId.length > 0 && unit.codeArtifactId.length <= 2_000
      && Number.isSafeInteger(unit.sizeBytes) && unit.sizeBytes > 0)
    && (response.warnings === undefined || typeof response.warnings === 'string')
}

export async function executeDexDecompiler(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: dexDecompilerManifest.id,
    capabilities: dexDecompilerManifest.capabilities,
    produced: dexDecompilerManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'DEX decompilation requires a stored APK or DEX artifact and task context' }
  }

  const baseUrl = process.env.REAMON_DEX_DECOMPILER_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated DEX decompiler is not configured' }

  const timeout = AbortSignal.timeout(timeoutMs())
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        projectId: input.projectId,
        artifactId: input.artifactId,
        taskId: input.taskId,
        runId: input.runToken,
        artifactPath: input.artifactPath,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1_000)
        : `DEX decompiler returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('DEX decompiler returned an invalid result')
    if (!payload.units.length) throw new Error('DEX decompiler did not produce viewable Java classes')

    const observations: ToolObservation[] = payload.units.slice(0, MAX_CLASSES).map((unit) => {
      const identity = `${input.artifactId}:${unit.relativePath}`
      const key = `dex-decompiler:class:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
      return {
        kind: 'entity',
        type: 'code_unit',
        key,
        label: unit.name,
        attributes: {
          unitType: 'class',
          identity,
          name: unit.name,
          qualifiedName: unit.name,
          sizeBytes: unit.sizeBytes,
          language: 'Java',
          relativePath: unit.relativePath,
          decompiled: true,
          codeArtifactId: unit.codeArtifactId,
          decompilationEngine: 'androguard/dex-decompiler',
          decompilationEngineVersion: payload.toolVersion,
          sourceSha256: payload.input.sha256,
          alternateDecompiler: true,
        },
      }
    })
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        discoveredClassCount: payload.discoveredClassCount,
        returnedClassCount: payload.returnedClassCount,
        codeBytes: payload.codeBytes,
        truncated: payload.truncated || payload.discoveredClassCount > payload.returnedClassCount,
        decompilationEngine: 'androguard/dex-decompiler',
        decompilationEngineVersion: payload.toolVersion,
        inputSha256: payload.input.sha256,
        warnings: (payload.warnings || '').slice(0, 4_000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const dexDecompilerPlugin: ToolPlugin = { manifest: dexDecompilerManifest, analyze: executeDexDecompiler }
