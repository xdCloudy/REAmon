import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_UNITS = 5000
const DEFAULT_TIMEOUT_MS = 20 * 60_000

interface JadxResponse {
  status: 'completed'
  toolVersion: string
  classCount: number
  codeBytes?: number
  returnedUnits: number
  truncated: boolean
  units: Array<{ name: string; relativePath: string; codeArtifactId: string; disassemblyArtifactId?: string; disassemblyLanguage?: string; unitType?: string; language?: string; sizeBytes: number }>
  warnings?: string
}

export const jadxManifest: ToolPluginManifest = {
  id: 'reamon-jadx',
  name: 'JADX Android and Java Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['apk', 'jar', 'dex', 'class'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'DexDisassembly'],
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
    return { status: 'failed', ...base, data: {}, error: 'JADX requires a stored supported bytecode artifact and task context' }
  }

  const baseUrl = process.env.REAMON_JADX_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated JADX analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_JADX_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
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
        ? payload.error.slice(0, 1000)
        : `JADX analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isJadxResponse(payload)) throw new Error('JADX analyzer returned an invalid result')

    const units = payload.units.slice(0, MAX_UNITS).filter((unit) =>
      unit && typeof unit.name === 'string' && typeof unit.relativePath === 'string'
      && typeof unit.codeArtifactId === 'string' && Number.isFinite(unit.sizeBytes) && unit.sizeBytes > 0
      && (unit.disassemblyArtifactId === undefined || typeof unit.disassemblyArtifactId === 'string')
      && (unit.disassemblyLanguage === undefined || typeof unit.disassemblyLanguage === 'string')
      && (unit.unitType === undefined || typeof unit.unitType === 'string')
      && (unit.language === undefined || typeof unit.language === 'string'))
    if (!units.length) throw new Error('JADX did not produce any viewable Java classes')

    const observations = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: `jadx:class:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${unit.relativePath}`).digest('hex').slice(0, 32)}`,
      label: unit.name,
      attributes: {
        unitType: (unit.unitType || 'class').slice(0, 80),
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        sizeBytes: Math.floor(unit.sizeBytes),
        language: (unit.language || 'Java').slice(0, 80),
        decompiled: true,
        codeArtifactId: unit.codeArtifactId.slice(0, 2000),
        ...(unit.disassemblyArtifactId ? { disassemblyArtifactId: unit.disassemblyArtifactId.slice(0, 2000) } : {}),
        ...(unit.disassemblyLanguage ? { disassemblyLanguage: unit.disassemblyLanguage.slice(0, 80) } : {}),
      },
    }))
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        decompiledClassCount: payload.classCount,
        returnedClassCount: observations.length,
        codeBytes: typeof payload.codeBytes === 'number' && Number.isFinite(payload.codeBytes) ? Math.max(0, Math.floor(payload.codeBytes)) : observations.reduce((sum, observation) => sum + Number(observation.attributes.sizeBytes), 0),
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
