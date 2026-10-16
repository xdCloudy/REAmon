import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 10 * 60_000

interface UnluacResponse {
  status: 'completed'
  toolVersion: string
  input: { relativePath: string; sha256: string }
  unit: { name: string; relativePath: string; codeArtifactId: string; sizeBytes: number }
  codeBytes: number
  warnings?: string
}

export const unluacManifest: ToolPluginManifest = {
  id: 'reamon-unluac',
  name: 'Lua Bytecode Decompiler (unluac)',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['lua-bytecode-5.0', 'lua-bytecode'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'LuaModule'],
  requirements: [
    { key: 'service', value: 'Isolated unluac analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4_000) || 'Lua bytecode analysis failed'
}

function timeoutMs(): number {
  const value = Number(process.env.REAMON_UNLUAC_REQUEST_TIMEOUT_MS)
  return Number.isFinite(value) ? Math.min(MAX_TIMEOUT_MS, Math.max(10_000, Math.floor(value))) : DEFAULT_TIMEOUT_MS
}

function isResponse(value: unknown): value is UnluacResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (!response.input || typeof response.input !== 'object' || Array.isArray(response.input)) return false
  const input = response.input as Record<string, unknown>
  if (!response.unit || typeof response.unit !== 'object' || Array.isArray(response.unit)) return false
  const unit = response.unit as Record<string, unknown>
  return response.status === 'completed'
    && typeof response.toolVersion === 'string' && response.toolVersion.length <= 80
    && typeof input.relativePath === 'string' && input.relativePath.length > 0 && input.relativePath.length <= 1_000
    && typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(input.sha256)
    && typeof response.codeBytes === 'number' && Number.isSafeInteger(response.codeBytes) && response.codeBytes > 0
    && typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
    && typeof unit.relativePath === 'string' && unit.relativePath.length > 0 && unit.relativePath.length <= 1_000
    && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId.length > 0 && unit.codeArtifactId.length <= 2_000
    && typeof unit.sizeBytes === 'number' && Number.isSafeInteger(unit.sizeBytes) && unit.sizeBytes > 0
    && (response.warnings === undefined || typeof response.warnings === 'string')
}

export async function executeUnluac(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: unluacManifest.id,
    capabilities: unluacManifest.capabilities,
    produced: unluacManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Lua decompilation requires a stored bytecode artifact and task context' }
  }

  const baseUrl = process.env.REAMON_UNLUAC_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated unluac analyzer is not configured' }

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
        artifactRelativePath: input.artifactRelativePath,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1_000)
        : `unluac analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('unluac analyzer returned an invalid result')

    const unit = payload.unit
    const identity = `${input.artifactId}:${unit.relativePath}`
    const key = `unluac:module:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
    const observations: ToolObservation[] = [{
      kind: 'entity',
      type: 'code_unit',
      key,
      label: unit.name,
      attributes: {
        unitType: 'module',
        identity,
        name: unit.name,
        qualifiedName: unit.name,
        relativePath: unit.relativePath,
        sizeBytes: unit.sizeBytes,
        language: 'Lua',
        decompiled: true,
        codeArtifactId: unit.codeArtifactId,
        inputSha256: payload.input.sha256,
        engineVersion: payload.toolVersion,
      },
    }]
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        decompiledModuleCount: 1,
        returnedModuleCount: 1,
        codeBytes: payload.codeBytes,
        truncated: false,
        toolVersion: payload.toolVersion,
        warnings: (payload.warnings || '').slice(0, 4_000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const unluacPlugin: ToolPlugin = { manifest: unluacManifest, analyze: executeUnluac }
