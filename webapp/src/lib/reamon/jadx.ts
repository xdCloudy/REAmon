import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_UNITS = 100000
const MAX_CALL_EDGES = 400
const MAX_METHOD_FEATURES = 8_000
const DEFAULT_TIMEOUT_MS = 20 * 60_000

interface JadxResponse {
  status: 'completed'
  toolVersion: string
  artifactSha256?: string
  apktoolVersion?: string | null
  apktoolProjectPath?: string | null
  apktoolProjectBytes?: number
  classCount: number | null
  resourceCount?: number | null
  discoveredCodeUnitCount?: number | null
  returnedCodeUnitCount?: number
  codeBytes?: number
  returnedUnits: number
  truncated: boolean
  units: Array<{ name: string; relativePath: string; codeArtifactId: string; disassemblyArtifactId?: string; disassemblyLanguage?: string; unitType?: string; language?: string; sizeBytes: number; outputSha256?: string; classReferences?: string[] }>
  calls?: Array<{ fromRelativePath: string; toRelativePath: string; fromSignature: string; toSignature: string }>
  callGraphTruncated?: boolean
  methods?: Array<{ signature: string; relativePath: string; instructionMnemonics: string[] }>
  methodFeaturesTruncated?: boolean
  warnings?: string
}

export const jadxManifest: ToolPluginManifest = {
  id: 'reamon-jadx',
  name: 'JADX and Apktool Android Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['apk', 'jar', 'dex', 'class'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'DexDisassembly', 'AndroidManifest', 'AndroidResource', 'CallGraph', 'Relationship'],
  requirements: [
    { key: 'service', value: 'JADX isolated analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'JADX analysis failed'
}

function codeUnitKey(input: ToolExecutionInput, relativePath: string, unitType = 'class'): string {
  return `jadx:${unitType}:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${relativePath}`).digest('hex').slice(0, 32)}`
}

function methodKey(input: ToolExecutionInput, signature: string): string {
  return `jadx:method:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${signature}`).digest('hex').slice(0, 32)}`
}

function methodLabel(signature: string): string {
  return signature.replace(/^L([^;]+);->/, '$1.').replaceAll('/', '.')
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function isJadxResponse(value: unknown): value is JadxResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
}

