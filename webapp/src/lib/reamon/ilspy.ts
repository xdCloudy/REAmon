import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_UNITS = 20000
const MAX_METHOD_FEATURES = 8_000
const DEFAULT_TIMEOUT_MS = 20 * 60_000

interface IlspyResponse {
  status: 'completed'
  toolVersion: string
  classCount: number | null
  codeBytes?: number
  returnedUnits: number
  truncated: boolean
  units: Array<{ name: string; relativePath: string; codeArtifactId: string; unitType?: string; language?: string; sizeBytes: number }>
  methods?: Array<{ signature: string; relativePath: string; instructionMnemonics: string[] }>
  methodFeaturesTruncated?: boolean
  warnings?: string
}

export const ilspyManifest: ToolPluginManifest = {
  id: 'reamon-ilspy',
  name: 'ILSpy .NET Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['pe-dotnet'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'ManagedType'],
  requirements: [
    { key: 'service', value: 'ILSpy isolated analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'ILSpy analysis failed'
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function isIlspyResponse(value: unknown): value is IlspyResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
}

export async function executeIlspy(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: ilspyManifest.id,
    capabilities: ilspyManifest.capabilities,
    produced: ilspyManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'ILSpy requires a stored managed assembly and task context' }
  }

  const baseUrl = process.env.REAMON_ILSPY_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated ILSpy analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_ILSPY_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `ILSpy analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isIlspyResponse(payload)) throw new Error('ILSpy analyzer returned an invalid result')

    const units = payload.units.slice(0, MAX_UNITS).filter((unit) =>
      unit && typeof unit.name === 'string' && typeof unit.relativePath === 'string'
      && typeof unit.codeArtifactId === 'string' && Number.isFinite(unit.sizeBytes) && unit.sizeBytes > 0
      && (unit.unitType === undefined || typeof unit.unitType === 'string')
      && (unit.language === undefined || typeof unit.language === 'string'))
    if (!units.length) throw new Error('ILSpy did not produce any viewable C# types')

    const observations: ToolObservation[] = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: `ilspy:type:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${unit.relativePath}`).digest('hex').slice(0, 32)}`,
      label: unit.name,
      attributes: {
        unitType: (unit.unitType || 'type').slice(0, 80),
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        sizeBytes: Math.floor(unit.sizeBytes),
        language: (unit.language || 'C#').slice(0, 80),
        relativePath: unit.relativePath.slice(0, 1000),
        decompiled: true,
        codeArtifactId: unit.codeArtifactId.slice(0, 2000),
      },
    }))
    const unitsByPath = new Map(units.map((unit) => [unit.relativePath, unit]))
    const methods = (Array.isArray(payload.methods) ? payload.methods : []).slice(0, MAX_METHOD_FEATURES).filter((method) =>
      method && typeof method.signature === 'string' && method.signature.length <= 1000
      && typeof method.relativePath === 'string' && method.relativePath.length <= 1000
      && Array.isArray(method.instructionMnemonics) && method.instructionMnemonics.length <= 128
      && method.instructionMnemonics.every((mnemonic) => typeof mnemonic === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,31}$/.test(mnemonic)))
    const methodKeys = new Set<string>()
    let methodObservationsTruncated = (payload.methods?.length || 0) > MAX_METHOD_FEATURES
    for (const method of methods) {
      const unit = unitsByPath.get(method.relativePath)
      if (!unit) {
        methodObservationsTruncated = true
        continue
      }
      if (observations.length >= MAX_UNITS) {
        methodObservationsTruncated = true
        break
      }
      const key = `ilspy:method:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${method.signature}`).digest('hex').slice(0, 32)}`
      if (methodKeys.has(key)) continue
      methodKeys.add(key)
      const label = method.signature.slice(0, 500)
      observations.push({
        kind: 'entity',
        type: 'function',
        key,
        label,
        attributes: {
          identity: `${input.artifactId}:${method.signature}`,
          unitType: 'function',
          name: label,
          qualifiedName: label,
          address: method.signature,
          language: unit.language || 'C#',
          instructionLanguage: 'IL',
          parentCodeUnitKey: `ilspy:type:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${unit.relativePath}`).digest('hex').slice(0, 32)}`,
          relativePath: unit.relativePath.slice(0, 1000),
          codeArtifactId: unit.codeArtifactId.slice(0, 2000),
          instructionMnemonics: JSON.stringify(method.instructionMnemonics),
        },
      })
    }
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        decompiledClassCount: typeof payload.classCount === 'number' && Number.isSafeInteger(payload.classCount) && payload.classCount >= 0 ? payload.classCount : null,
        returnedClassCount: units.length,
        codeBytes: typeof payload.codeBytes === 'number' && Number.isFinite(payload.codeBytes) ? Math.max(0, Math.floor(payload.codeBytes)) : observations.reduce((sum, observation) => sum + Number(observation.attributes.sizeBytes), 0),
        truncated: payload.truncated || payload.methodFeaturesTruncated === true || methodObservationsTruncated || (typeof payload.classCount === 'number' && payload.classCount > units.length),
        ilspyVersion: typeof payload.toolVersion === 'string' ? payload.toolVersion.slice(0, 80) : 'unknown',
        warnings: typeof payload.warnings === 'string' ? payload.warnings.slice(0, 4000) : '',
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const ilspyPlugin: ToolPlugin = { manifest: ilspyManifest, analyze: executeIlspy }
