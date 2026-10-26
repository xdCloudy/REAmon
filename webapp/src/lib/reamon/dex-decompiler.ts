import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'
import { MAX_CODE_UNITS_PER_RESULT } from './result-ingestion'

const MAX_CLASSES = 80_000
const MAX_METHODS = 10_000
const MAX_SIGNATURE_CHARS = 8_000
const MAX_STREAMED_METHODS = 4_200_000
const MAX_STREAMED_EDGES = 4_200_000
const MAX_CALL_EDGES = 4_000
const MAX_REFERENCES = 4_000
// A previous 30-minute run reached DEX 3 of 10 before aborting; give a
// multi-DEX run room to finish while keeping each request strictly bounded.
const MAX_TIMEOUT_MS = 150 * 60_000
const DEFAULT_TIMEOUT_MS = MAX_TIMEOUT_MS

interface DexMethod {
  signature: string
  className: string
  methodName: string
  relativePath: string
  dexIndex: number
  methodIndex: number
  instructionCount: number
  instructionMnemonics: string[]
  controlFlowGraph: Record<string, unknown>
  bytecodeArtifactPath?: string
  bytecodeArtifactId?: string
  bytecodeArtifactSizeBytes?: number
  bytecodeRowsTruncated: boolean
  cfgTruncated: boolean
}

interface DexDecompilerResponse {
  status: 'completed'
  toolVersion: string
  input: { sha256: string; relativePath: string }
  discoveredClassCount: number
  returnedClassCount: number
  discoveredMethodCount: number
  returnedMethodCount: number
  streamedMethodCount?: number
  methodsTruncated: boolean
  methods: DexMethod[]
  calls: DexCall[]
  returnedCallCount?: number
  streamedCallCount?: number
  callGraphTruncated: boolean
  references: DexReference[]
  returnedReferenceCount?: number
  streamedReferenceCount?: number
  referencesTruncated: boolean
  failedClassDetails?: Array<{
    dexEntry: string
    classIndex: number
    descriptor: string | null
    reason: string
  }>
  codeBytes: number
  truncated: boolean
  units: DexUnit[]
  warnings?: string
}

interface DexUnit {
  name: string
  relativePath: string
  codeArtifactId: string
  sizeBytes: number
  outputSha256?: string
}

function isSafeMethodEvidencePath(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'string' || !value || value.length > 2_000 || value.startsWith('/') || value.includes('\\')) return false
  return !value.split('/').some((part) => part === '' || part === '.' || part === '..')
}

function isStreamedMethod(value: unknown): value is DexMethod {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const method = value as Record<string, unknown>
  return typeof method.signature === 'string' && method.signature.length > 0 && method.signature.length <= MAX_SIGNATURE_CHARS
    && typeof method.className === 'string' && method.className.length > 0 && method.className.length <= 500
    && typeof method.methodName === 'string' && method.methodName.length > 0 && method.methodName.length <= 500
    && typeof method.relativePath === 'string' && method.relativePath.length > 0 && method.relativePath.length <= 1_000
    && Number.isSafeInteger(method.dexIndex) && (method.dexIndex as number) >= 0
    && Number.isSafeInteger(method.methodIndex) && (method.methodIndex as number) >= 0
    && Number.isSafeInteger(method.instructionCount) && (method.instructionCount as number) >= 0
    && Array.isArray(method.instructionMnemonics) && method.instructionMnemonics.length <= 128
    && method.instructionMnemonics.every((mnemonic) => typeof mnemonic === 'string' && /^[A-Za-z][A-Za-z0-9_./-]{0,31}$/.test(mnemonic))
    && !!method.controlFlowGraph && typeof method.controlFlowGraph === 'object' && !Array.isArray(method.controlFlowGraph)
    && ((method.bytecodeArtifactId === undefined && method.bytecodeArtifactSizeBytes === undefined)
      || (typeof method.bytecodeArtifactId === 'string' && method.bytecodeArtifactId.length > 0 && method.bytecodeArtifactId.length <= 2_000
        && Number.isSafeInteger(method.bytecodeArtifactSizeBytes) && (method.bytecodeArtifactSizeBytes as number) > 0))
    && isSafeMethodEvidencePath(method.bytecodeArtifactPath)
    && typeof method.bytecodeRowsTruncated === 'boolean' && typeof method.cfgTruncated === 'boolean'
}

function isStreamedUnit(value: unknown): value is DexUnit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const unit = value as Record<string, unknown>
  return typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
    && typeof unit.relativePath === 'string' && unit.relativePath.length > 0 && unit.relativePath.length <= 1_000
    && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId.length > 0 && unit.codeArtifactId.length <= 2_000
    && Number.isSafeInteger(unit.sizeBytes) && (unit.sizeBytes as number) > 0
    && (unit.outputSha256 === undefined || (typeof unit.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(unit.outputSha256)))
}

function returnedCallCountOf(response: DexDecompilerResponse): number {
  return response.returnedCallCount ?? response.calls.length + (response.streamedCallCount ?? 0)
}

function returnedReferenceCountOf(response: DexDecompilerResponse): number {
  return response.returnedReferenceCount ?? response.references.length + (response.streamedReferenceCount ?? 0)
}

