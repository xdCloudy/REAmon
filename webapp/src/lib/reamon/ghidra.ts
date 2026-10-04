import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const MAX_UNITS = 2000
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_CALL_EDGES = 400

interface GhidraResponse {
  status: 'completed'
  toolVersion: string
  functionCount: number
  visitedFunctionCount?: number
  failedFunctionCount?: number
  codeBytes?: number
  returnedUnits: number
  truncated: boolean
  units: Array<{ name: string; address: string; relativePath: string; codeArtifactId: string; disassemblyArtifactId?: string; sizeBytes: number }>
  calls?: Array<{ fromAddress: string; toAddress: string; fromName: string; toName: string }>
  callCount?: number
  callGraphTruncated?: boolean
  warnings?: string
}

export const ghidraManifest: ToolPluginManifest = {
  id: 'reamon-ghidra',
  name: 'Ghidra Native Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'FunctionAddress', 'CallGraph', 'Relationship'],
  requirements: [
    { key: 'service', value: 'Ghidra isolated headless analyzer container' },
    { key: 'artifactPath' },
  ],
}

function codeUnitKey(artifactId: string, taskId: string, address: string): string {
  return `ghidra:function:${createHash('sha256').update(`${artifactId}:${taskId}:${address}`).digest('hex').slice(0, 32)}`
}

function graphFunctionKey(artifactId: string, address: string): string {
  return `ghidra:function-target:${createHash('sha256').update(`${artifactId}:${address}`).digest('hex').slice(0, 32)}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Ghidra analysis failed'
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function isGhidraResponse(value: unknown): value is GhidraResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
}

export async function executeGhidra(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: ghidraManifest.id,
    capabilities: ghidraManifest.capabilities,
    produced: ghidraManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Ghidra requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_GHIDRA_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Ghidra analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_GHIDRA_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        ? payload.error.slice(0, 1200)
        : `Ghidra analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isGhidraResponse(payload)) throw new Error('Ghidra analyzer returned an invalid result')

    const units = payload.units.slice(0, MAX_UNITS).filter((unit) =>
      unit && typeof unit.name === 'string' && typeof unit.address === 'string'
      && typeof unit.relativePath === 'string' && typeof unit.codeArtifactId === 'string'
      && Number.isFinite(unit.sizeBytes) && unit.sizeBytes > 0
      && (unit.disassemblyArtifactId === undefined || typeof unit.disassemblyArtifactId === 'string'))
    if (!units.length) throw new Error('Ghidra did not produce any viewable function decompilations')

    const observations = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: codeUnitKey(input.artifactId!, input.taskId!, unit.address),
      label: unit.name,
      attributes: {
        unitType: 'function',
        identity: `${input.artifactId}:${unit.address}`,
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        address: unit.address.slice(0, 128),
        sizeBytes: Math.floor(unit.sizeBytes),
        language: 'C',
        decompiled: true,
        codeArtifactId: unit.codeArtifactId.slice(0, 2000),
        ...(unit.disassemblyArtifactId ? { disassemblyArtifactId: unit.disassemblyArtifactId.slice(0, 2000) } : {}),
      },
    })) as ToolObservation[]
    const unitAddresses = new Set(units.map((unit) => unit.address))
    const functionNodes = new Set<string>()
    const seenEdges = new Set<string>()
    const calls = (Array.isArray(payload.calls) ? payload.calls : []).slice(0, MAX_CALL_EDGES)
    for (const call of calls) {
      if (!call || typeof call.fromAddress !== 'string' || typeof call.toAddress !== 'string'
          || typeof call.fromName !== 'string' || typeof call.toName !== 'string'
          || call.fromAddress.length > 128 || call.toAddress.length > 128
          || call.fromName.length > 500 || call.toName.length > 500
          || !unitAddresses.has(call.fromAddress)) continue
      const edgeIdentity = call.fromAddress + '->' + call.toAddress
      if (seenEdges.has(edgeIdentity)) continue
      seenEdges.add(edgeIdentity)
      const fromKey = codeUnitKey(input.artifactId, input.taskId, call.fromAddress)
      let toKey: string
      if (unitAddresses.has(call.toAddress)) {
        toKey = codeUnitKey(input.artifactId, input.taskId, call.toAddress)
      } else {
        toKey = graphFunctionKey(input.artifactId, call.toAddress)
        if (!functionNodes.has(toKey)) {
          functionNodes.add(toKey)
          observations.push({
            kind: 'entity',
            type: 'function',
            key: toKey,
            label: call.toName.slice(0, 500),
            attributes: {
              identity: `${input.artifactId}:${call.toAddress}`,
              qualifiedName: call.toName.slice(0, 500),
              name: call.toName.slice(0, 500),
              address: call.toAddress,
              language: 'C',
              externalOrUndecompiled: true,
            },
          })
        }
      }
      const edgeDigest = createHash('sha256')
        .update(`${input.artifactId}:${call.fromAddress}:${call.toAddress}`)
        .digest('hex').slice(0, 32)
      observations.push({
        kind: 'relationship',
        type: 'calls',
        relation: 'calls',
        key: `ghidra:call:${edgeDigest}`,
        fromKey,
        toKey,
        label: `${call.fromName} calls ${call.toName}`.slice(0, 500),
        attributes: { fromAddress: call.fromAddress, toAddress: call.toAddress },
      })
    }
    const callGraphTruncated = payload.callGraphTruncated === true || (payload.calls?.length || 0) > MAX_CALL_EDGES
    return {
      status: 'completed',
      ...base,
      data: {
        decompiledFunctionCount: payload.functionCount,
        returnedFunctionCount: units.length,
        callCount: seenEdges.size,
        callGraphTruncated,
        visitedFunctionCount: typeof payload.visitedFunctionCount === 'number' && Number.isFinite(payload.visitedFunctionCount) ? payload.visitedFunctionCount : null,
        failedFunctionCount: typeof payload.failedFunctionCount === 'number' && Number.isFinite(payload.failedFunctionCount) ? payload.failedFunctionCount : null,
        codeBytes: typeof payload.codeBytes === 'number' && Number.isFinite(payload.codeBytes) ? Math.max(0, Math.floor(payload.codeBytes)) : units.reduce((sum, unit) => sum + Math.floor(unit.sizeBytes), 0),
        truncated: payload.truncated || payload.functionCount > units.length || callGraphTruncated,
        ghidraVersion: payload.toolVersion,
        warnings: payload.warnings?.slice(0, 4000) || '',
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const ghidraPlugin: ToolPlugin = { manifest: ghidraManifest, analyze: executeGhidra }
