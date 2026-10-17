import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_UNITS = 500
const MAX_WARNINGS = 12_000

interface GlaurungUnit {
  name: string
  address: string
  relativePath: string
  codeArtifactId: string
  sizeBytes: number
  outputSha256: string
}

interface GlaurungResponse {
  status: 'completed'
  toolVersion: string
  providerRevision: string
  sourceSha256: string
  functionCount: number
  returnedUnits: number
  failedFunctionCount: number
  truncated: boolean
  outputBytes: number
  units: GlaurungUnit[]
  warnings?: string
}

export const glaurungManifest: ToolPluginManifest = {
  id: 'reamon-glaurung',
  name: 'Glaurung Native Pseudocode',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'FunctionAddress'],
  requirements: [
    { key: 'service', value: 'Glaurung isolated analyzer' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function codeUnitKey(artifactId: string, taskId: string, address: string): string {
  return `glaurung:function:${createHash('sha256').update(`${artifactId}:${taskId}:${address}`).digest('hex').slice(0, 32)}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Glaurung analysis failed'
}

function isGlaurungResponse(value: unknown): value is GlaurungResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
    && typeof record.toolVersion === 'string' && record.toolVersion.length <= 128
    && record.providerRevision === '8980d4e32dea59ad85f4c3d685c1b43762fd329e'
    && typeof record.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sourceSha256)
    && Number.isSafeInteger(record.functionCount) && Number.isSafeInteger(record.returnedUnits)
    && Number.isSafeInteger(record.failedFunctionCount) && typeof record.truncated === 'boolean'
    && Number.isSafeInteger(record.outputBytes)
}

function validUnit(unit: unknown, expectedPrefix: string): unit is GlaurungUnit {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return false
  const record = unit as Record<string, unknown>
  return typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 500
    && typeof record.address === 'string' && /^0x[0-9a-f]{1,32}$/i.test(record.address)
    && typeof record.relativePath === 'string' && /^functions\/[0-9a-f]+\.c$/i.test(record.relativePath)
    && typeof record.codeArtifactId === 'string' && record.codeArtifactId.startsWith(expectedPrefix)
      && record.codeArtifactId.length <= 2000
    && typeof record.sizeBytes === 'number' && Number.isSafeInteger(record.sizeBytes)
      && record.sizeBytes > 0 && record.sizeBytes <= 1024 * 1024
    && typeof record.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.outputSha256)
}

export async function executeGlaurung(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: glaurungManifest.id,
    capabilities: glaurungManifest.capabilities,
    produced: glaurungManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Glaurung requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_GLAURUNG_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Glaurung analyzer is not configured' }
  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_GLAURUNG_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `Glaurung analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isGlaurungResponse(payload)) throw new Error('Glaurung analyzer returned invalid provenance')

    const expectedPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/functions/`
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, expectedPrefix))
    if (!units.length) throw new Error('Glaurung did not produce any viewable pseudocode')
    const observations = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: codeUnitKey(input.artifactId!, input.taskId!, unit.address),
      label: unit.name.slice(0, 500),
      attributes: {
        unitType: 'function',
        identity: `${input.artifactId}:${unit.address}`,
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        address: unit.address,
        relativePath: unit.relativePath,
        sizeBytes: unit.sizeBytes,
        language: 'C',
        representation: 'pseudocode',
        representationSemantics: 'Experimental Glaurung C-like pseudocode for native machine code. The original source language is not established, and this output is not verified maintained source or behaviorally equivalent code.',
        decompiler: 'Glaurung',
        decompilerVersion: payload.toolVersion,
        providerRevision: payload.providerRevision,
        inputArtifactSha256: payload.sourceSha256.toLowerCase(),
        codeArtifactSha256: unit.outputSha256.toLowerCase(),
        codeArtifactId: unit.codeArtifactId,
        experimentalPseudocode: true,
      },
    })) as ToolObservation[]

    return {
      status: 'completed',
      ...base,
      data: {
        decompiledFunctionCount: payload.functionCount,
        returnedFunctionCount: units.length,
        failedFunctionCount: payload.failedFunctionCount,
        truncated: payload.truncated || payload.functionCount > units.length,
        sourceSha256: payload.sourceSha256.toLowerCase(),
        providerRevision: payload.providerRevision,
        glaurungVersion: payload.toolVersion,
        outputBytes: payload.outputBytes,
        warnings: typeof payload.warnings === 'string' ? payload.warnings.slice(0, MAX_WARNINGS) : '',
        semantics: 'Experimental Glaurung C-like pseudocode. This provider output is a reconstructed analysis view, not verified original or behaviorally equivalent source.',
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const glaurungPlugin: ToolPlugin = { manifest: glaurungManifest, analyze: executeGlaurung }