function functionObservation(
  input: ToolExecutionInput,
  method: DexMethod,
  unit: DexDecompilerResponse['units'][number],
  parentCodeUnitKey: string,
  toolVersion: string,
  sourceSha256: string,
): ToolObservation {
  const cfg = JSON.stringify(method.controlFlowGraph)
  const identity = `${input.artifactId}:${method.dexIndex}:${method.methodIndex}:${method.signature}`
  return {
    kind: 'entity',
    type: 'function',
    key: methodObservationKey(input, method.dexIndex, method.methodIndex, method.signature),
    label: `${method.className}#${method.methodName}`.slice(0, 500),
    attributes: {
      unitType: 'function',
      identity,
      identityKey: `${method.dexIndex}:${method.methodIndex}:${method.signature}`,
      name: method.methodName.slice(0, 500),
      qualifiedName: method.signature,
      address: `dex${method.dexIndex}:method#${method.methodIndex}`,
      language: 'Java',
      instructionLanguage: 'Dalvik',
      instructionCount: method.instructionCount,
      instructionMnemonics: JSON.stringify(method.instructionMnemonics),
      ...(method.bytecodeArtifactId ? {
        bytecodeArtifactId: method.bytecodeArtifactId,
        bytecodeArtifactSizeBytes: method.bytecodeArtifactSizeBytes as number,
      } : {}),
      relativePath: method.relativePath,
      parentCodeUnitKey,
      codeArtifactId: unit.codeArtifactId,
      decompilationEngine: 'androguard/dex-decompiler',
      decompilationEngineVersion: toolVersion,
      sourceSha256,
      bytecodeRowsTruncated: method.bytecodeRowsTruncated,
      cfgTruncated: method.cfgTruncated,
      ...(cfg.length <= 3_800 ? { controlFlowGraph: cfg } : {}),
    },
  }
}

function classObservationKey(artifactId: string, relativePath: string): string {
  const identity = `${artifactId}:${relativePath}`
  return `dex-decompiler:class:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

interface DexCall {
  fromSignature: string
  toSignature: string
  fromRelativePath: string
  toRelativePath: string
  fromAddress: string
  toAddress: string
  fromDexIndex: number
  toDexIndex: number
  fromMethodIndex: number
  toMethodIndex: number
  callSiteCount: number
  offsets: number[]
}

interface DexReference {
  kind: 'field_read' | 'field_write' | 'string_literal'
  fromSignature: string
  fromRelativePath: string
  fromDexIndex: number
  fromMethodIndex: number
  fromAddress: string
  targetSignature: string
  targetName: string
  targetNameTruncated: boolean
  targetDexIndex: number
  targetIndex: number
  occurrenceCount: number
  offsets: number[]
}

class RecentObservationKeys {
  private readonly keys = new Map<string, number>()
  private readonly order: Array<{ key: string; generation: number }> = []
  private head = 0
  private generation = 0

  constructor(private readonly limit = 50_000) {}

  add(key: string): boolean {
    if (this.keys.has(key)) return false
    const generation = ++this.generation
    this.keys.set(key, generation)
    this.order.push({ key, generation })
    if (this.order.length - this.head > this.limit) {
      const expired = this.order[this.head++]
      if (this.keys.get(expired.key) === expired.generation) this.keys.delete(expired.key)
    }
    if (this.head >= this.limit) {
      this.order.splice(0, this.head)
      this.head = 0
    }
    return true
  }
}

function isDexCall(value: unknown): value is DexCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const call = value as Record<string, unknown>
  return typeof call.fromSignature === 'string' && call.fromSignature.length > 0 && call.fromSignature.length <= MAX_SIGNATURE_CHARS
    && typeof call.toSignature === 'string' && call.toSignature.length > 0 && call.toSignature.length <= MAX_SIGNATURE_CHARS
    && typeof call.fromRelativePath === 'string' && call.fromRelativePath.length > 0 && call.fromRelativePath.length <= 1_000
    && typeof call.toRelativePath === 'string' && call.toRelativePath.length > 0 && call.toRelativePath.length <= 1_000
    && typeof call.fromAddress === 'string' && call.fromAddress.length <= 128
    && typeof call.toAddress === 'string' && call.toAddress.length <= 128
    && Number.isSafeInteger(call.fromDexIndex) && (call.fromDexIndex as number) >= 0
    && Number.isSafeInteger(call.toDexIndex) && (call.toDexIndex as number) >= 0
    && Number.isSafeInteger(call.fromMethodIndex) && (call.fromMethodIndex as number) >= 0
    && Number.isSafeInteger(call.toMethodIndex) && (call.toMethodIndex as number) >= 0
    && Number.isSafeInteger(call.callSiteCount) && (call.callSiteCount as number) >= 1
    && Array.isArray(call.offsets) && call.offsets.length <= 3
    && call.offsets.every((offset) => Number.isSafeInteger(offset) && offset >= 0)
}

function isDexReference(value: unknown): value is DexReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const reference = value as Record<string, unknown>
  return ['field_read', 'field_write', 'string_literal'].includes(String(reference.kind))
    && typeof reference.fromSignature === 'string' && reference.fromSignature.length > 0 && reference.fromSignature.length <= MAX_SIGNATURE_CHARS
    && typeof reference.fromRelativePath === 'string' && reference.fromRelativePath.length > 0 && reference.fromRelativePath.length <= 1_000
    && Number.isSafeInteger(reference.fromDexIndex) && (reference.fromDexIndex as number) >= 0
    && Number.isSafeInteger(reference.fromMethodIndex) && (reference.fromMethodIndex as number) >= 0
    && typeof reference.fromAddress === 'string' && reference.fromAddress.length <= 128
    && typeof reference.targetSignature === 'string' && reference.targetSignature.length > 0 && reference.targetSignature.length <= MAX_SIGNATURE_CHARS
    && typeof reference.targetName === 'string' && reference.targetName.length <= 512
    && typeof reference.targetNameTruncated === 'boolean'
    && Number.isSafeInteger(reference.targetDexIndex) && (reference.targetDexIndex as number) >= 0
    && Number.isSafeInteger(reference.targetIndex) && (reference.targetIndex as number) >= 0
    && Number.isSafeInteger(reference.occurrenceCount) && (reference.occurrenceCount as number) >= 1
    && Array.isArray(reference.offsets) && reference.offsets.length <= 3
    && reference.offsets.every((offset) => Number.isSafeInteger(offset) && offset >= 0)
}

export const dexDecompilerManifest: ToolPluginManifest = {
  id: 'reamon-dex-decompiler',
  name: 'Rust DEX-to-Java Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['apk', 'dex'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'CallGraph', 'Relationship', 'SymbolReference'],
  requirements: [
    { key: 'service', value: 'Isolated dex-decompiler analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4_000) || 'DEX-to-Java analysis failed'
}

function timeoutMs(): number {
  const value = Number(process.env.REAMON_DEX_DECOMPILER_REQUEST_TIMEOUT_MS)
  return Number.isFinite(value) ? Math.min(MAX_TIMEOUT_MS, Math.max(60_000, Math.floor(value))) : DEFAULT_TIMEOUT_MS
}

function methodObservationKey(input: ToolExecutionInput, dexIndex: number, methodIndex: number, signature: string): string {
  const identity = `${input.artifactId}:${dexIndex}:${methodIndex}:${signature}`
  return `dex-decompiler:method:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
}

