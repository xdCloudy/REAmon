import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'
import { nativeFunctionIdentity } from './native-function-identity'

const MAX_UNITS = 2000
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_CALL_EDGES = 400
const REIPA_COMMIT = 'b0d4759451ed20796892a059fa53d9dbb130af61'
const GHIDRA_DEOBFUSCATION_LAB_COMMIT = 'f457afaa801b30f7bb98c28d419a36d5c9fd7115'
const BCF_CLEAN_COMMIT = GHIDRA_DEOBFUSCATION_LAB_COMMIT
const CFF_DEFLATTEN_COMMIT = GHIDRA_DEOBFUSCATION_LAB_COMMIT

interface UnstripGoInterfaceMethod {
  interfaceName: string
  concreteType: string
  method: string
  itabAddress: string
  concreteFunctionAddress: string
  incomplete: boolean
}

interface FlossRecoveredString {
  kind: 'stack' | 'tight' | 'decoded'
  value: string
  encoding?: string
  decodedAt?: string
}

interface GhidraControlFlowMetrics {
  version: 'ghidra-basic-blocks-v1'
  blockCount: number
  edgeCount: number
  entryBlockCount: number
  exitBlockCount: number
  truncated: boolean
}

interface GhidraControlFlowGraph {
  version: 'ghidra-basic-block-graph-v1'
  entryBlock: number
  exitBlock: number
  exitBlocks: number[]
  blockCount: number
  edgeCount: number
  truncated: boolean
  instructionLabel: string
  blocks: Array<[number, string, number, number, string[], string[], string]>
  edges: Array<[number, number, string]>
}

interface GhidraCffRecovery {
  version: 'reamon-cff-recovery-v1'
  entry: string
  dispatcher?: string
  score: number
  state?: string
  firstHead?: string
  lowConfidence: boolean
  confidenceNote?: string
  resolved: number
  conditional: number
  unresolved: number
  truncated: boolean
  nodes: Array<{
    head: string
    status: 'uncond' | 'cond' | 'multi' | 'ret' | 'exit' | 'unresolved'
    pure: boolean
    complete: boolean
    selfLoop: boolean
    successors: string[]
    condition?: string
    trueSuccessor?: string | null
    falseSuccessor?: string | null
    note?: string
  }>
}

