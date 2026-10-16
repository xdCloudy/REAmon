import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_UNITS = 500
const MAX_CALLS = 1000

interface OxidizerUnit {
  name: string
  address: string
  relativePath: string
  codeArtifactId: string
  sizeBytes: number
}

interface OxidizerCall {
  fromAddress: string
  toAddress: string
  fromName: string
  toName: string
}

interface OxidizerResponse {
  status: 'completed'
  toolVersion: string
  providerRevision: string
  rustcVersion: string
  sourceSha256: string
  functionCount: number
  returnedUnits: number
  failedFunctionCount: number
  truncated: boolean
  outputBytes: number
  units: OxidizerUnit[]
  calls?: OxidizerCall[]
  warnings?: string
}

export const oxidizerManifest: ToolPluginManifest = {
  id: 'reamon-oxidizer',
  name: 'Oxidizer Rust Pseudocode',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'FunctionAddress', 'CallGraph', 'Relationship'],
  requirements: [
    { key: 'service', value: 'Oxidizer isolated analyzer container' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function codeUnitKey(artifactId: string, taskId: string, address: string): string {
  return `oxidizer:function:${createHash('sha256').update(`${artifactId}:${taskId}:${address}`).digest('hex').slice(0, 32)}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Oxidizer analysis failed'
}

function isOxidizerResponse(value: unknown): value is OxidizerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
    && typeof record.toolVersion === 'string' && record.toolVersion.length <= 128
    && record.providerRevision === 'angr-10.0.4'
    && typeof record.rustcVersion === 'string' && record.rustcVersion.length > 0 && record.rustcVersion.length <= 64
    && typeof record.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sourceSha256)
    && Number.isSafeInteger(record.functionCount) && Number.isSafeInteger(record.returnedUnits)
    && Number.isSafeInteger(record.failedFunctionCount) && typeof record.truncated === 'boolean'
    && Number.isSafeInteger(record.outputBytes)
}

function validUnit(unit: unknown, expectedPrefix: string): unit is OxidizerUnit {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return false
  const record = unit as Record<string, unknown>
  return typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 500
    && typeof record.address === 'string' && /^0x[0-9a-f]{1,32}$/i.test(record.address)
    && typeof record.relativePath === 'string' && /^functions\/[0-9a-f]+\.rs$/i.test(record.relativePath)
    && typeof record.codeArtifactId === 'string' && record.codeArtifactId.startsWith(expectedPrefix)
      && record.codeArtifactId.length <= 2000
    && typeof record.sizeBytes === 'number' && Number.isSafeInteger(record.sizeBytes)
      && record.sizeBytes > 0 && record.sizeBytes <= 1024 * 1024
}

export async function executeOxidizer(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: oxidizerManifest.id,
    capabilities: oxidizerManifest.capabilities,
    produced: oxidizerManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Oxidizer requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_OXIDIZER_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Oxidizer analyzer is not configured' }
  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_OXIDIZER_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `Oxidizer analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isOxidizerResponse(payload)) throw new Error('Oxidizer analyzer returned an invalid result')

    const expectedPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/functions/`
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, expectedPrefix))
    if (!units.length) throw new Error('Oxidizer did not produce any viewable Rust pseudocode')
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
        language: 'rust',
        sourceLanguage: 'Rust',
        representation: 'pseudocode',
        decompiler: 'Oxidizer',
        sourceSha256: payload.sourceSha256,
        providerRevision: payload.providerRevision,
        rustcVersion: payload.rustcVersion,
        decompiled: true,
        codeArtifactId: unit.codeArtifactId,
      },
    })) as ToolObservation[]

    const addressToKey = new Map(units.map((unit) => [unit.address, codeUnitKey(input.artifactId!, input.taskId!, unit.address)]))
    const seenCalls = new Set<string>()
    let callCount = 0
    for (const call of (Array.isArray(payload.calls) ? payload.calls : []).slice(0, MAX_CALLS)) {
      if (!call || typeof call.fromAddress !== 'string' || typeof call.toAddress !== 'string'
          || typeof call.fromName !== 'string' || typeof call.toName !== 'string'
          || call.fromName.length > 500 || call.toName.length > 500) continue
      const fromKey = addressToKey.get(call.fromAddress)
      const toKey = addressToKey.get(call.toAddress)
      if (!fromKey || !toKey) continue
      const identity = `${call.fromAddress}->${call.toAddress}`
      if (seenCalls.has(identity)) continue
      seenCalls.add(identity)
      callCount += 1
      observations.push({
        kind: 'relationship',
        type: 'calls',
        relation: 'calls',
        key: `oxidizer:call:${createHash('sha256').update(`${input.artifactId}:${identity}`).digest('hex').slice(0, 32)}`,
        fromKey,
        toKey,
        label: `${call.fromName} calls ${call.toName}`.slice(0, 500),
        attributes: { fromAddress: call.fromAddress, toAddress: call.toAddress },
      })
    }

    return {
      status: 'completed',
      ...base,
      data: {
        decompiledFunctionCount: payload.functionCount,
        returnedFunctionCount: units.length,
        failedFunctionCount: payload.failedFunctionCount,
        callCount,
        truncated: payload.truncated || payload.functionCount > units.length,
        sourceSha256: payload.sourceSha256,
        providerRevision: payload.providerRevision,
        rustcVersion: payload.rustcVersion,
        oxidizerVersion: payload.toolVersion,
        outputBytes: payload.outputBytes,
        warnings: typeof payload.warnings === 'string' ? payload.warnings.slice(0, 12000) : '',
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const oxidizerPlugin: ToolPlugin = { manifest: oxidizerManifest, analyze: executeOxidizer }
