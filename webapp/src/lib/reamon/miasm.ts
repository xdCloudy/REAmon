import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'
import { nativeFunctionIdentity } from './native-function-identity'

const MIASM_VERSION = '0.1.5'
const MIASM_COMMIT = '3671fc24d6e625c2d75f3311724eb6b0c97664f8'
const DEFAULT_TIMEOUT_MS = 6 * 60_000
const MAX_UNITS = 200

interface MiasmUnit {
  name: string
  address: string
  relativePath: string
  codeArtifactId: string
  sizeBytes: number
  outputSha256: string
  blockCountBeforeSimplification: number
  blockCountAfterSimplification: number
  instructionCount: number
  truncated: boolean
}

interface MiasmResponse {
  status: 'completed'
  toolVersion: typeof MIASM_VERSION
  providerRevision: typeof MIASM_COMMIT
  sourceSha256: string
  architecture: string
  functionCount: number
  returnedUnits: number
  failedFunctionCount: number
  truncated: boolean
  outputBytes: number
  units: MiasmUnit[]
  warnings?: string
  semantics: string
}

export const miasmManifest: ToolPluginManifest = {
  id: 'reamon-miasm',
  name: 'Miasm Native Deobfuscation Evidence',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'IntermediateRepresentation', 'FunctionAddress'],
  requirements: [
    { key: 'service', value: 'Miasm isolated analyzer' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function codeUnitKey(artifactId: string, taskId: string, address: string): string {
  return `miasm:function:${createHash('sha256').update(`${artifactId}:${taskId}:${address}`).digest('hex').slice(0, 32)}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Miasm analysis failed'
}

function isMiasmResponse(value: unknown): value is MiasmResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
    && record.toolVersion === MIASM_VERSION && record.providerRevision === MIASM_COMMIT
    && typeof record.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sourceSha256)
    && typeof record.architecture === 'string' && record.architecture.length > 0 && record.architecture.length <= 64
    && typeof record.functionCount === 'number' && Number.isSafeInteger(record.functionCount) && record.functionCount >= 0
    && typeof record.returnedUnits === 'number' && Number.isSafeInteger(record.returnedUnits) && record.returnedUnits >= 0
    && typeof record.failedFunctionCount === 'number' && Number.isSafeInteger(record.failedFunctionCount) && record.failedFunctionCount >= 0
    && typeof record.truncated === 'boolean'
    && typeof record.outputBytes === 'number' && Number.isSafeInteger(record.outputBytes) && record.outputBytes >= 0
    && typeof record.semantics === 'string' && record.semantics.length <= 2000
}

function validUnit(unit: unknown, expectedPrefix: string): unit is MiasmUnit {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return false
  const record = unit as Record<string, unknown>
  return typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 500
    && typeof record.address === 'string' && /^0x[0-9a-f]{1,16}$/i.test(record.address)
    && typeof record.relativePath === 'string' && /^functions\/[0-9a-f]+\.ir$/i.test(record.relativePath)
    && typeof record.codeArtifactId === 'string'
      && record.codeArtifactId === `${expectedPrefix}${record.relativePath}` && record.codeArtifactId.length <= 2000
    && typeof record.sizeBytes === 'number' && Number.isSafeInteger(record.sizeBytes)
      && record.sizeBytes > 0 && record.sizeBytes <= 512 * 1024
    && typeof record.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.outputSha256)
    && typeof record.blockCountBeforeSimplification === 'number'
      && Number.isSafeInteger(record.blockCountBeforeSimplification) && record.blockCountBeforeSimplification >= 0
    && typeof record.blockCountAfterSimplification === 'number'
      && Number.isSafeInteger(record.blockCountAfterSimplification) && record.blockCountAfterSimplification >= 0
    && typeof record.instructionCount === 'number' && Number.isSafeInteger(record.instructionCount)
      && record.instructionCount > 0 && record.instructionCount <= 1_000_000
    && typeof record.truncated === 'boolean'
}

export async function executeMiasm(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: miasmManifest.id,
    capabilities: miasmManifest.capabilities,
    produced: miasmManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Miasm requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_MIASM_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Miasm analyzer is not configured' }
  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_MIASM_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 15 * 60_000))
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
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1200)
        : `Miasm analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isMiasmResponse(payload)) throw new Error('Miasm analyzer returned invalid provenance')

    const expectedPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, expectedPrefix))
    if (!units.length) throw new Error('Miasm did not produce any viewable intermediate representation')
    const observations: ToolObservation[] = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: codeUnitKey(input.artifactId!, input.taskId!, unit.address),
      label: unit.name.slice(0, 500),
      attributes: {
        unitType: 'function',
        ...(nativeFunctionIdentity(input.artifactId!, unit.address)
          ? { identity: nativeFunctionIdentity(input.artifactId!, unit.address)! } : {}),
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        address: unit.address,
        relativePath: unit.relativePath,
        sizeBytes: unit.sizeBytes,
        language: 'Miasm IR',
        representation: 'simplified intermediate representation',
        representationSemantics: payload.semantics,
        decompiler: 'Miasm',
        decompilerVersion: payload.toolVersion,
        providerRevision: payload.providerRevision,
        inputArtifactSha256: payload.sourceSha256.toLowerCase(),
        codeArtifactSha256: unit.outputSha256.toLowerCase(),
        decompiledSourceSha256: unit.outputSha256.toLowerCase(),
        codeArtifactId: unit.codeArtifactId,
        miasmArchitecture: payload.architecture,
        miasmBlockCountBeforeSimplification: unit.blockCountBeforeSimplification,
        miasmBlockCountAfterSimplification: unit.blockCountAfterSimplification,
        miasmInstructionCount: unit.instructionCount,
        miasmTruncated: unit.truncated,
        ...(nativeFunctionIdentity(input.artifactId!, unit.address)
          ? { identityEvidence: 'native address; exact artifact scoped' } : {}),
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
        miasmVersion: payload.toolVersion,
        architecture: payload.architecture,
        outputBytes: payload.outputBytes,
        warnings: typeof payload.warnings === 'string' ? payload.warnings.slice(0, 12_000) : '',
        semantics: payload.semantics,
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const miasmPlugin: ToolPlugin = { manifest: miasmManifest, analyze: executeMiasm }