function isResponse(value: unknown): value is DexDecompilerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const input = response.input
  const streamedMethodCount = response.streamedMethodCount ?? 0
  const streamedCallCount = typeof response.streamedCallCount === 'number' ? response.streamedCallCount : 0
  const streamedReferenceCount = typeof response.streamedReferenceCount === 'number' ? response.streamedReferenceCount : 0
  const returnedCallCount = typeof response.returnedCallCount === 'number'
    ? response.returnedCallCount : Array.isArray(response.calls) ? response.calls.length + streamedCallCount : -1
  const returnedReferenceCount = typeof response.returnedReferenceCount === 'number'
    ? response.returnedReferenceCount : Array.isArray(response.references) ? response.references.length + streamedReferenceCount : -1
  return response.status === 'completed'
    && typeof response.toolVersion === 'string' && /^[a-f0-9]{40}$/i.test(response.toolVersion)
    && !!input && typeof input === 'object' && !Array.isArray(input)
    && typeof (input as Record<string, unknown>).sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test((input as Record<string, unknown>).sha256 as string)
    && typeof (input as Record<string, unknown>).relativePath === 'string'
    && ((input as Record<string, unknown>).relativePath as string).length > 0
    && ((input as Record<string, unknown>).relativePath as string).length <= 1_000
    && Number.isSafeInteger(response.discoveredClassCount) && (response.discoveredClassCount as number) >= 0
    && Number.isSafeInteger(response.returnedClassCount) && (response.returnedClassCount as number) >= 0
    && Number.isSafeInteger(response.discoveredMethodCount) && (response.discoveredMethodCount as number) >= 0
    && Number.isSafeInteger(response.returnedMethodCount) && (response.returnedMethodCount as number) >= 0
    && typeof streamedMethodCount === 'number' && Number.isSafeInteger(streamedMethodCount) && streamedMethodCount >= 0
    && streamedMethodCount <= MAX_STREAMED_METHODS
    && typeof response.methodsTruncated === 'boolean'
    && Array.isArray(response.methods) && response.methods.length <= MAX_METHODS
    && response.returnedMethodCount === response.methods.length + streamedMethodCount
    && (response.discoveredMethodCount as number) >= (response.returnedMethodCount as number)
    && response.methods.every((method: DexMethod) => !!method && typeof method === 'object' && !Array.isArray(method)
      && typeof method.signature === 'string' && method.signature.length > 0 && method.signature.length <= MAX_SIGNATURE_CHARS
      && typeof method.className === 'string' && method.className.length > 0 && method.className.length <= 500
      && typeof method.methodName === 'string' && method.methodName.length > 0 && method.methodName.length <= 500
      && typeof method.relativePath === 'string' && method.relativePath.length > 0 && method.relativePath.length <= 1_000
      && Number.isSafeInteger(method.dexIndex) && method.dexIndex >= 0
      && Number.isSafeInteger(method.methodIndex) && method.methodIndex >= 0
      && Number.isSafeInteger(method.instructionCount) && method.instructionCount >= 0
      && Array.isArray(method.instructionMnemonics) && method.instructionMnemonics.length <= 128
      && method.instructionMnemonics.every((mnemonic) => typeof mnemonic === 'string' && /^[A-Za-z][A-Za-z0-9_./-]{0,31}$/.test(mnemonic))
      && !!method.controlFlowGraph && typeof method.controlFlowGraph === 'object' && !Array.isArray(method.controlFlowGraph)
      && ((method.bytecodeArtifactId === undefined && method.bytecodeArtifactSizeBytes === undefined)
        || (typeof method.bytecodeArtifactId === 'string' && method.bytecodeArtifactId.length > 0 && method.bytecodeArtifactId.length <= 2_000
          && Number.isSafeInteger(method.bytecodeArtifactSizeBytes) && (method.bytecodeArtifactSizeBytes as number) > 0))
      && isSafeMethodEvidencePath(method.bytecodeArtifactPath)
      && typeof method.bytecodeRowsTruncated === 'boolean' && typeof method.cfgTruncated === 'boolean')
    && Array.isArray(response.calls) && response.calls.length <= MAX_CALL_EDGES
    && Number.isSafeInteger(returnedCallCount) && returnedCallCount >= 0 && returnedCallCount <= MAX_STREAMED_EDGES
    && Number.isSafeInteger(streamedCallCount) && streamedCallCount >= 0 && streamedCallCount <= MAX_STREAMED_EDGES
    && returnedCallCount === response.calls.length + streamedCallCount
    && typeof response.callGraphTruncated === 'boolean'
    && response.calls.every((call: DexCall) => !!call && typeof call === 'object' && !Array.isArray(call)
      && typeof call.fromSignature === 'string' && call.fromSignature.length > 0 && call.fromSignature.length <= MAX_SIGNATURE_CHARS
      && typeof call.toSignature === 'string' && call.toSignature.length > 0 && call.toSignature.length <= MAX_SIGNATURE_CHARS
      && typeof call.fromRelativePath === 'string' && call.fromRelativePath.length > 0 && call.fromRelativePath.length <= 1_000
      && typeof call.toRelativePath === 'string' && call.toRelativePath.length > 0 && call.toRelativePath.length <= 1_000
      && typeof call.fromAddress === 'string' && call.fromAddress.length <= 128
      && typeof call.toAddress === 'string' && call.toAddress.length <= 128
      && Number.isSafeInteger(call.fromDexIndex) && call.fromDexIndex >= 0
      && Number.isSafeInteger(call.toDexIndex) && call.toDexIndex >= 0
      && Number.isSafeInteger(call.fromMethodIndex) && call.fromMethodIndex >= 0
      && Number.isSafeInteger(call.toMethodIndex) && call.toMethodIndex >= 0
      && Number.isSafeInteger(call.callSiteCount) && call.callSiteCount >= 1
      && Array.isArray(call.offsets) && call.offsets.length <= 3
      && call.offsets.every((offset) => Number.isSafeInteger(offset) && offset >= 0))
    && Array.isArray(response.references) && response.references.length <= MAX_REFERENCES
    && Number.isSafeInteger(returnedReferenceCount) && returnedReferenceCount >= 0 && returnedReferenceCount <= MAX_STREAMED_EDGES
    && Number.isSafeInteger(streamedReferenceCount) && streamedReferenceCount >= 0 && streamedReferenceCount <= MAX_STREAMED_EDGES
    && returnedReferenceCount === response.references.length + streamedReferenceCount
    && typeof response.referencesTruncated === 'boolean'
    && response.references.every((reference: DexReference) => !!reference && typeof reference === 'object' && !Array.isArray(reference)
      && ['field_read', 'field_write', 'string_literal'].includes(reference.kind)
      && typeof reference.fromSignature === 'string' && reference.fromSignature.length > 0 && reference.fromSignature.length <= MAX_SIGNATURE_CHARS
      && typeof reference.fromRelativePath === 'string' && reference.fromRelativePath.length > 0 && reference.fromRelativePath.length <= 1_000
      && Number.isSafeInteger(reference.fromDexIndex) && reference.fromDexIndex >= 0
      && Number.isSafeInteger(reference.fromMethodIndex) && reference.fromMethodIndex >= 0
      && typeof reference.fromAddress === 'string' && reference.fromAddress.length <= 128
      && typeof reference.targetSignature === 'string' && reference.targetSignature.length > 0 && reference.targetSignature.length <= MAX_SIGNATURE_CHARS
      && typeof reference.targetName === 'string' && reference.targetName.length <= 512
      && typeof reference.targetNameTruncated === 'boolean'
      && Number.isSafeInteger(reference.targetDexIndex) && reference.targetDexIndex >= 0
      && Number.isSafeInteger(reference.targetIndex) && reference.targetIndex >= 0
      && Number.isSafeInteger(reference.occurrenceCount) && reference.occurrenceCount >= 1
      && Array.isArray(reference.offsets) && reference.offsets.length <= 3
      && reference.offsets.every((offset) => Number.isSafeInteger(offset) && offset >= 0))
    && typeof response.codeBytes === 'number' && Number.isSafeInteger(response.codeBytes) && response.codeBytes >= 0
    && typeof response.truncated === 'boolean'
    && (response.failedClassDetails === undefined || (Array.isArray(response.failedClassDetails)
      && response.failedClassDetails.length <= 1000
      && response.failedClassDetails.every((detail) => !!detail && typeof detail === 'object' && !Array.isArray(detail)
        && typeof detail.dexEntry === 'string' && detail.dexEntry.length > 0 && detail.dexEntry.length <= 256
        && Number.isSafeInteger(detail.classIndex) && detail.classIndex >= 0
        && (detail.descriptor === null || (typeof detail.descriptor === 'string' && detail.descriptor.length <= 512))
        && typeof detail.reason === 'string' && detail.reason.length <= 256)))
    && Array.isArray(response.units) && response.units.length <= MAX_CLASSES
    && response.returnedClassCount === response.units.length
    && (response.discoveredClassCount as number) >= response.units.length
    && response.units.every((unit) => !!unit && typeof unit === 'object' && !Array.isArray(unit)
      && typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
      && typeof unit.relativePath === 'string' && unit.relativePath.length > 0 && unit.relativePath.length <= 1_000
      && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId.length > 0 && unit.codeArtifactId.length <= 2_000
      && Number.isSafeInteger(unit.sizeBytes) && unit.sizeBytes > 0
      && (unit.outputSha256 === undefined || (typeof unit.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(unit.outputSha256))))
    && (response.warnings === undefined || typeof response.warnings === 'string')
}

