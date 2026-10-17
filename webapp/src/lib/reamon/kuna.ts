import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'
import { nativeFunctionIdentity } from './native-function-identity'

const KUNA_VERSION = '1.878'
const KUNA_COMMIT = 'cb68db18fc8bbe5c117059bde45031c470c725dd'
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_UNITS = 500
const MAX_CALLS = 10_000

interface KunaUnit {
  name: string
  address: string
  kind: string
  signature: string
  relativePath: string
  codeArtifactId: string
  sizeBytes: number
  outputSha256: string
  instructionSizeBytes: number
  instructionMnemonics?: string[]
  assemblyRelativePath?: string
  assemblyArtifactId?: string
  assemblySizeBytes?: number
  assemblySha256?: string
}

interface KunaCall {
  fromAddress: string
  toAddress: string
  fromName: string
  toName: string
  kind: 'call' | 'jump' | 'data'
}

interface KunaResponse {
  status: 'completed'
  toolVersion: typeof KUNA_VERSION
  providerRevision: typeof KUNA_COMMIT
  sourceSha256: string
  functionCount: number
  returnedUnits: number
  failedFunctionCount: number
  truncated: boolean
  outputBytes: number
  units: KunaUnit[]
  calls: KunaCall[]
  warnings?: string
}

export const kunaManifest: ToolPluginManifest = {
  id: 'reamon-kuna',
  name: 'Kuna Native Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'FunctionAddress', 'CallGraph', 'Disassembly', 'Relationship'],
  requirements: [
    { key: 'service', value: 'Kuna isolated analyzer' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function codeUnitKey(artifactId: string, taskId: string, address: string): string {
  return `kuna:function:${createHash('sha256').update(`${artifactId}:${taskId}:${address}`).digest('hex').slice(0, 32)}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Kuna analysis failed'
}

function isKunaResponse(value: unknown): value is KunaResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units) && Array.isArray(record.calls)
    && record.toolVersion === KUNA_VERSION && record.providerRevision === KUNA_COMMIT
    && typeof record.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sourceSha256)
    && Number.isSafeInteger(record.functionCount) && Number.isSafeInteger(record.returnedUnits)
    && Number.isSafeInteger(record.failedFunctionCount) && typeof record.truncated === 'boolean'
    && Number.isSafeInteger(record.outputBytes)
}

function validUnit(unit: unknown, expectedPrefix: string): unit is KunaUnit {
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return false
  const record = unit as Record<string, unknown>
  const address = typeof record.address === 'string' && /^0x[0-9a-f]{1,32}$/i.test(record.address)
  const base = typeof record.name === 'string' && record.name.length > 0 && record.name.length <= 500
    && address && typeof record.kind === 'string' && ['normal', 'thunk'].includes(record.kind)
    && typeof record.signature === 'string' && record.signature.length <= 2000
    && typeof record.relativePath === 'string' && /^functions\/[0-9a-f]+\.c$/i.test(record.relativePath)
    && typeof record.codeArtifactId === 'string' && record.codeArtifactId === `${expectedPrefix}${record.relativePath}` && record.codeArtifactId.length <= 2000
    && typeof record.sizeBytes === 'number' && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes > 0 && record.sizeBytes <= 2 * 1024 * 1024
    && typeof record.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.outputSha256)
    && typeof record.instructionSizeBytes === 'number' && Number.isSafeInteger(record.instructionSizeBytes) && record.instructionSizeBytes >= 0
    && (record.instructionMnemonics === undefined || (Array.isArray(record.instructionMnemonics)
      && record.instructionMnemonics.length <= 800
      && record.instructionMnemonics.every((mnemonic) => typeof mnemonic === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,31}$/.test(mnemonic))))
  if (!base) return false
  if (record.assemblyRelativePath !== undefined) {
    return typeof record.assemblyRelativePath === 'string' && /^assembly\/[0-9a-f]+\.asm$/i.test(record.assemblyRelativePath)
      && typeof record.assemblyArtifactId === 'string' && record.assemblyArtifactId === `${expectedPrefix}${record.assemblyRelativePath}` && record.assemblyArtifactId.length <= 2000
      && typeof record.assemblySizeBytes === 'number' && Number.isSafeInteger(record.assemblySizeBytes) && record.assemblySizeBytes > 0 && record.assemblySizeBytes <= 4 * 1024 * 1024
      && typeof record.assemblySha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.assemblySha256)
  }
  return true
}

export async function executeKuna(input: ToolExecutionInput): Promise<ToolResult> {
  const base = { toolId: kunaManifest.id, capabilities: kunaManifest.capabilities, produced: kunaManifest.produces }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Kuna requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_KUNA_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Kuna analyzer is not configured' }
  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_KUNA_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `Kuna analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isKunaResponse(payload)) throw new Error('Kuna analyzer returned invalid provenance')
    const expectedPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, expectedPrefix))
    if (!units.length) throw new Error('Kuna did not produce any viewable C-like pseudocode')
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
        sizeBytes: unit.instructionSizeBytes,
        language: 'C',
        representation: 'pseudocode',
        representationSemantics: 'Kuna C-like reconstruction for native machine code. The original source language is not established, and this output is not verified maintained source or behaviorally equivalent code.',
        decompiler: 'Kuna',
        decompilerVersion: payload.toolVersion,
        providerRevision: payload.providerRevision,
        inputArtifactSha256: payload.sourceSha256.toLowerCase(),
        ...(typeof input.targetProfile.architecture === 'string' && input.targetProfile.architecture
          ? { architecture: input.targetProfile.architecture.slice(0, 128) } : {}),
        codeArtifactSha256: unit.outputSha256.toLowerCase(),
        decompiledSourceSha256: unit.outputSha256.toLowerCase(),
        codeArtifactId: unit.codeArtifactId,
        ...(unit.assemblyArtifactId ? { disassemblyArtifactId: unit.assemblyArtifactId } : {}),
        ...(unit.assemblyRelativePath ? { assemblyRelativePath: unit.assemblyRelativePath } : {}),
        ...(unit.instructionMnemonics?.length ? { instructionMnemonics: JSON.stringify(unit.instructionMnemonics) } : {}),
        ...(unit.signature ? { prototype: unit.signature } : {}),
        kunaFunctionKind: unit.kind,
        experimentalPseudocode: true,
      },
    }))

    const addressToUnit = new Map(units.map((unit) => [unit.address.toLowerCase(), unit]))
    const seenEdges = new Set<string>()
    let callCount = 0
    for (const edge of payload.calls.slice(0, MAX_CALLS)) {
      if (!edge || !['call', 'jump', 'data'].includes(edge.kind)
          || typeof edge.fromAddress !== 'string' || typeof edge.toAddress !== 'string'
          || typeof edge.fromName !== 'string' || typeof edge.toName !== 'string'
          || edge.fromName.length > 500 || edge.toName.length > 500) continue
      const fromUnit = addressToUnit.get(edge.fromAddress.toLowerCase())
      const toUnit = addressToUnit.get(edge.toAddress.toLowerCase())
      if (!fromUnit || !toUnit) continue
      const identity = `${edge.fromAddress}->${edge.toAddress}:${edge.kind}`
      if (seenEdges.has(identity)) continue
      seenEdges.add(identity)
      callCount += 1
      observations.push({
        kind: 'relationship',
        type: edge.kind === 'call' ? 'calls' : edge.kind === 'jump' ? 'tail_calls' : 'references_function',
        relation: edge.kind === 'call' ? 'calls' : edge.kind === 'jump' ? 'tail_calls' : 'references',
        key: `kuna:edge:${createHash('sha256').update(`${input.artifactId}:${identity}`).digest('hex').slice(0, 32)}`,
        fromKey: codeUnitKey(input.artifactId!, input.taskId!, fromUnit.address),
        toKey: codeUnitKey(input.artifactId!, input.taskId!, toUnit.address),
        label: `${edge.fromName} ${edge.kind === 'call' ? 'calls' : edge.kind === 'jump' ? 'jumps to' : 'references'} ${edge.toName}`.slice(0, 500),
        attributes: { fromAddress: edge.fromAddress, toAddress: edge.toAddress, providerEdgeKind: edge.kind },
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
        truncated: payload.truncated || payload.functionCount > units.length || payload.units.length > units.length,
        sourceSha256: payload.sourceSha256.toLowerCase(),
        providerRevision: payload.providerRevision,
        kunaVersion: payload.toolVersion,
        outputBytes: payload.outputBytes,
        warnings: typeof payload.warnings === 'string' ? payload.warnings.slice(0, 12_000) : '',
        semantics: 'Kuna-generated C-like pseudocode and recovered native relationships. This provider output is not verified original source or proof of behavior.',
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const kunaPlugin: ToolPlugin = { manifest: kunaManifest, analyze: executeKuna }
