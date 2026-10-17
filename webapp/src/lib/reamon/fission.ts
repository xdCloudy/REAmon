import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'
import { nativeFunctionIdentity } from './native-function-identity'

const FISSION_VERSION = '0.2.3'
const FISSION_COMMIT = '1ea2b858358b5398e920e7caa34201524b538c87'
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_UNITS = 256

interface FissionUnit {
  name: string
  address: string
  relativePath: string
  codeArtifactId: string
  sizeBytes: number
  outputSha256: string
  engine: string
  previewBuildStats: Record<string, number>
}

interface FissionResponse {
  status: 'completed'
  toolVersion: typeof FISSION_VERSION
  providerRevision: typeof FISSION_COMMIT
  sourceSha256: string
  batchResultCount: number
  returnedUnits: number
  failedFunctionCount: number
  truncated: boolean
  outputBytes: number
  elapsedMs: number
  units: FissionUnit[]
}

export const fissionManifest: ToolPluginManifest = {
  id: 'reamon-fission',
  name: 'Fission Native Restoration',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'FunctionAddress'],
  requirements: [
    { key: 'service', value: 'Fission isolated analyzer' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function codeUnitKey(artifactId: string, taskId: string, address: string): string {
  return `fission:function:${createHash('sha256').update(`${artifactId}:${taskId}:${address}`).digest('hex').slice(0, 32)}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Fission analysis failed'
}

function isFissionResponse(value: unknown): value is FissionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
    && record.toolVersion === FISSION_VERSION && record.providerRevision === FISSION_COMMIT
    && typeof record.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sourceSha256)
    && Number.isSafeInteger(record.batchResultCount) && Number.isSafeInteger(record.returnedUnits)
    && Number.isSafeInteger(record.failedFunctionCount) && typeof record.truncated === 'boolean'
    && Number.isSafeInteger(record.outputBytes) && Number.isSafeInteger(record.elapsedMs)
}

function validUnit(unit: unknown, expectedPrefix: string): unit is FissionUnit {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return false
  const record = unit as Record<string, unknown>
  return typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 500
    && typeof record.address === 'string' && /^0x[0-9a-f]{1,32}$/i.test(record.address)
    && typeof record.relativePath === 'string' && /^functions\/[0-9a-f]+\.c$/i.test(record.relativePath)
    && typeof record.codeArtifactId === 'string'
    && record.codeArtifactId === `${expectedPrefix}${record.relativePath}` && record.codeArtifactId.length <= 2000
    && typeof record.sizeBytes === 'number' && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes > 0 && record.sizeBytes <= 2 * 1024 * 1024
    && typeof record.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.outputSha256)
    && typeof record.engine === 'string' && record.engine.length > 0 && record.engine.length <= 80
    && Boolean(record.previewBuildStats) && typeof record.previewBuildStats === 'object' && !Array.isArray(record.previewBuildStats)
    && Object.keys(record.previewBuildStats as Record<string, unknown>).length <= 32
    && Object.values(record.previewBuildStats as Record<string, unknown>).every((count) => Number.isSafeInteger(count) && (count as number) >= 0)
}

export async function executeFission(input: ToolExecutionInput): Promise<ToolResult> {
  const base = { toolId: fissionManifest.id, capabilities: fissionManifest.capabilities, produced: fissionManifest.produces }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Fission requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_FISSION_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Fission analyzer is not configured' }
  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_FISSION_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: input.projectId, artifactId: input.artifactId, taskId: input.taskId, runId: input.runToken, artifactPath: input.artifactPath }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1200)
        : `Fission analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isFissionResponse(payload)) throw new Error('Fission analyzer returned invalid provenance')
    const expectedPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, expectedPrefix))
    if (!units.length) throw new Error('Fission did not produce any viewable C-like pseudocode')

    const observations: ToolObservation[] = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: codeUnitKey(input.artifactId!, input.taskId!, unit.address),
      label: unit.name.slice(0, 500),
      attributes: {
        unitType: 'function',
        ...(nativeFunctionIdentity(input.artifactId!, unit.address) ? { identity: nativeFunctionIdentity(input.artifactId!, unit.address)! } : {}),
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        address: unit.address,
        relativePath: unit.relativePath,
        sizeBytes: unit.sizeBytes,
        language: 'C',
        representation: 'pseudocode',
        representationSemantics: 'Fission-generated native C-like reconstruction. It is provider evidence, not verified original-language source, maintainable code, or proof of behavior.',
        decompiler: 'Fission',
        decompilerVersion: payload.toolVersion,
        providerRevision: payload.providerRevision,
        inputArtifactSha256: payload.sourceSha256.toLowerCase(),
        ...(typeof input.targetProfile.architecture === 'string' && input.targetProfile.architecture
          ? { architecture: input.targetProfile.architecture.slice(0, 128) } : {}),
        codeArtifactSha256: unit.outputSha256.toLowerCase(),
        decompiledSourceSha256: unit.outputSha256.toLowerCase(),
        codeArtifactId: unit.codeArtifactId,
        fissionEngine: unit.engine,
        fissionPreviewBuildStats: JSON.stringify(unit.previewBuildStats).slice(0, 2000),
        experimentalPseudocode: true,
      },
    }))

    return {
      status: 'completed',
      ...base,
      data: {
        batchResultCount: payload.batchResultCount,
        returnedFunctionCount: units.length,
        failedFunctionCount: payload.failedFunctionCount,
        truncated: payload.truncated || payload.batchResultCount > units.length || payload.units.length > units.length,
        sourceSha256: payload.sourceSha256.toLowerCase(),
        providerRevision: payload.providerRevision,
        fissionVersion: payload.toolVersion,
        outputBytes: payload.outputBytes,
        elapsedMs: payload.elapsedMs,
        semantics: 'Fission-generated native C-like source reconstruction is an alternate analysis artifact, not recovered original-language source or proof of behavior.',
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const fissionPlugin: ToolPlugin = { manifest: fissionManifest, analyze: executeFission }