export async function executeDexDecompiler(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: dexDecompilerManifest.id,
    capabilities: dexDecompilerManifest.capabilities,
    produced: dexDecompilerManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'DEX decompilation requires a stored APK or DEX artifact and task context' }
  }

  const baseUrl = process.env.REAMON_DEX_DECOMPILER_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated DEX decompiler is not configured' }

  const timeout = AbortSignal.timeout(timeoutMs())
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
    const streamedUnitsByPath = new Map<string, DexUnit>()
    const streamedClassKeysByPath = new Map<string, string>()
    const streamedMethodKeys = new Set<string>()
    const streamedCallEdges = new RecentObservationKeys()
    const streamedReferenceTargets = new RecentObservationKeys()
    const streamedReferenceEdges = new RecentObservationKeys()
    let streamedFunctionObservationCount = 0
    const addStreamedEndpoint = (
      signature: string,
      relativePath: string,
      dexIndex: number,
      methodIndex: number,
      address: string,
      toolVersion: string,
      sourceSha256: string,
      batch: ToolObservation[],
    ): string => {
      const key = methodObservationKey(input, dexIndex, methodIndex, signature)
      if (streamedMethodKeys.has(key)) return key
      const unit = streamedUnitsByPath.get(relativePath)
      const parentCodeUnitKey = streamedClassKeysByPath.get(relativePath)
      const owner = signature.split('#')[0] || signature
      const methodName = signature.includes('#') ? signature.slice(signature.indexOf('#') + 1).split('(')[0] : signature
      batch.push({
        kind: 'entity',
        type: 'function',
        key,
        label: `${owner}#${methodName}`.slice(0, 500),
        attributes: {
          unitType: 'function',
          identity: `${input.artifactId}:${dexIndex}:${methodIndex}:${signature}`,
          identityKey: `${dexIndex}:${methodIndex}:${signature}`,
          name: methodName.slice(0, 500),
          qualifiedName: signature,
          address,
          language: 'Java',
          instructionLanguage: 'Dalvik',
          ...(unit && parentCodeUnitKey ? { relativePath, parentCodeUnitKey, codeArtifactId: unit.codeArtifactId } : {}),
          externalOrUndecompiled: true,
          decompilationEngine: 'androguard/dex-decompiler',
          decompilationEngineVersion: toolVersion,
          sourceSha256,
        },
      })
      streamedMethodKeys.add(key)
      return key
    }
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress, async (field, items, metadata) => {
      if (field === 'units') {
        for (const item of items) {
          if (!isStreamedUnit(item)) throw new Error('DEX decompiler returned an invalid class page')
          streamedUnitsByPath.set(item.relativePath, item)
          streamedClassKeysByPath.set(item.relativePath, classObservationKey(input.artifactId as string, item.relativePath))
        }
        return false
      }
      if (!['methods', 'calls', 'references'].includes(field) || !input.persistObservationBatch) return false
      const streamedInput = metadata.input
      const sourceSha256 = streamedInput && typeof streamedInput === 'object' && !Array.isArray(streamedInput)
        ? (streamedInput as Record<string, unknown>).sha256
        : null
      const toolVersion = metadata.toolVersion
      if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceSha256)
        || typeof toolVersion !== 'string' || !/^[a-f0-9]{40}$/i.test(toolVersion)) {
        throw new Error('DEX decompiler omitted streamed evidence provenance metadata')
      }
      const batch: ToolObservation[] = []
      if (field === 'calls') {
        for (const value of items) {
          if (!isDexCall(value)) throw new Error('DEX decompiler returned an invalid call page')
          const call = value
          if (!streamedUnitsByPath.has(call.fromRelativePath)) throw new Error('DEX call page refers to an unknown caller class')
          const edgeIdentity = `${call.fromDexIndex}:${call.fromMethodIndex}->${call.toDexIndex}:${call.toMethodIndex}`
          if (!streamedCallEdges.add(edgeIdentity)) continue
          const fromKey = addStreamedEndpoint(call.fromSignature, call.fromRelativePath, call.fromDexIndex, call.fromMethodIndex, call.fromAddress, toolVersion, sourceSha256, batch)
          const toKey = addStreamedEndpoint(call.toSignature, call.toRelativePath, call.toDexIndex, call.toMethodIndex, call.toAddress, toolVersion, sourceSha256, batch)
          const fromCodeUnitKey = streamedClassKeysByPath.get(call.fromRelativePath)
          const toCodeUnitKey = streamedClassKeysByPath.get(call.toRelativePath)
          const edgeDigest = createHash('sha256').update(`${input.artifactId}:${edgeIdentity}`).digest('hex').slice(0, 32)
          batch.push({
            kind: 'relationship',
            type: 'calls',
            relation: 'calls',
            key: `dex-decompiler:call:${edgeDigest}`,
            fromKey,
            toKey,
            label: `${call.fromSignature} calls ${call.toSignature}`.slice(0, 500),
            attributes: {
              fromSignature: call.fromSignature,
              toSignature: call.toSignature,
              fromAddress: call.fromAddress,
              toAddress: call.toAddress,
              callSiteCount: call.callSiteCount,
              callOffsets: JSON.stringify(call.offsets),
              ...(fromCodeUnitKey ? { fromCodeUnitKey } : {}),
              ...(toCodeUnitKey ? { toCodeUnitKey } : {}),
            },
          })
        }
      } else if (field === 'references') {
        for (const value of items) {
          if (!isDexReference(value)) throw new Error('DEX decompiler returned an invalid reference page')
          const reference = value
          if (!streamedUnitsByPath.has(reference.fromRelativePath)) throw new Error('DEX reference page refers to an unknown source class')
          const fromKey = addStreamedEndpoint(reference.fromSignature, reference.fromRelativePath, reference.fromDexIndex, reference.fromMethodIndex, reference.fromAddress, toolVersion, sourceSha256, batch)
          const targetKind = reference.kind === 'string_literal' ? 'string_literal' : 'field'
          const targetIdentity = `${input.artifactId}:${reference.targetDexIndex}:${reference.targetIndex}:${targetKind}:${reference.targetSignature}`
          const targetDigest = createHash('sha256').update(targetIdentity).digest('hex').slice(0, 32)
          const targetKey = `dex-decompiler:symbol:${targetDigest}`
          if (streamedReferenceTargets.add(targetKey)) {
            batch.push({
              kind: 'entity',
              type: 'symbol',
              key: targetKey,
              label: reference.targetName.slice(0, 500) || reference.targetSignature.slice(0, 500),
              attributes: {
                unitType: targetKind,
                symbolKind: targetKind,
                identity: targetIdentity,
                identityKey: targetKind === 'field' ? `field:${reference.targetSignature}` : `string:${reference.targetDexIndex}:${reference.targetIndex}`,
                name: reference.targetName.slice(0, 500) || reference.targetSignature.slice(0, 500),
                qualifiedName: reference.targetSignature,
                dexIndex: reference.targetDexIndex,
                referenceIndex: reference.targetIndex,
                decompilationEngine: 'androguard/dex-decompiler',
                decompilationEngineVersion: toolVersion,
                sourceSha256,
              },
            })
          }
          const relation = reference.kind === 'field_read' ? 'reads_field' : reference.kind === 'field_write' ? 'writes_field' : 'references_string'
          const edgeIdentity = `${reference.fromDexIndex}:${reference.fromMethodIndex}:${relation}:${targetIdentity}`
          if (!streamedReferenceEdges.add(edgeIdentity)) continue
          const edgeDigest = createHash('sha256').update(`${input.artifactId}:${edgeIdentity}`).digest('hex').slice(0, 32)
          batch.push({
            kind: 'relationship', type: relation, relation,
            key: `dex-decompiler:reference:${edgeDigest}`,
            fromKey, toKey: targetKey,
            label: `${reference.fromSignature} ${relation.replace('_', ' ')} ${reference.targetName || reference.targetSignature}`.slice(0, 500),
            attributes: {
              fromSignature: reference.fromSignature,
              fromAddress: reference.fromAddress,
              targetSignature: reference.targetSignature,
              targetName: reference.targetName,
              targetNameTruncated: reference.targetNameTruncated,
              referenceKind: reference.kind,
              occurrenceCount: reference.occurrenceCount,
              referenceOffsets: JSON.stringify(reference.offsets),
              ...(streamedClassKeysByPath.get(reference.fromRelativePath)
                ? { fromCodeUnitKey: streamedClassKeysByPath.get(reference.fromRelativePath) as string }
                : {}),
            },
          })
        }
      }
      if (field === 'methods') {
        for (const item of items) {
          if (!isStreamedMethod(item)) throw new Error('DEX decompiler returned an invalid method page')
          const unit = streamedUnitsByPath.get(item.relativePath)
          const parentCodeUnitKey = streamedClassKeysByPath.get(item.relativePath)
          if (!unit || !parentCodeUnitKey) continue
          const key = methodObservationKey(input, item.dexIndex, item.methodIndex, item.signature)
          streamedMethodKeys.add(key)
          batch.push(functionObservation(input, item, unit, parentCodeUnitKey, toolVersion, sourceSha256))
        }
      }
      if (batch.length) {
        const persisted = await input.persistObservationBatch(batch)
        if (field === 'methods') streamedFunctionObservationCount += persisted
      }
      return true
    })
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1_000)
        : `DEX decompiler returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('DEX decompiler returned an invalid result')
    if (!payload.units.length) throw new Error('DEX decompiler did not produce viewable Java classes')

    const observations: ToolObservation[] = payload.units.slice(0, MAX_CLASSES).map((unit) => {
      const identity = `${input.artifactId}:${unit.relativePath}`
      const key = `dex-decompiler:class:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
      return {
        kind: 'entity',
        type: 'code_unit',
        key,
        label: unit.name,
        attributes: {
          unitType: 'class',
          identity,
          name: unit.name,
          qualifiedName: unit.name,
          sizeBytes: unit.sizeBytes,
          language: 'Java',
          relativePath: unit.relativePath,
          decompiled: true,
          codeArtifactId: unit.codeArtifactId,
          decompilationEngine: 'androguard/dex-decompiler',
          decompilationEngineVersion: payload.toolVersion,
          sourceSha256: payload.input.sha256,
          inputArtifactSha256: payload.input.sha256.toLowerCase(),
          ...(typeof unit.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(unit.outputSha256)
            ? { decompiledSourceSha256: unit.outputSha256.toLowerCase() } : {}),
          alternateDecompiler: true,
        },
      }
    })
    for (const detail of payload.failedClassDetails || []) {
      const identity = `${input.artifactId}:${detail.dexEntry}:${detail.classIndex}:${detail.descriptor || 'unknown'}`
      const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32)
      const label = detail.descriptor || `${detail.dexEntry} class #${detail.classIndex + 1}`
      observations.push({
        kind: 'fact',
        type: 'decompilation_failure',
        key: `dex-decompiler:failure:${digest}`,
        label: `${label} could not be reconstructed`.slice(0, 500),
        attributes: {
          identity,
          identityKey: `dex-failure:${detail.dexEntry}:${detail.classIndex}:${detail.descriptor || 'unknown'}`,
          artifactId: input.artifactId,
          dexEntry: detail.dexEntry,
          classIndex: detail.classIndex,
          descriptor: detail.descriptor,
          reason: detail.reason,
          decompilationEngine: 'androguard/dex-decompiler',
          decompilationEngineVersion: payload.toolVersion,
          sourceSha256: payload.input.sha256,
        },
      })
    }
    const unitsByPath = new Map(payload.units.map((unit) => [unit.relativePath, unit]))
    const classKeysByPath = new Map(payload.units.map((unit) => [unit.relativePath,
      `dex-decompiler:class:${createHash('sha256').update(`${input.artifactId}:${unit.relativePath}`).digest('hex').slice(0, 32)}`,
    ]))
    const methodNodeKeys = new Set<string>(streamedMethodKeys)
    let methodsAdded = 0
    for (const method of payload.methods) {
      const unit = unitsByPath.get(method.relativePath)
      const parentCodeUnitKey = classKeysByPath.get(method.relativePath)
      if (!unit || !parentCodeUnitKey || observations.length >= MAX_CODE_UNITS_PER_RESULT) continue
      const key = methodObservationKey(input, method.dexIndex, method.methodIndex, method.signature)
      observations.push(functionObservation(input, method, unit, parentCodeUnitKey, payload.toolVersion, payload.input.sha256))
      methodNodeKeys.add(key)
      methodsAdded += 1
    }
    const observedMethodCount = streamedFunctionObservationCount + methodsAdded
    const seenCalls = new Set<string>()
    let callGraphTruncated = payload.callGraphTruncated
    const addCallEndpoint = (
      signature: string,
      relativePath: string,
      dexIndex: number,
      methodIndex: number,
      address: string,
    ): string | null => {
      const key = methodObservationKey(input, dexIndex, methodIndex, signature)
      if (methodNodeKeys.has(key)) return key
      if (observations.length >= MAX_CODE_UNITS_PER_RESULT) return null
      const unit = unitsByPath.get(relativePath)
      const parentCodeUnitKey = classKeysByPath.get(relativePath)
      const owner = signature.split('#')[0] || signature
      const methodName = signature.includes('#') ? signature.slice(signature.indexOf('#') + 1).split('(')[0] : signature
      observations.push({
        kind: 'entity',
        type: 'function',
        key,
        label: `${owner}#${methodName}`.slice(0, 500),
        attributes: {
          unitType: 'function',
          identity: `${input.artifactId}:${dexIndex}:${methodIndex}:${signature}`,
          identityKey: `${dexIndex}:${methodIndex}:${signature}`,
          name: methodName.slice(0, 500),
          qualifiedName: signature,
          address,
          language: 'Java',
          instructionLanguage: 'Dalvik',
          ...(unit && parentCodeUnitKey ? { relativePath, parentCodeUnitKey, codeArtifactId: unit.codeArtifactId } : {}),
          externalOrUndecompiled: true,
          decompilationEngine: 'androguard/dex-decompiler',
          decompilationEngineVersion: payload.toolVersion,
          sourceSha256: payload.input.sha256,
        },
      })
      methodNodeKeys.add(key)
      return key
    }
    for (const call of payload.calls) {
      if (!unitsByPath.has(call.fromRelativePath)) {
        callGraphTruncated = true
        continue
      }
      const edgeIdentity = `${call.fromDexIndex}:${call.fromMethodIndex}->${call.toDexIndex}:${call.toMethodIndex}`
      if (seenCalls.has(edgeIdentity)) continue
      const fromKey = addCallEndpoint(call.fromSignature, call.fromRelativePath, call.fromDexIndex, call.fromMethodIndex, call.fromAddress)
      const toKey = addCallEndpoint(call.toSignature, call.toRelativePath, call.toDexIndex, call.toMethodIndex, call.toAddress)
      if (!fromKey || !toKey || observations.length >= MAX_CODE_UNITS_PER_RESULT) {
        callGraphTruncated = true
        break
      }
      seenCalls.add(edgeIdentity)
      const fromCodeUnitKey = classKeysByPath.get(call.fromRelativePath)
      const toCodeUnitKey = classKeysByPath.get(call.toRelativePath)
      const edgeDigest = createHash('sha256').update(`${input.artifactId}:${edgeIdentity}`).digest('hex').slice(0, 32)
      observations.push({
        kind: 'relationship',
        type: 'calls',
        relation: 'calls',
        key: `dex-decompiler:call:${edgeDigest}`,
        fromKey,
        toKey,
        label: `${call.fromSignature} calls ${call.toSignature}`.slice(0, 500),
        attributes: {
          fromSignature: call.fromSignature,
          toSignature: call.toSignature,
          fromAddress: call.fromAddress,
          toAddress: call.toAddress,
          callSiteCount: call.callSiteCount,
          callOffsets: JSON.stringify(call.offsets),
          ...(fromCodeUnitKey ? { fromCodeUnitKey } : {}),
          ...(toCodeUnitKey ? { toCodeUnitKey } : {}),
        },
      })
    }
    let referencesTruncated = payload.referencesTruncated
    const seenReferenceTargets = new Set<string>()
    const seenReferenceEdges = new Set<string>()
    for (const reference of payload.references) {
      if (!unitsByPath.has(reference.fromRelativePath)) {
        referencesTruncated = true
        continue
      }
      const fromKey = addCallEndpoint(reference.fromSignature, reference.fromRelativePath, reference.fromDexIndex, reference.fromMethodIndex, reference.fromAddress)
      if (!fromKey || observations.length + 2 > MAX_CODE_UNITS_PER_RESULT) {
        referencesTruncated = true
        break
      }
      const targetKind = reference.kind === 'string_literal' ? 'string_literal' : 'field'
      const targetIdentity = `${input.artifactId}:${reference.targetDexIndex}:${reference.targetIndex}:${targetKind}:${reference.targetSignature}`
      const targetDigest = createHash('sha256').update(targetIdentity).digest('hex').slice(0, 32)
      const targetKey = `dex-decompiler:symbol:${targetDigest}`
      if (!seenReferenceTargets.has(targetKey)) {
        observations.push({
          kind: 'entity',
          type: 'symbol',
          key: targetKey,
          label: reference.targetName.slice(0, 500) || reference.targetSignature.slice(0, 500),
          attributes: {
            unitType: targetKind,
            symbolKind: targetKind,
            identity: targetIdentity,
            identityKey: targetKind === 'field'
              ? `field:${reference.targetSignature}`
              : `string:${reference.targetDexIndex}:${reference.targetIndex}`,
            name: reference.targetName.slice(0, 500) || reference.targetSignature.slice(0, 500),
            qualifiedName: reference.targetSignature,
            dexIndex: reference.targetDexIndex,
            referenceIndex: reference.targetIndex,
            decompilationEngine: 'androguard/dex-decompiler',
            decompilationEngineVersion: payload.toolVersion,
            sourceSha256: payload.input.sha256,
          },
        })
        seenReferenceTargets.add(targetKey)
      }
      const relation = reference.kind === 'field_read'
        ? 'reads_field'
        : reference.kind === 'field_write' ? 'writes_field' : 'references_string'
      const edgeIdentity = `${reference.fromDexIndex}:${reference.fromMethodIndex}:${relation}:${targetIdentity}`
      if (seenReferenceEdges.has(edgeIdentity)) continue
      const edgeDigest = createHash('sha256').update(`${input.artifactId}:${edgeIdentity}`).digest('hex').slice(0, 32)
      observations.push({
        kind: 'relationship',
        type: relation,
        relation,
        key: `dex-decompiler:reference:${edgeDigest}`,
        fromKey,
        toKey: targetKey,
        label: `${reference.fromSignature} ${relation.replace('_', ' ')} ${reference.targetName || reference.targetSignature}`.slice(0, 500),
        attributes: {
          fromSignature: reference.fromSignature,
          fromAddress: reference.fromAddress,
          targetSignature: reference.targetSignature,
          targetName: reference.targetName,
          targetNameTruncated: reference.targetNameTruncated,
          referenceKind: reference.kind,
          occurrenceCount: reference.occurrenceCount,
          referenceOffsets: JSON.stringify(reference.offsets),
          ...(classKeysByPath.get(reference.fromRelativePath)
            ? { fromCodeUnitKey: classKeysByPath.get(reference.fromRelativePath) as string }
            : {}),
        },
      })
      seenReferenceEdges.add(edgeIdentity)
    }
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        discoveredClassCount: payload.discoveredClassCount,
        returnedClassCount: payload.returnedClassCount,
        discoveredMethodCount: payload.discoveredMethodCount,
        returnedMethodCount: payload.returnedMethodCount,
        streamedFunctionObservationCount,
        methodsTruncated: payload.methodsTruncated || observedMethodCount < payload.returnedMethodCount,
        callCount: returnedCallCountOf(payload),
        returnedCallCount: returnedCallCountOf(payload),
        callGraphTruncated,
        referenceCount: returnedReferenceCountOf(payload),
        referencesTruncated,
        failedClassDetails: payload.failedClassDetails || [],
        codeBytes: payload.codeBytes,
        truncated: payload.truncated || payload.discoveredClassCount > payload.returnedClassCount || payload.methodsTruncated || observedMethodCount < payload.returnedMethodCount || callGraphTruncated || referencesTruncated,
        decompilationEngine: 'androguard/dex-decompiler',
        decompilationEngineVersion: payload.toolVersion,
        inputSha256: payload.input.sha256,
        warnings: (payload.warnings || '').slice(0, 4_000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const dexDecompilerPlugin: ToolPlugin = { manifest: dexDecompilerManifest, analyze: executeDexDecompiler }
