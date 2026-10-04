import type { ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const MAX_UNITS = 500
const DEFAULT_TIMEOUT_MS = 20 * 60_000

interface JadxResponse {
  status: 'completed'
  toolVersion: string
  classCount: number
  returnedUnits: number
  truncated: boolean
  units: Array<{ name: string; relativePath: string; codeArtifactId: string; sizeBytes: number }>
  warnings?: string
}

export const jadxManifest: ToolPluginManifest = {
  id: 'reamon-jadx',
  name: 'JADX Android Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['apk'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource'],
  requirements: [
    { key: 'service', value: 'JADX isolated analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'JADX analysis failed'
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function isJadxResponse(value: unknown): value is JadxResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
}

export async function executeJadx(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: jadxManifest.id,
    capabilities: jadxManifest.capabilities,
    produced: jadxManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'JADX requires a stored APK and task context' }
  }

  const baseUrl = process.env.REAMON_JADX_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated JADX analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_JADX_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1000)
        : `JADX analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isJadxResponse(payload)) throw new Error('JADX analyzer returned an invalid result')

    const units = payload.units.slice(0, MAX_UNITS).filter((unit) =>
      unit && typeof unit.name === 'string' && typeof unit.relativePath === 'string'
      && typeof unit.codeArtifactId === 'string' && Number.isFinite(unit.sizeBytes) && unit.sizeBytes > 0)
    if (!units.length) throw new Error('JADX did not produce any viewable Java classes')

    const observations = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: `jadx:class:${unit.relativePath}`,
      label: unit.name,
      attributes: {
        unitType: 'class',
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        sizeBytes: Math.floor(unit.sizeBytes),
        language: 'Java',
        decompiled: true,
        codeArtifactId: unit.codeArtifactId.slice(0, 2000),
      },
    }))
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        decompiledClassCount: payload.classCount,
        returnedClassCount: observations.length,
        truncated: payload.truncated || payload.classCount > observations.length,
        jadxVersion: payload.toolVersion,
        warnings: payload.warnings?.slice(0, 4000) || '',
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const jadxPlugin: ToolPlugin = { manifest: jadxManifest, analyze: executeJadx }