export async function executeJadx(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: jadxManifest.id,
    capabilities: jadxManifest.capabilities,
    produced: jadxManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'JADX requires a stored supported bytecode artifact and task context' }
  }

  const baseUrl = process.env.REAMON_JADX_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated JADX analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_JADX_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `JADX analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isJadxResponse(payload)) throw new Error('JADX analyzer returned an invalid result')

    const units = payload.units.slice(0, MAX_UNITS).filter((unit) =>
      unit && typeof unit.name === 'string' && typeof unit.relativePath === 'string'
      && typeof unit.codeArtifactId === 'string' && Number.isFinite(unit.sizeBytes) && unit.sizeBytes > 0
      && (unit.disassemblyArtifactId === undefined || typeof unit.disassemblyArtifactId === 'string')
      && (unit.disassemblyLanguage === undefined || typeof unit.disassemblyLanguage === 'string')
      && (unit.unitType === undefined || typeof unit.unitType === 'string')
      && (unit.language === undefined || typeof unit.language === 'string')
      && (unit.outputSha256 === undefined || (typeof unit.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(unit.outputSha256)))
      && (unit.classReferences === undefined || (Array.isArray(unit.classReferences) && unit.classReferences.length <= 100 && unit.classReferences.every((name) => typeof name === 'string' && name.length <= 500))))
    if (!units.length) throw new Error('JADX and Apktool did not produce any viewable code or Android resources')

    const observations: ToolObservation[] = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: codeUnitKey(input, unit.relativePath, unit.unitType || 'class'),
      label: unit.name,
      attributes: {
        unitType: (unit.unitType || 'class').slice(0, 80),
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        sizeBytes: Math.floor(unit.sizeBytes),
        language: (unit.language || 'Java').slice(0, 80),
        relativePath: unit.relativePath.slice(0, 1000),
        decompiled: true,
        codeArtifactId: unit.codeArtifactId.slice(0, 2000),
        ...(typeof payload.artifactSha256 === 'string' && /^[a-f0-9]{64}$/i.test(payload.artifactSha256)
          ? { inputArtifactSha256: payload.artifactSha256.toLowerCase() }
          : {}),
        ...(typeof unit.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(unit.outputSha256)
          ? { decompiledSourceSha256: unit.outputSha256.toLowerCase() }
          : {}),
        ...(unit.disassemblyArtifactId ? { disassemblyArtifactId: unit.disassemblyArtifactId.slice(0, 2000) } : {}),
        ...(unit.disassemblyLanguage ? { disassemblyLanguage: unit.disassemblyLanguage.slice(0, 80) } : {}),
        ...(unit.classReferences?.length ? { classReferences: JSON.stringify(unit.classReferences) } : {}),
      },
    }))
    const unitsByPath = new Map(units.map((unit) => [unit.relativePath, unit]))
    const methodNodeKeys = new Set<string>()
    const seenCalls = new Set<string>()
    let callGraphTruncated = payload.callGraphTruncated === true || (payload.calls?.length || 0) > MAX_CALL_EDGES
    const calls = (Array.isArray(payload.calls) ? payload.calls : []).slice(0, MAX_CALL_EDGES)
    const methods = (Array.isArray(payload.methods) ? payload.methods : []).slice(0, MAX_METHOD_FEATURES).filter((method) =>
      method && typeof method.signature === 'string' && method.signature.length <= 1000
      && typeof method.relativePath === 'string' && method.relativePath.length <= 1000
      && Array.isArray(method.instructionMnemonics) && method.instructionMnemonics.length <= 128
      && method.instructionMnemonics.every((mnemonic) => typeof mnemonic === 'string' && /^[A-Za-z][A-Za-z0-9_./-]{0,31}$/.test(mnemonic)))
    let methodObservationsTruncated = (payload.methods?.length || 0) > MAX_METHOD_FEATURES
    const addMethodNode = (signature: string, relativePath: string, mnemonics?: string[]) => {
      const key = methodKey(input, signature)
      if (methodNodeKeys.has(key)) return key
      const unit = unitsByPath.get(relativePath)
      const label = methodLabel(signature).slice(0, 500)
      observations.push({
        kind: 'entity',
        type: 'function',
        key,
        label,
        attributes: {
          identity: `${input.artifactId}:${signature}`,
          unitType: 'function',
          name: label,
          qualifiedName: label,
          address: signature.slice(0, 1000),
          language: unit?.language || 'Java',
          instructionLanguage: 'Smali',
          ...(unit ? {
            parentCodeUnitKey: codeUnitKey(input, unit.relativePath, unit.unitType || 'class'),
            relativePath: unit.relativePath.slice(0, 1000),
            codeArtifactId: unit.codeArtifactId.slice(0, 2000),
            ...(unit.disassemblyArtifactId ? {
              disassemblyArtifactId: unit.disassemblyArtifactId.slice(0, 2000),
              disassemblyLanguage: (unit.disassemblyLanguage || 'Smali').slice(0, 80),
            } : {}),
          } : {}),
          ...(mnemonics?.length ? { instructionMnemonics: JSON.stringify(mnemonics.slice(0, 128)) } : {}),
          externalOrUndecompiled: !unit,
        },
      })
      methodNodeKeys.add(key)
      return key
    }
    for (const method of methods) {
      if (!unitsByPath.has(method.relativePath)) {
        methodObservationsTruncated = true
        continue
      }
      if (observations.length >= MAX_UNITS) {
        methodObservationsTruncated = true
        break
      }
      addMethodNode(method.signature, method.relativePath, method.instructionMnemonics)
    }
    for (const call of calls) {
      if (!call || typeof call.fromRelativePath !== 'string' || typeof call.toRelativePath !== 'string'
          || typeof call.fromSignature !== 'string' || typeof call.toSignature !== 'string'
          || call.fromSignature.length > 1000 || call.toSignature.length > 1000
          || !unitsByPath.has(call.fromRelativePath)) continue
      const edgeIdentity = `${call.fromSignature}->${call.toSignature}`
      if (seenCalls.has(edgeIdentity)) continue
      const fromKey = methodKey(input, call.fromSignature)
      const toKey = methodKey(input, call.toSignature)
      const fromUnit = unitsByPath.get(call.fromRelativePath)
      const toUnit = call.toRelativePath ? unitsByPath.get(call.toRelativePath) : undefined
      const additionalNodes = Number(!methodNodeKeys.has(fromKey)) + Number(!methodNodeKeys.has(toKey))
      if (observations.length + additionalNodes + 1 > MAX_UNITS) {
        callGraphTruncated = true
        break
      }
      seenCalls.add(edgeIdentity)
      addMethodNode(call.fromSignature, call.fromRelativePath)
      addMethodNode(call.toSignature, call.toRelativePath)
      const digest = createHash('sha256').update(`${input.artifactId}:${call.fromSignature}->${call.toSignature}`).digest('hex').slice(0, 32)
      observations.push({
        kind: 'relationship',
        type: 'calls',
        relation: 'calls',
        key: `jadx:call:${digest}`,
        fromKey,
        toKey,
        label: `${methodLabel(call.fromSignature)} calls ${methodLabel(call.toSignature)}`.slice(0, 500),
        attributes: {
          fromSignature: call.fromSignature,
          toSignature: call.toSignature,
          ...(fromUnit ? { fromCodeUnitKey: codeUnitKey(input, fromUnit.relativePath, fromUnit.unitType || 'class') } : {}),
          ...(toUnit ? { toCodeUnitKey: codeUnitKey(input, toUnit.relativePath, toUnit.unitType || 'class') } : {}),
        },
      })
    }
    const returnedClassCount = units.filter((unit) => unit.unitType !== 'resource').length
    const returnedResourceCount = units.length - returnedClassCount
    const discoveredCodeUnitCount = typeof payload.discoveredCodeUnitCount === 'number' && Number.isSafeInteger(payload.discoveredCodeUnitCount) && payload.discoveredCodeUnitCount >= 0
      ? payload.discoveredCodeUnitCount
      : payload.classCount !== null && typeof payload.resourceCount === 'number' ? payload.classCount + payload.resourceCount : null
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        decompiledClassCount: typeof payload.classCount === 'number' && Number.isSafeInteger(payload.classCount) && payload.classCount >= 0 ? payload.classCount : null,
        decompiledResourceCount: typeof payload.resourceCount === 'number' && Number.isSafeInteger(payload.resourceCount) && payload.resourceCount >= 0 ? payload.resourceCount : null,
        decompiledCodeUnitCount: discoveredCodeUnitCount,
        returnedClassCount,
        returnedResourceCount,
        returnedCodeUnitCount: units.length,
        codeBytes: typeof payload.codeBytes === 'number' && Number.isFinite(payload.codeBytes) ? Math.max(0, Math.floor(payload.codeBytes)) : units.reduce((sum, unit) => sum + Math.floor(unit.sizeBytes), 0),
        truncated: payload.truncated || callGraphTruncated || payload.methodFeaturesTruncated === true || methodObservationsTruncated || (discoveredCodeUnitCount !== null && discoveredCodeUnitCount > units.length)
          || (payload.classCount !== null && payload.classCount > returnedClassCount),
        callCount: seenCalls.size,
        callGraphTruncated,
        jadxVersion: payload.toolVersion,
        apktoolVersion: payload.apktoolVersion || null,
        apktoolProjectPath: typeof payload.apktoolProjectPath === 'string' ? payload.apktoolProjectPath.slice(0, 2000) : null,
        apktoolProjectBytes: typeof payload.apktoolProjectBytes === 'number' && Number.isSafeInteger(payload.apktoolProjectBytes) && payload.apktoolProjectBytes >= 0
          ? payload.apktoolProjectBytes : 0,
        warnings: payload.warnings?.slice(0, 4000) || '',
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const jadxPlugin: ToolPlugin = { manifest: jadxManifest, analyze: executeJadx }
