import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 10 * 60_000

interface PycdcResponse {
  status: 'completed'
  toolVersion: string
  unit: { name: string; relativePath: string; codeArtifactId: string; sizeBytes: number }
  codeBytes: number
  truncated: boolean
  warnings?: string
}

export const pycdcManifest: ToolPluginManifest = {
  id: 'reamon-pycdc',
  name: 'Python Bytecode Decompiler (pycdc)',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['python-bytecode'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'PythonModule'],
  requirements: [
    { key: 'service', value: 'Isolated pycdc analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4_000) || 'pycdc analysis failed'
}

function timeoutMs(): number {
  const value = Number(process.env.REAMON_PYCDC_REQUEST_TIMEOUT_MS)
  return Number.isFinite(value) ? Math.min(MAX_TIMEOUT_MS, Math.max(10_000, Math.floor(value))) : DEFAULT_TIMEOUT_MS
}

function isResponse(value: unknown): value is PycdcResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (!response.unit || typeof response.unit !== 'object' || Array.isArray(response.unit)) return false
  const unit = response.unit as Record<string, unknown>
  return response.status === 'completed'
    && typeof response.toolVersion === 'string'
    && Number.isSafeInteger(response.codeBytes) && (response.codeBytes as number) > 0
    && typeof response.truncated === 'boolean'
    && typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
    && typeof unit.relativePath === 'string' && unit.relativePath.length > 0 && unit.relativePath.length <= 1_000
    && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId.length > 0 && unit.codeArtifactId.length <= 2_000
    && Number.isSafeInteger(unit.sizeBytes) && (unit.sizeBytes as number) > 0
    && (response.warnings === undefined || typeof response.warnings === 'string')
}

export async function executePycdc(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: pycdcManifest.id,
    capabilities: pycdcManifest.capabilities,
    produced: pycdcManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'pycdc requires a stored Python bytecode artifact and task context' }
  }

  const baseUrl = process.env.REAMON_PYCDC_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated pycdc analyzer is not configured' }

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
        extension: input.targetProfile.extension,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1_000)
        : `pycdc analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('pycdc analyzer returned an invalid result')

    const unit = payload.unit
    const key = `pycdc:module:${createHash('sha256').update(`${input.artifactId}:${unit.relativePath}`).digest('hex').slice(0, 32)}`
    const observations: ToolObservation[] = [{
      kind: 'entity',
      type: 'code_unit',
      key,
      label: unit.name,
      attributes: {
        unitType: 'module',
        identity: `${input.artifactId}:${unit.relativePath}`,
        name: unit.name,
        qualifiedName: unit.name,
        relativePath: unit.relativePath,
        sizeBytes: unit.sizeBytes,
        language: 'Python',
        decompiled: true,
        codeArtifactId: unit.codeArtifactId,
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
        truncated: payload.truncated,
        pycdcVersion: payload.toolVersion.slice(0, 80),
        warnings: (payload.warnings || '').slice(0, 4_000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const pycdcPlugin: ToolPlugin = { manifest: pycdcManifest, analyze: executePycdc }
