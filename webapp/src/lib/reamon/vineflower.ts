import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_UNITS = 20_000
const DEFAULT_TIMEOUT_MS = 20 * 60_000

interface VineflowerUnit {
  name: string
  relativePath: string
  codeArtifactId: string
  language: 'Java' | 'Kotlin'
  sizeBytes: number
  outputSha256: string
}

interface VineflowerResponse {
  status: 'completed'
  toolVersion: string
  inputName: string
  artifactSha256: string
  sourceFileCount: number
  codeBytes: number
  truncated: boolean
  units: VineflowerUnit[]
  warnings?: string
}

export const vineflowerManifest: ToolPluginManifest = {
  id: 'reamon-vineflower',
  name: 'Vineflower Java and Kotlin Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['jar', 'class'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource'],
  requirements: [
    { key: 'service', value: 'Vineflower isolated analyzer container' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Vineflower analysis failed'
}

function isVineflowerResponse(value: unknown): value is VineflowerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && record.toolVersion === '1.12.0'
    && typeof record.inputName === 'string' && record.inputName.length <= 1000
    && typeof record.artifactSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.artifactSha256)
    && Number.isSafeInteger(record.sourceFileCount) && Number.isSafeInteger(record.codeBytes)
    && typeof record.truncated === 'boolean' && Array.isArray(record.units)
    && (record.warnings === undefined || typeof record.warnings === 'string')
}

function validUnit(value: unknown, expectedPrefix: string): value is VineflowerUnit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const unit = value as Record<string, unknown>
  return typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
    && typeof unit.relativePath === 'string' && /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]{1,1000}\.(?:java|kt)$/i.test(unit.relativePath)
    && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId === `${expectedPrefix}${unit.relativePath}`
    && unit.codeArtifactId.length <= 2000
    && (unit.language === 'Java' || unit.language === 'Kotlin')
    && (unit.relativePath.toLowerCase().endsWith('.kt') === (unit.language === 'Kotlin'))
    && typeof unit.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(unit.outputSha256)
    && Number.isSafeInteger(unit.sizeBytes) && Number(unit.sizeBytes) > 0 && Number(unit.sizeBytes) <= 16 * 1024 * 1024
}

export async function executeVineflower(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: vineflowerManifest.id,
    capabilities: vineflowerManifest.capabilities,
    produced: vineflowerManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Vineflower requires a stored JVM .class or .jar artifact and task context' }
  }
  const baseUrl = process.env.REAMON_VINEFLOWER_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Vineflower analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_VINEFLOWER_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        ? payload.error.slice(0, 1200)
        : `Vineflower analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isVineflowerResponse(payload)) throw new Error('Vineflower analyzer returned an invalid result')

    const prefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/sources/`
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, prefix))
    if (!units.length) throw new Error('Vineflower did not produce viewable Java or Kotlin source')
    const observations: ToolObservation[] = units.map((unit) => {
      const identity = `${input.artifactId}:${unit.relativePath}`
      return {
        kind: 'entity',
        type: 'code_unit',
        key: `vineflower:class:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
        label: unit.name,
        attributes: {
          unitType: 'class',
          identity,
          name: unit.name,
          qualifiedName: unit.name,
          sizeBytes: unit.sizeBytes,
          language: unit.language,
          relativePath: unit.relativePath,
          decompiled: true,
          codeArtifactId: unit.codeArtifactId,
          decompilationEngine: 'Vineflower',
          decompilationEngineVersion: payload.toolVersion,
          experimentalLanguagePlugin: unit.language === 'Kotlin',
          inputArtifactSha256: payload.artifactSha256,
          decompiledSourceSha256: unit.outputSha256,
        },
      }
    })
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        inputName: payload.inputName,
        decompiledCodeUnitCount: payload.sourceFileCount,
        returnedCodeUnitCount: units.length,
        codeBytes: payload.codeBytes,
        truncated: payload.truncated || payload.sourceFileCount > units.length,
        vineflowerVersion: payload.toolVersion,
        warnings: payload.warnings?.slice(0, 4000) || '',
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const vineflowerPlugin: ToolPlugin = { manifest: vineflowerManifest, analyze: executeVineflower }
