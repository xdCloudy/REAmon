import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'
import { nativeFunctionIdentity } from './native-function-identity'

const RECURSE_VERSION = '0.1.0'
const RECURSE_COMMIT = '34ff28af22e6724d29e100001ef79dfe2a001d15'
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_UNITS = 200

interface RecurseUnit {
  name: string
  address: string
  functionSizeBytes: number
  instructionCount: number
  relativePath: string
  codeArtifactId: string
  sizeBytes: number
  outputSha256: string
  optimized: Record<string, number>
}

interface RecurseResponse {
  status: 'completed'
  toolVersion: typeof RECURSE_VERSION
  providerRevision: typeof RECURSE_COMMIT
  sourceSha256: string
  functionCount: number
  returnedUnits: number
  failedFunctionCount: number
  truncated: boolean
  outputBytes: number
  units: RecurseUnit[]
  warnings?: string
}

export const recurseManifest: ToolPluginManifest = {
  id: 'reamon-recurse',
  name: 'Recurse Native Lift Evidence',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'IntermediateRepresentation', 'FunctionAddress'],
  requirements: [
    { key: 'service', value: 'Recurse isolated analyzer' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function codeUnitKey(artifactId: string, taskId: string, address: string): string {
  return `recurse:function:${createHash('sha256').update(`${artifactId}:${taskId}:${address}`).digest('hex').slice(0, 32)}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Recurse analysis failed'
}

function isRecurseResponse(value: unknown): value is RecurseResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
    && record.toolVersion === RECURSE_VERSION && record.providerRevision === RECURSE_COMMIT
    && typeof record.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sourceSha256)
    && typeof record.functionCount === 'number' && Number.isSafeInteger(record.functionCount) && record.functionCount >= 0
    && typeof record.returnedUnits === 'number' && Number.isSafeInteger(record.returnedUnits) && record.returnedUnits >= 0
    && typeof record.failedFunctionCount === 'number' && Number.isSafeInteger(record.failedFunctionCount) && record.failedFunctionCount >= 0
    && typeof record.truncated === 'boolean'
    && typeof record.outputBytes === 'number' && Number.isSafeInteger(record.outputBytes) && record.outputBytes >= 0
}

function validUnit(unit: unknown, expectedPrefix: string): unit is RecurseUnit {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return false
  const record = unit as Record<string, unknown>
  return typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 500
    && typeof record.address === 'string' && /^0x[0-9a-f]{1,16}$/i.test(record.address)
    && typeof record.functionSizeBytes === 'number' && Number.isSafeInteger(record.functionSizeBytes)
      && record.functionSizeBytes >= 0 && record.functionSizeBytes <= 512 * 1024 * 1024
    && typeof record.instructionCount === 'number' && Number.isSafeInteger(record.instructionCount)
      && record.instructionCount >= 0 && record.instructionCount <= 1_000_000
    && typeof record.relativePath === 'string' && /^lift\/[0-9a-f]+\.vtil$/i.test(record.relativePath)
    && typeof record.codeArtifactId === 'string' && record.codeArtifactId === `${expectedPrefix}${record.relativePath}`
      && record.codeArtifactId.length <= 2000
    && typeof record.sizeBytes === 'number' && Number.isSafeInteger(record.sizeBytes)
      && record.sizeBytes > 0 && record.sizeBytes <= 256 * 1024
    && typeof record.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.outputSha256)
    && !!record.optimized && typeof record.optimized === 'object' && !Array.isArray(record.optimized)
    && Object.entries(record.optimized).every(([key, value]) => ['rounds', 'propagated', 'folded', 'simplified', 'dead_stores_removed', 'branches_resolved'].includes(key)
      && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000)
}

export async function executeRecurse(input: ToolExecutionInput): Promise<ToolResult> {
  const base = { toolId: recurseManifest.id, capabilities: recurseManifest.capabilities, produced: recurseManifest.produces }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Recurse requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_RECURSE_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Recurse analyzer is not configured' }
  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_RECURSE_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `Recurse analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isRecurseResponse(payload)) throw new Error('Recurse analyzer returned invalid provenance')
    const expectedPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, expectedPrefix))
    if (!units.length) throw new Error('Recurse did not produce any viewable lift evidence')

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
        sizeBytes: Math.max(1, unit.functionSizeBytes || unit.instructionCount),
        sizeEvidence: unit.functionSizeBytes > 0 ? 'native-function-byte-size' : 'instruction-count-fallback',
        language: 'VTIL-style IR',
        representation: 'optimized intermediate representation',
        representationSemantics: 'Recurse VTIL-style intermediate representation lifted from native instructions and optimized for analysis. Its mnemonic semantics are x86/x64-focused; unsupported instructions stay opaque. This is evidence for reverse engineering, not recovered original source, maintainable code, or proof of behavior.',
        decompiler: 'Recurse',
        decompilerVersion: payload.toolVersion,
        providerRevision: payload.providerRevision,
        inputArtifactSha256: payload.sourceSha256.toLowerCase(),
        codeArtifactSha256: unit.outputSha256.toLowerCase(),
        decompiledSourceSha256: unit.outputSha256.toLowerCase(),
        codeArtifactId: unit.codeArtifactId,
        recurseInstructionCount: unit.instructionCount,
        recurseOptimizerPasses: JSON.stringify(unit.optimized).slice(0, 1000),
        ...(typeof input.targetProfile.architecture === 'string' && input.targetProfile.architecture
          ? { architecture: input.targetProfile.architecture.slice(0, 128) } : {}),
        ...(nativeFunctionIdentity(input.artifactId!, unit.address) ? { identityEvidence: 'native address; exact artifact scoped' } : {}),
        experimentalAnalysisEvidence: true,
      },
    }))

    return {
      status: 'completed',
      ...base,
      data: {
        decompiledFunctionCount: payload.functionCount,
        functionCount: payload.functionCount,
        returnedFunctionCount: units.length,
        failedFunctionCount: payload.failedFunctionCount,
        truncated: payload.truncated || payload.functionCount > units.length || payload.units.length > units.length,
        sourceSha256: payload.sourceSha256.toLowerCase(),
        providerRevision: payload.providerRevision,
        recurseVersion: payload.toolVersion,
        outputBytes: payload.outputBytes,
        warnings: typeof payload.warnings === 'string' ? payload.warnings.slice(0, 12_000) : '',
        semantics: 'Recurse provides per-function optimized lift IR as provisional structural analysis evidence. It does not reconstruct the original language or prove behavior.',
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const recursePlugin: ToolPlugin = { manifest: recurseManifest, analyze: executeRecurse }
