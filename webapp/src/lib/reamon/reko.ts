import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'
import { nativeFunctionIdentity } from './native-function-identity'

const REKO_VERSION = '0.12.5'
const REKO_COMMIT = '418d3538ee87f46e87b80b5b8b93138f63952497'
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_UNITS = 256

interface RekoUnit {
  name: string
  address: string
  relativePath: string
  codeArtifactId: string
  sizeBytes: number
  outputSha256: string
  sourceFile: string
}

interface RekoResponse {
  status: 'completed'
  toolVersion: typeof REKO_VERSION
  providerRevision: typeof REKO_COMMIT
  sourceSha256: string
  functionCount: number
  returnedUnits: number
  failedFunctionCount: number
  truncated: boolean
  outputBytes: number
  elapsedMs: number
  units: RekoUnit[]
}

export const rekoManifest: ToolPluginManifest = {
  id: 'reamon-reko',
  name: 'Reko Native Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'FunctionAddress'],
  requirements: [
    { key: 'service', value: 'Reko isolated analyzer' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function codeUnitKey(artifactId: string, taskId: string, address: string): string {
  return `reko:function:${createHash('sha256').update(`${artifactId}:${taskId}:${address}`).digest('hex').slice(0, 32)}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Reko analysis failed'
}

function isRekoResponse(value: unknown): value is RekoResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
    && record.toolVersion === REKO_VERSION && record.providerRevision === REKO_COMMIT
    && typeof record.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sourceSha256)
    && ['functionCount', 'returnedUnits', 'failedFunctionCount', 'outputBytes', 'elapsedMs']
      .every((key) => typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && (record[key] as number) >= 0)
    && typeof record.truncated === 'boolean'
}

function validUnit(unit: unknown, expectedPrefix: string): unit is RekoUnit {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return false
  const record = unit as Record<string, unknown>
  return typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 500
    && typeof record.address === 'string' && /^0x[0-9a-f]{1,32}$/i.test(record.address)
    && typeof record.relativePath === 'string' && /^functions\/[0-9a-f]+\.c$/i.test(record.relativePath)
    && record.codeArtifactId === `${expectedPrefix}${record.relativePath}`
    && typeof record.sizeBytes === 'number' && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes > 0 && record.sizeBytes <= 2 * 1024 * 1024
    && typeof record.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.outputSha256)
    && typeof record.sourceFile === 'string' && record.sourceFile.length <= 200
}

export async function executeReko(input: ToolExecutionInput): Promise<ToolResult> {
  const base = { toolId: rekoManifest.id, capabilities: rekoManifest.capabilities, produced: rekoManifest.produces }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Reko requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_REKO_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Reko analyzer is not configured' }
  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_REKO_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `Reko analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isRekoResponse(payload)) throw new Error('Reko analyzer returned invalid provenance')
    const expectedPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, expectedPrefix))
    if (!units.length) throw new Error('Reko did not produce any viewable C-like pseudocode')

    const observations: ToolObservation[] = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: codeUnitKey(input.artifactId!, input.taskId!, unit.address),
      label: unit.name,
      attributes: {
        unitType: 'function',
        ...(nativeFunctionIdentity(input.artifactId!, unit.address) ? { identity: nativeFunctionIdentity(input.artifactId!, unit.address)! } : {}),
        name: unit.name,
        qualifiedName: unit.name,
        address: unit.address,
        relativePath: unit.relativePath,
        sizeBytes: unit.sizeBytes,
        language: 'C',
        representation: 'pseudocode',
        representationSemantics: 'Reko-generated C-like reconstruction of native code. It is provider evidence, not verified original-language source, maintainable code, or proof of behavior.',
        decompiler: 'Reko',
        decompilerVersion: payload.toolVersion,
        providerRevision: payload.providerRevision,
        inputArtifactSha256: payload.sourceSha256.toLowerCase(),
        ...(typeof input.targetProfile.architecture === 'string' && input.targetProfile.architecture
          ? { architecture: input.targetProfile.architecture.slice(0, 128) } : {}),
        codeArtifactSha256: unit.outputSha256.toLowerCase(),
        decompiledSourceSha256: unit.outputSha256.toLowerCase(),
        codeArtifactId: unit.codeArtifactId,
        rekoSegmentFile: unit.sourceFile,
        experimentalPseudocode: true,
      },
    }))

    return {
      status: 'completed',
      ...base,
      data: {
        functionCount: payload.functionCount,
        returnedFunctionCount: units.length,
        failedFunctionCount: payload.failedFunctionCount,
        truncated: payload.truncated || payload.functionCount > units.length || payload.units.length > units.length,
        sourceSha256: payload.sourceSha256.toLowerCase(),
        providerRevision: payload.providerRevision,
        rekoVersion: payload.toolVersion,
        outputBytes: payload.outputBytes,
        elapsedMs: payload.elapsedMs,
        semantics: 'Reko emits a C-like native reconstruction; the output is alternate reverse-engineering evidence, not recovered source or proof of behavior.',
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const rekoPlugin: ToolPlugin = { manifest: rekoManifest, analyze: executeReko }