interface GhidraResponse {
  status: 'completed'
  toolVersion: string
  instructionArchitecture?: string
  recoveredLanguage?: string | null
  goVersion?: string | null
  goArchitecture?: string | null
  goTypes?: string[]
  goTypeDetails?: Array<{ name: string; kind: string; reconstructed: string }>
  goTypeDetailsTruncated?: boolean
  goUnstripTypeDetails?: Array<{ name: string; kind: string; reconstructed: string; source: 'unstrip' }>
  goUnstripTypeDetailsTruncated?: boolean
  goUnstripInterfacesTruncated?: boolean
  swiftMetadataVersion?: `ReIPA@${string}`
  swiftTypeDetails?: Array<{ name: string; kind: string; reconstructed: string }>
  objcTypeDetails?: Array<{ name: string; kind: string; reconstructed: string }>
  reipaMetadataTruncated?: boolean
  reipaAlternateTruncated?: boolean
  reipaAlternateCodeBytes?: number
  flossVersion?: string | null
  flossRecoveredStringsTruncated?: boolean
  functionCount: number
  visitedFunctionCount?: number
  failedFunctionCount?: number
  codeBytes?: number
  returnedUnits: number
  truncated: boolean
  units: Array<{ name: string; address: string; relativePath: string; codeArtifactId: string; disassemblyArtifactId?: string; reipaAlternateCodeArtifactId?: string; reipaAlternateOutputSha256?: string; reipaAlternateSizeBytes?: number; bcfCleanAlternateCodeArtifactId?: string; bcfCleanAlternateOutputSha256?: string; bcfCleanAlternateSizeBytes?: number; bcfCleanAuditArtifactId?: string; bcfCleanAuditSha256?: string; bcfCleanCommit?: string; cffDeflattenAlternateCodeArtifactId?: string; cffDeflattenAlternateOutputSha256?: string; cffDeflattenAlternateSizeBytes?: number; cffDeflattenAuditArtifactId?: string; cffDeflattenAuditSha256?: string; cffDeflattenCommit?: string; referencedStrings?: string[]; instructionMnemonics?: string[]; cfgMetrics?: GhidraControlFlowMetrics; cfgGraph?: GhidraControlFlowGraph; cffRecovery?: GhidraCffRecovery; sourceAddressMap?: Array<{ ghidraLineNumber: number; address: string }>; prototype?: string; recoveredVariables?: Array<{ kind: 'parameter' | 'local'; name: string; dataType: string; sizeBytes: number; parameterIndex?: number; storageStartAddress?: string; nameLocked?: boolean; typeLocked?: boolean }>; recoveredVariablesTruncated?: boolean; flossVersion?: string; flossRecoveredStrings?: FlossRecoveredString[]; flossRecoveredStringsTruncated?: boolean; sourceLanguage?: string; symbolSource?: string; recoveredNativeSymbolName?: string; goPackage?: string; goUnstripSignature?: string; goUnstripSourceFile?: string; goUnstripSourceLine?: number; goUnstripInterfaces?: UnstripGoInterfaceMethod[]; goUnstripInterfacesTruncated?: boolean; sizeBytes: number }>
  calls?: Array<{ fromAddress: string; toAddress: string; fromName: string; toName: string }>
  callCount?: number
  callGraphTruncated?: boolean
  sourceAddressMapTruncated?: boolean
  recoveredVariablesTruncated?: boolean
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

function boundedGoInterfaceMethods(methods: UnstripGoInterfaceMethod[] | undefined) {
  const stored: UnstripGoInterfaceMethod[] = []
  let truncated = (methods?.length || 0) > 32
  for (const item of (methods || []).slice(0, 32)) {
    const normalized = {
      interfaceName: item.interfaceName.slice(0, 500),
      concreteType: item.concreteType.slice(0, 500),
      method: item.method.slice(0, 256),
      itabAddress: item.itabAddress.slice(0, 128),
      concreteFunctionAddress: item.concreteFunctionAddress.slice(0, 128),
      incomplete: item.incomplete,
    }
    if (Buffer.byteLength(JSON.stringify([...stored, normalized]), 'utf8') > 16_000) {
      truncated = true
      break
    }
    stored.push(normalized)
  }
  return { serialized: stored.length ? JSON.stringify(stored) : '', truncated }
}

function isFlossRecoveredStrings(value: unknown): value is FlossRecoveredString[] {
  return Array.isArray(value) && value.length <= 32 && value.every((item) => item
    && (item.kind === 'stack' || item.kind === 'tight' || item.kind === 'decoded')
    && typeof item.value === 'string' && item.value.length <= 512
    && (item.encoding === undefined || (typeof item.encoding === 'string' && item.encoding.length <= 32))
    && (item.decodedAt === undefined || (typeof item.decodedAt === 'string' && /^[0-9a-f]{1,16}$/.test(item.decodedAt))))
}

function isGhidraResponse(value: unknown): value is GhidraResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
    && (record.goTypeDetails === undefined || (Array.isArray(record.goTypeDetails)
      && record.goTypeDetails.length <= 1000
      && record.goTypeDetails.every((item) => item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.name === 'string' && item.name.length <= 500
        && typeof item.kind === 'string' && item.kind.length <= 128
        && typeof item.reconstructed === 'string' && item.reconstructed.length <= 4096)))
    && (record.goTypeDetailsTruncated === undefined || typeof record.goTypeDetailsTruncated === 'boolean')
    && (record.goUnstripTypeDetails === undefined || (Array.isArray(record.goUnstripTypeDetails)
      && record.goUnstripTypeDetails.length <= 1000
      && record.goUnstripTypeDetails.every((item) => item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.name === 'string' && item.name.length <= 500
        && typeof item.kind === 'string' && item.kind.length <= 128
        && typeof item.reconstructed === 'string' && item.reconstructed.length <= 4096
        && item.source === 'unstrip')))
    && (record.goUnstripTypeDetailsTruncated === undefined || typeof record.goUnstripTypeDetailsTruncated === 'boolean')
    && (record.goUnstripInterfacesTruncated === undefined || typeof record.goUnstripInterfacesTruncated === 'boolean')
    && (record.swiftMetadataVersion === undefined || record.swiftMetadataVersion === `ReIPA@${REIPA_COMMIT}`)
    && (record.swiftTypeDetails === undefined || (Array.isArray(record.swiftTypeDetails)
      && record.swiftTypeDetails.length <= 1000
      && record.swiftTypeDetails.every((item) => item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 500
        && ['class', 'struct', 'enum', 'type'].includes(item.kind)
        && typeof item.reconstructed === 'string' && item.reconstructed.length <= 512)))
    && (record.objcTypeDetails === undefined || (Array.isArray(record.objcTypeDetails)
      && record.objcTypeDetails.length <= 1000
      && record.objcTypeDetails.every((item) => item && typeof item === 'object' && !Array.isArray(item)
        && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 500
        && (item.kind === 'class' || item.kind === 'category')
        && typeof item.reconstructed === 'string' && item.reconstructed.length <= 4096)))
    && (record.reipaMetadataTruncated === undefined || typeof record.reipaMetadataTruncated === 'boolean')
    && (record.reipaAlternateTruncated === undefined || typeof record.reipaAlternateTruncated === 'boolean')
    && (record.reipaAlternateCodeBytes === undefined || (Number.isInteger(record.reipaAlternateCodeBytes)
      && (record.reipaAlternateCodeBytes as number) >= 0 && (record.reipaAlternateCodeBytes as number) <= 67108864))
    && (record.flossVersion === undefined || record.flossVersion === null || record.flossVersion === '3.1.1')
    && (record.flossRecoveredStringsTruncated === undefined || typeof record.flossRecoveredStringsTruncated === 'boolean')
    && (record.sourceAddressMapTruncated === undefined || typeof record.sourceAddressMapTruncated === 'boolean')
    && (record.recoveredVariablesTruncated === undefined || typeof record.recoveredVariablesTruncated === 'boolean')
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
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({
        projectId: input.projectId,
        artifactId: input.artifactId,
        taskId: input.taskId,
        runId: input.runToken,
        artifactPath: input.artifactPath,
        nativeBcfCleanup: input.options?.nativeBcfCleanup === true,
        nativeCffDeflatten: input.options?.nativeCffDeflatten === true,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1200)
        : `Ghidra analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isGhidraResponse(payload)) throw new Error('Ghidra analyzer returned an invalid result')

    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => {
      if (!unit || typeof unit.name !== 'string' || typeof unit.address !== 'string'
          || typeof unit.relativePath !== 'string' || typeof unit.codeArtifactId !== 'string'
          || !Number.isFinite(unit.sizeBytes) || unit.sizeBytes <= 0
          || (unit.disassemblyArtifactId !== undefined && typeof unit.disassemblyArtifactId !== 'string')
          || (unit.referencedStrings !== undefined && (!Array.isArray(unit.referencedStrings)
            || !unit.referencedStrings.every((value) => typeof value === 'string' && value.length <= 512)))
          || (unit.flossVersion !== undefined && unit.flossVersion !== '3.1.1')
          || (unit.flossRecoveredStrings !== undefined && !isFlossRecoveredStrings(unit.flossRecoveredStrings))
          || (unit.flossRecoveredStringsTruncated !== undefined && typeof unit.flossRecoveredStringsTruncated !== 'boolean')
          || (unit.instructionMnemonics !== undefined && (!Array.isArray(unit.instructionMnemonics)
            || unit.instructionMnemonics.length > 800
            || !unit.instructionMnemonics.every((value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,31}$/.test(value))))
          || (unit.cfgMetrics !== undefined && (!unit.cfgMetrics || unit.cfgMetrics.version !== 'ghidra-basic-blocks-v1'
            || !['blockCount', 'edgeCount', 'entryBlockCount', 'exitBlockCount'].every((key) => {
              const value = unit.cfgMetrics?.[key as keyof GhidraControlFlowMetrics]
              return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= 1_000_000
            }) || typeof unit.cfgMetrics.truncated !== 'boolean'))
          || (unit.cfgGraph !== undefined && (!unit.cfgGraph || unit.cfgGraph.version !== 'ghidra-basic-block-graph-v1'
            || !Number.isInteger(unit.cfgGraph.entryBlock) || unit.cfgGraph.entryBlock < 0
            || !Number.isInteger(unit.cfgGraph.exitBlock) || unit.cfgGraph.exitBlock < 0
            || !Array.isArray(unit.cfgGraph.exitBlocks) || unit.cfgGraph.exitBlocks.length > 32
            || !unit.cfgGraph.exitBlocks.every((block) => Number.isInteger(block) && block >= 0 && block < unit.cfgGraph!.blocks.length)
            || (unit.cfgGraph.exitBlocks.length > 0 && unit.cfgGraph.exitBlock !== unit.cfgGraph.exitBlocks[0])
            || !Number.isSafeInteger(unit.cfgGraph.blockCount) || !Number.isSafeInteger(unit.cfgGraph.edgeCount)
            || !Array.isArray(unit.cfgGraph.blocks) || unit.cfgGraph.blocks.length > 32
            || !Array.isArray(unit.cfgGraph.edges) || unit.cfgGraph.edges.length > 48
            || unit.cfgGraph.blockCount !== unit.cfgGraph.blocks.length || unit.cfgGraph.edgeCount !== unit.cfgGraph.edges.length
            || (unit.cfgGraph.blocks.length > 0 && (unit.cfgGraph.entryBlock >= unit.cfgGraph.blocks.length || unit.cfgGraph.exitBlock >= unit.cfgGraph.blocks.length))
            || !unit.cfgGraph.blocks.every((block, index) => Array.isArray(block) && block.length === 7
              && block[0] === index && typeof block[1] === 'string'
              && Number.isInteger(block[2]) && block[2] >= 0 && Number.isInteger(block[3]) && block[3] >= 0
              && Array.isArray(block[4]) && block[4].every((sample) => typeof sample === 'string')
              && Array.isArray(block[5]) && block[5].every((sample) => typeof sample === 'string')
              && typeof block[6] === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(block[6]))
            || !unit.cfgGraph.edges.every((edge) => Array.isArray(edge) && edge.length === 3
              && Number.isInteger(edge[0]) && edge[0] >= 0 && edge[0] < unit.cfgGraph!.blocks.length
              && Number.isInteger(edge[1]) && edge[1] >= 0 && edge[1] < unit.cfgGraph!.blocks.length
              && typeof edge[2] === 'string')
            || typeof unit.cfgGraph.truncated !== 'boolean'
            || typeof unit.cfgGraph.instructionLabel !== 'string'))
          || (unit.cffRecovery !== undefined && (!unit.cffRecovery || unit.cffRecovery.version !== 'reamon-cff-recovery-v1'
            || typeof unit.cffRecovery.entry !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(unit.cffRecovery.entry)
            || !Number.isFinite(unit.cffRecovery.score) || unit.cffRecovery.score < 0 || unit.cffRecovery.score > 1
            || typeof unit.cffRecovery.lowConfidence !== 'boolean' || typeof unit.cffRecovery.truncated !== 'boolean'
            || !Number.isSafeInteger(unit.cffRecovery.resolved) || unit.cffRecovery.resolved < 0
            || !Number.isSafeInteger(unit.cffRecovery.conditional) || unit.cffRecovery.conditional < 0
            || !Number.isSafeInteger(unit.cffRecovery.unresolved) || unit.cffRecovery.unresolved < 0
            || !Array.isArray(unit.cffRecovery.nodes) || unit.cffRecovery.nodes.length > 32
            || !unit.cffRecovery.nodes.every((node) => node && /^[A-Za-z0-9:_-]{1,128}$/.test(node.head)
              && ['uncond', 'cond', 'multi', 'ret', 'exit', 'unresolved'].includes(node.status)
              && typeof node.pure === 'boolean' && typeof node.complete === 'boolean' && typeof node.selfLoop === 'boolean'
              && Array.isArray(node.successors) && node.successors.length <= 48
              && node.successors.every((address) => typeof address === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(address)))))
          || (unit.sourceAddressMap !== undefined && (!Array.isArray(unit.sourceAddressMap)
            || unit.sourceAddressMap.length > 5000
            || !unit.sourceAddressMap.every((mapping) => mapping && Number.isInteger(mapping.ghidraLineNumber)
              && mapping.ghidraLineNumber > 0 && mapping.ghidraLineNumber <= 1_000_000
              && typeof mapping.address === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(mapping.address))))
          || (unit.prototype !== undefined && (typeof unit.prototype !== 'string' || unit.prototype.length > 2000))
          || (unit.recoveredVariables !== undefined && (!Array.isArray(unit.recoveredVariables)
            || unit.recoveredVariables.length > 100
            || !unit.recoveredVariables.every((variable) => variable && (variable.kind === 'parameter' || variable.kind === 'local')
              && typeof variable.name === 'string' && variable.name.length > 0 && variable.name.length <= 256
              && typeof variable.dataType === 'string' && variable.dataType.length <= 256
              && Number.isInteger(variable.sizeBytes) && variable.sizeBytes >= 0 && variable.sizeBytes <= 65536
              && (variable.parameterIndex === undefined || (variable.kind === 'parameter' && Number.isInteger(variable.parameterIndex) && variable.parameterIndex >= 0 && variable.parameterIndex < 100))
              && (variable.storageStartAddress === undefined || (typeof variable.storageStartAddress === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(variable.storageStartAddress)))
              && (variable.nameLocked === undefined || typeof variable.nameLocked === 'boolean')
              && (variable.typeLocked === undefined || typeof variable.typeLocked === 'boolean'))))
          || (unit.recoveredVariablesTruncated !== undefined && typeof unit.recoveredVariablesTruncated !== 'boolean')
          || (unit.reipaAlternateCodeArtifactId !== undefined && (typeof unit.reipaAlternateCodeArtifactId !== 'string' || unit.reipaAlternateCodeArtifactId.length > 2000))
          || (unit.reipaAlternateOutputSha256 !== undefined && (typeof unit.reipaAlternateOutputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(unit.reipaAlternateOutputSha256)))
          || (unit.reipaAlternateSizeBytes !== undefined && (!Number.isInteger(unit.reipaAlternateSizeBytes) || unit.reipaAlternateSizeBytes <= 0 || unit.reipaAlternateSizeBytes > 131072))
          || (unit.bcfCleanAlternateCodeArtifactId !== undefined && (typeof unit.bcfCleanAlternateCodeArtifactId !== 'string' || unit.bcfCleanAlternateCodeArtifactId.length > 2000))
          || (unit.bcfCleanAlternateOutputSha256 !== undefined && (typeof unit.bcfCleanAlternateOutputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(unit.bcfCleanAlternateOutputSha256)))
          || (unit.bcfCleanAlternateSizeBytes !== undefined && (!Number.isInteger(unit.bcfCleanAlternateSizeBytes) || unit.bcfCleanAlternateSizeBytes <= 0 || unit.bcfCleanAlternateSizeBytes > 131072))
          || (unit.bcfCleanAuditArtifactId !== undefined && (typeof unit.bcfCleanAuditArtifactId !== 'string' || unit.bcfCleanAuditArtifactId.length > 2000))
          || (unit.bcfCleanAuditSha256 !== undefined && (typeof unit.bcfCleanAuditSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(unit.bcfCleanAuditSha256)))
          || (unit.bcfCleanCommit !== undefined && unit.bcfCleanCommit !== BCF_CLEAN_COMMIT)
          || (unit.cffDeflattenAlternateCodeArtifactId !== undefined && (typeof unit.cffDeflattenAlternateCodeArtifactId !== 'string' || unit.cffDeflattenAlternateCodeArtifactId.length > 2000))
          || (unit.cffDeflattenAlternateOutputSha256 !== undefined && (typeof unit.cffDeflattenAlternateOutputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(unit.cffDeflattenAlternateOutputSha256)))
          || (unit.cffDeflattenAlternateSizeBytes !== undefined && (!Number.isInteger(unit.cffDeflattenAlternateSizeBytes) || unit.cffDeflattenAlternateSizeBytes <= 0 || unit.cffDeflattenAlternateSizeBytes > 131072))
          || (unit.cffDeflattenAuditArtifactId !== undefined && (typeof unit.cffDeflattenAuditArtifactId !== 'string' || unit.cffDeflattenAuditArtifactId.length > 2000))
          || (unit.cffDeflattenAuditSha256 !== undefined && (typeof unit.cffDeflattenAuditSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(unit.cffDeflattenAuditSha256)))
          || (unit.cffDeflattenCommit !== undefined && unit.cffDeflattenCommit !== CFF_DEFLATTEN_COMMIT)
          || (unit.sourceLanguage !== undefined && typeof unit.sourceLanguage !== 'string')
          || (unit.symbolSource !== undefined && typeof unit.symbolSource !== 'string')
          || (unit.recoveredNativeSymbolName !== undefined && (typeof unit.recoveredNativeSymbolName !== 'string' || unit.recoveredNativeSymbolName.length > 500))
          || (unit.goPackage !== undefined && typeof unit.goPackage !== 'string')
          || (unit.goUnstripSignature !== undefined && (typeof unit.goUnstripSignature !== 'string' || unit.goUnstripSignature.length > 1000))
          || (unit.goUnstripSourceFile !== undefined && (typeof unit.goUnstripSourceFile !== 'string' || unit.goUnstripSourceFile.length > 500))
          || (unit.goUnstripSourceLine !== undefined && (!Number.isInteger(unit.goUnstripSourceLine) || unit.goUnstripSourceLine <= 0 || unit.goUnstripSourceLine > 10_000_000))
          || (unit.goUnstripInterfaces !== undefined && (!Array.isArray(unit.goUnstripInterfaces) || unit.goUnstripInterfaces.length > 32
            || !unit.goUnstripInterfaces.every((item) => item && typeof item === 'object' && !Array.isArray(item)
              && typeof item.interfaceName === 'string' && item.interfaceName.length <= 500
              && typeof item.concreteType === 'string' && item.concreteType.length <= 500
              && typeof item.method === 'string' && item.method.length <= 256
              && typeof item.itabAddress === 'string' && item.itabAddress.length <= 128
              && typeof item.concreteFunctionAddress === 'string' && item.concreteFunctionAddress.length <= 128
              && typeof item.incomplete === 'boolean')))
          || (unit.goUnstripInterfacesTruncated !== undefined && typeof unit.goUnstripInterfacesTruncated !== 'boolean')) return false
      return true
    })
    if (!units.length) throw new Error('Ghidra did not produce any viewable function decompilations')

    const boundedInterfaceMethods = new Map(units.map((unit) => [unit.address, boundedGoInterfaceMethods(unit.goUnstripInterfaces)]))
    const observations = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: codeUnitKey(input.artifactId!, input.taskId!, unit.address),
      label: unit.name,
      attributes: {
        unitType: 'function',
        ...(nativeFunctionIdentity(input.artifactId!, unit.address)
          ? { identity: nativeFunctionIdentity(input.artifactId!, unit.address)! } : {}),
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        address: unit.address.slice(0, 128),
        relativePath: unit.relativePath.slice(0, 1000),
        sizeBytes: Math.floor(unit.sizeBytes),
        language: 'C',
        ...(unit.sourceLanguage ? { sourceLanguage: unit.sourceLanguage.slice(0, 80) } : {}),
        ...(unit.symbolSource ? { symbolSource: unit.symbolSource.slice(0, 64) } : {}),
        ...(unit.recoveredNativeSymbolName ? { recoveredNativeSymbolName: unit.recoveredNativeSymbolName.slice(0, 500) } : {}),
        ...(unit.goPackage ? { goPackage: unit.goPackage.slice(0, 500) } : {}),
        ...(unit.goUnstripSignature ? { goUnstripSignature: unit.goUnstripSignature.slice(0, 1000) } : {}),
        ...(unit.goUnstripSourceFile ? { goUnstripSourceFile: unit.goUnstripSourceFile.slice(0, 500) } : {}),
        ...(typeof unit.goUnstripSourceLine === 'number' ? { goUnstripSourceLine: unit.goUnstripSourceLine } : {}),
        ...(boundedInterfaceMethods.get(unit.address)?.serialized
          ? { goUnstripInterfaces: boundedInterfaceMethods.get(unit.address)!.serialized } : {}),
        ...(unit.goUnstripInterfacesTruncated || boundedInterfaceMethods.get(unit.address)?.truncated
          ? { goUnstripInterfacesTruncated: true } : {}),
        ...(typeof input.targetProfile.architecture === 'string' && input.targetProfile.architecture
          ? { architecture: input.targetProfile.architecture.slice(0, 128) } : {}),
        ...(typeof payload.instructionArchitecture === 'string' && payload.instructionArchitecture
          ? { instructionArchitecture: payload.instructionArchitecture.slice(0, 128) } : {}),
        decompiled: true,
        codeArtifactId: unit.codeArtifactId.slice(0, 2000),
        ...(unit.reipaAlternateCodeArtifactId && unit.reipaAlternateOutputSha256 && unit.reipaAlternateSizeBytes
          ? {
            reipaAlternateCodeArtifactId: unit.reipaAlternateCodeArtifactId.slice(0, 2000),
            reipaAlternateOutputSha256: unit.reipaAlternateOutputSha256,
            reipaAlternateSizeBytes: unit.reipaAlternateSizeBytes,
            reipaAlternateProviderVersion: `ReIPA@${REIPA_COMMIT}`,
          }
          : {}),
        ...(unit.bcfCleanAlternateCodeArtifactId && unit.bcfCleanAlternateOutputSha256 && unit.bcfCleanAlternateSizeBytes
          && unit.bcfCleanAuditArtifactId && unit.bcfCleanAuditSha256 && unit.bcfCleanCommit === BCF_CLEAN_COMMIT
          ? {
            bcfCleanAlternateCodeArtifactId: unit.bcfCleanAlternateCodeArtifactId.slice(0, 2000),
            bcfCleanAlternateOutputSha256: unit.bcfCleanAlternateOutputSha256,
            bcfCleanAlternateSizeBytes: unit.bcfCleanAlternateSizeBytes,
            bcfCleanAuditArtifactId: unit.bcfCleanAuditArtifactId.slice(0, 2000),
            bcfCleanAuditSha256: unit.bcfCleanAuditSha256,
            bcfCleanProviderVersion: `BcfClean@${unit.bcfCleanCommit}`,
          }
          : {}),
        ...(unit.cffDeflattenAlternateCodeArtifactId && unit.cffDeflattenAlternateOutputSha256 && unit.cffDeflattenAlternateSizeBytes
          && unit.cffDeflattenAuditArtifactId && unit.cffDeflattenAuditSha256 && unit.cffDeflattenCommit === CFF_DEFLATTEN_COMMIT
          ? {
            cffDeflattenAlternateCodeArtifactId: unit.cffDeflattenAlternateCodeArtifactId.slice(0, 2000),
            cffDeflattenAlternateOutputSha256: unit.cffDeflattenAlternateOutputSha256,
            cffDeflattenAlternateSizeBytes: unit.cffDeflattenAlternateSizeBytes,
            cffDeflattenAuditArtifactId: unit.cffDeflattenAuditArtifactId.slice(0, 2000),
            cffDeflattenAuditSha256: unit.cffDeflattenAuditSha256,
            cffDeflattenProviderVersion: `CffDeflatten@${unit.cffDeflattenCommit}`,
          }
          : {}),
        ...(unit.disassemblyArtifactId ? { disassemblyArtifactId: unit.disassemblyArtifactId.slice(0, 2000) } : {}),
        ...(unit.referencedStrings?.length ? { referencedStrings: JSON.stringify(unit.referencedStrings.slice(0, 12).map((value) => value.slice(0, 512))) } : {}),
        ...(unit.flossVersion ? { flossVersion: unit.flossVersion } : {}),
        ...(unit.flossRecoveredStrings?.length ? { flossRecoveredStrings: JSON.stringify(unit.flossRecoveredStrings.slice(0, 32)) } : {}),
        ...(unit.flossRecoveredStringsTruncated ? { flossRecoveredStringsTruncated: true } : {}),
        ...(unit.instructionMnemonics?.length ? { instructionMnemonics: JSON.stringify(unit.instructionMnemonics.slice(0, 800)) } : {}),
        ...(unit.cfgMetrics ? { controlFlowMetrics: JSON.stringify(unit.cfgMetrics) } : {}),
        ...(unit.cfgGraph ? { controlFlowGraph: JSON.stringify(unit.cfgGraph) } : {}),
        ...(unit.cffRecovery ? { controlFlowFlattening: JSON.stringify(unit.cffRecovery) } : {}),
        ...(unit.sourceAddressMap?.length ? { sourceAddressMap: JSON.stringify(unit.sourceAddressMap.slice(0, 5000)) } : {}),
        ...(unit.prototype ? { prototype: unit.prototype.slice(0, 2000) } : {}),
        ...(unit.recoveredVariables?.length ? { recoveredVariables: JSON.stringify(unit.recoveredVariables.slice(0, 100)) } : {}),
        ...(unit.recoveredVariablesTruncated ? { recoveredVariablesTruncated: true } : {}),
        ...(payload.sourceAddressMapTruncated ? { sourceAddressMapTruncated: true } : {}),
      },
    })) as ToolObservation[]
    const goTypes = Array.isArray(payload.goTypes)
      ? payload.goTypes.slice(0, 1000).filter((value) => typeof value === 'string').map((value) => value.slice(0, 500))
      : []
    if (payload.recoveredLanguage === 'Go') {
      const storedGoTypes: string[] = []
      for (const name of goTypes) {
        if (JSON.stringify([...storedGoTypes, name]).length > 3500) break
        storedGoTypes.push(name)
      }
      const goTypeDetails = (payload.goTypeDetails || []).slice(0, 1000)
      const storedGoTypeDetails: typeof goTypeDetails = []
      for (const detail of goTypeDetails) {
        if (Buffer.byteLength(JSON.stringify([...storedGoTypeDetails, detail]), 'utf8') > 16_000) break
        storedGoTypeDetails.push(detail)
      }
      const unstripTypeDetails = (payload.goUnstripTypeDetails || []).slice(0, 1000)
      const storedUnstripTypeDetails: typeof unstripTypeDetails = []
      for (const detail of unstripTypeDetails) {
        if (Buffer.byteLength(JSON.stringify([...storedUnstripTypeDetails, detail]), 'utf8') > 16_000) break
        storedUnstripTypeDetails.push(detail)
      }
      const goMetadata = {
        kind: 'entity',
        type: 'language_metadata',
        key: `ghidra:go-metadata:${createHash('sha256').update(input.artifactId!).digest('hex').slice(0, 32)}`,
        label: `Go ${payload.goVersion || 'binary metadata'}`,
        attributes: {
          identity: `${input.artifactId}:go-metadata`,
          language: 'Go',
          symbolSource: 'GoReSym',
          ...(typeof payload.goVersion === 'string' ? { goVersion: payload.goVersion.slice(0, 128) } : {}),
          ...(typeof payload.goArchitecture === 'string' ? { goArchitecture: payload.goArchitecture.slice(0, 128) } : {}),
          recoveredFunctionCount: units.filter((unit) => unit.symbolSource === 'GoReSym').length,
          types: JSON.stringify(storedGoTypes),
          typeDetails: JSON.stringify(storedGoTypeDetails),
          typeDetailsTruncated: payload.goTypeDetailsTruncated === true || storedGoTypeDetails.length < goTypeDetails.length,
          unstripTypeDetails: JSON.stringify(storedUnstripTypeDetails),
          unstripTypeDetailsTruncated: payload.goUnstripTypeDetailsTruncated === true
            || storedUnstripTypeDetails.length < unstripTypeDetails.length,
          unstripInterfacesTruncated: payload.goUnstripInterfacesTruncated === true
            || units.some((unit) => unit.goUnstripInterfacesTruncated === true),
          unstripVersion: '1.2.0',
        },
      } satisfies ToolObservation
      observations.push(goMetadata)
    }
    const swiftTypeDetails = (payload.swiftTypeDetails || []).slice(0, 1000)
    if (swiftTypeDetails.length) {
      const storedSwiftTypeDetails: typeof swiftTypeDetails = []
      for (const detail of swiftTypeDetails) {
        if (Buffer.byteLength(JSON.stringify([...storedSwiftTypeDetails, detail]), 'utf8') > 16_000) break
        storedSwiftTypeDetails.push(detail)
      }
      observations.push({
        kind: 'entity',
        type: 'language_metadata',
        key: `ghidra:swift-metadata:${createHash('sha256').update(input.artifactId!).digest('hex').slice(0, 32)}`,
        label: `Swift type metadata (${storedSwiftTypeDetails.length})`,
        attributes: {
          identity: `${input.artifactId}:swift-metadata`,
          language: 'Swift',
          symbolSource: 'ReIPA',
          ...(payload.swiftMetadataVersion ? { providerVersion: payload.swiftMetadataVersion } : {}),
          typeDetails: JSON.stringify(storedSwiftTypeDetails),
          typeDetailsTruncated: payload.reipaMetadataTruncated === true || storedSwiftTypeDetails.length < swiftTypeDetails.length,
        },
      } satisfies ToolObservation)
    }
    const objcTypeDetails = (payload.objcTypeDetails || []).slice(0, 1000)
    if (objcTypeDetails.length) {
      const storedObjcTypeDetails: typeof objcTypeDetails = []
      for (const detail of objcTypeDetails) {
        if (Buffer.byteLength(JSON.stringify([...storedObjcTypeDetails, detail]), 'utf8') > 16_000) break
        storedObjcTypeDetails.push(detail)
      }
      observations.push({
        kind: 'entity',
        type: 'language_metadata',
        key: `ghidra:objc-metadata:${createHash('sha256').update(input.artifactId!).digest('hex').slice(0, 32)}`,
        label: `Objective-C runtime metadata (${storedObjcTypeDetails.length})`,
        attributes: {
          identity: `${input.artifactId}:objc-metadata`,
          language: 'Objective-C',
          symbolSource: 'ReIPA',
          ...(payload.swiftMetadataVersion ? { providerVersion: payload.swiftMetadataVersion } : {}),
          typeDetails: JSON.stringify(storedObjcTypeDetails),
          typeDetailsTruncated: payload.reipaMetadataTruncated === true || storedObjcTypeDetails.length < objcTypeDetails.length,
        },
      } satisfies ToolObservation)
    }
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
              ...(payload.recoveredLanguage === 'Go' ? { sourceLanguage: 'Go' } : {}),
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
        recoveredLanguage: payload.recoveredLanguage === 'Go' ? 'Go' : null,
        goVersion: typeof payload.goVersion === 'string' ? payload.goVersion.slice(0, 128) : null,
        goArchitecture: typeof payload.goArchitecture === 'string' ? payload.goArchitecture.slice(0, 128) : null,
        goTypes,
        goRecoveredFunctionCount: units.filter((unit) => unit.symbolSource === 'GoReSym').length,
        warnings: payload.warnings?.slice(0, 4000) || '',
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const ghidraPlugin: ToolPlugin = { manifest: ghidraManifest, analyze: executeGhidra }
