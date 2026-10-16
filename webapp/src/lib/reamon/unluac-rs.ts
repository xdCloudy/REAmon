import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 10 * 60_000

interface Lua55Response {
  status: 'completed'
  toolVersion: string
  input: { relativePath: string; sha256: string }
  unit: { name: string; relativePath: string; codeArtifactId: string; sizeBytes: number }
  functions: Lua55FunctionMetadata[]
  protoCount: number
  metadataTruncated: boolean
  codeBytes: number
  warnings?: string
}

interface Lua55FunctionMetadata {
  protoId: number
  name: string | null
  lineStart: number
  lineEnd: number
  numParams: number
  isVararg: boolean
  numUpvalues: number
  numConstants: number
  numInstructions: number
  children: number[]
  constants: Array<{ index: number; type: string; display: string }>
  cfg: {
    entryBlock: number
    exitBlock: number
    blockCount: number
    edgeCount: number
    blockOrder: number[]
    blocks: Array<{ id: number; kind: string; instructionCount: number; rawInstructionCount: number }>
    edges: Array<{ from: number; to: number; kind: string }>
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFunctionMetadata(value: unknown): value is Lua55FunctionMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = value as Record<string, unknown>
  const cfg = proto.cfg
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false
  const graph = cfg as Record<string, unknown>
  return isNonNegativeInteger(proto.protoId)
    && (proto.name === null || (typeof proto.name === 'string' && proto.name.length <= 500))
    && isNonNegativeInteger(proto.lineStart) && isNonNegativeInteger(proto.lineEnd)
    && isNonNegativeInteger(proto.numParams) && typeof proto.isVararg === 'boolean'
    && isNonNegativeInteger(proto.numUpvalues) && isNonNegativeInteger(proto.numConstants)
    && isNonNegativeInteger(proto.numInstructions)
    && Array.isArray(proto.children) && proto.children.length <= 100 && proto.children.every(isNonNegativeInteger)
    && Array.isArray(proto.constants) && proto.constants.length <= 8
    && proto.constants.every((constant) => !!constant && typeof constant === 'object' && !Array.isArray(constant)
      && isNonNegativeInteger((constant as Record<string, unknown>).index)
      && typeof (constant as Record<string, unknown>).type === 'string'
      && typeof (constant as Record<string, unknown>).display === 'string')
    && isNonNegativeInteger(graph.entryBlock) && isNonNegativeInteger(graph.exitBlock)
    && isNonNegativeInteger(graph.blockCount) && isNonNegativeInteger(graph.edgeCount)
    && Array.isArray(graph.blockOrder) && graph.blockOrder.length <= 32 && graph.blockOrder.every(isNonNegativeInteger)
    && Array.isArray(graph.blocks) && graph.blocks.length <= 32
    && graph.blocks.every((block) => !!block && typeof block === 'object' && !Array.isArray(block)
      && isNonNegativeInteger((block as Record<string, unknown>).id)
      && typeof (block as Record<string, unknown>).kind === 'string'
      && isNonNegativeInteger((block as Record<string, unknown>).instructionCount)
      && isNonNegativeInteger((block as Record<string, unknown>).rawInstructionCount))
    && Array.isArray(graph.edges) && graph.edges.length <= 48
    && graph.edges.every((edge) => !!edge && typeof edge === 'object' && !Array.isArray(edge)
      && isNonNegativeInteger((edge as Record<string, unknown>).from)
      && isNonNegativeInteger((edge as Record<string, unknown>).to)
      && typeof (edge as Record<string, unknown>).kind === 'string')
}

export const unluacRsManifest: ToolPluginManifest = {
  id: 'reamon-unluac-rs',
  name: 'Lua 5.5 Bytecode Decompiler (unluac-rs)',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['lua-bytecode-5.5'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'LuaModule'],
  requirements: [
    { key: 'service', value: 'Isolated unluac-rs analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4_000) || 'Lua 5.5 decompilation failed'
}

function timeoutMs(): number {
  const value = Number(process.env.REAMON_UNLUAC_RS_REQUEST_TIMEOUT_MS)
  return Number.isFinite(value) ? Math.min(MAX_TIMEOUT_MS, Math.max(10_000, Math.floor(value))) : DEFAULT_TIMEOUT_MS
}

function isResponse(value: unknown): value is Lua55Response {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (!response.input || typeof response.input !== 'object' || Array.isArray(response.input)) return false
  const input = response.input as Record<string, unknown>
  if (!response.unit || typeof response.unit !== 'object' || Array.isArray(response.unit)) return false
  const unit = response.unit as Record<string, unknown>
  const functions = response.functions
  return response.status === 'completed'
    && typeof response.toolVersion === 'string' && response.toolVersion.length <= 80
    && typeof input.relativePath === 'string' && input.relativePath.length > 0 && input.relativePath.length <= 1_000
    && typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(input.sha256)
    && typeof response.codeBytes === 'number' && Number.isSafeInteger(response.codeBytes) && response.codeBytes > 0
    && typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
    && typeof unit.relativePath === 'string' && unit.relativePath.length > 0 && unit.relativePath.length <= 1_000
    && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId.length > 0 && unit.codeArtifactId.length <= 2_000
    && typeof unit.sizeBytes === 'number' && Number.isSafeInteger(unit.sizeBytes) && unit.sizeBytes > 0
    && Array.isArray(functions) && functions.length <= 100 && functions.every(isFunctionMetadata)
    && Number.isSafeInteger(response.protoCount) && (response.protoCount as number) >= functions.length
    && typeof response.metadataTruncated === 'boolean'
    && (response.warnings === undefined || typeof response.warnings === 'string')
}

export async function executeUnluacRs(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: unluacRsManifest.id,
    capabilities: unluacRsManifest.capabilities,
    produced: unluacRsManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Lua 5.5 decompilation requires a stored bytecode artifact and task context' }
  }

  const baseUrl = process.env.REAMON_UNLUAC_RS_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated unluac-rs analyzer is not configured' }

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
        artifactRelativePath: input.artifactRelativePath,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1_000)
        : `unluac-rs analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('unluac-rs analyzer returned an invalid result')

    const unit = payload.unit
    const identity = `${input.artifactId}:${unit.relativePath}`
    const key = `unluac-rs:module:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
    const observations: ToolObservation[] = [{
      kind: 'entity',
      type: 'code_unit',
      key,
      label: unit.name,
      attributes: {
        unitType: 'module',
        identity,
        name: unit.name,
        qualifiedName: unit.name,
        relativePath: unit.relativePath,
        sizeBytes: unit.sizeBytes,
        language: 'Lua',
        decompiled: true,
        codeArtifactId: unit.codeArtifactId,
        inputSha256: payload.input.sha256,
        engineVersion: payload.toolVersion,
      },
    }]
    const functions = payload.functions.filter((proto) => proto.protoId > 0)
    const functionKeys = new Map<number, string>()
    for (const proto of functions) {
      const functionKey = `unluac-rs:function:${createHash('sha256').update(`${identity}:proto:${proto.protoId}`).digest('hex').slice(0, 32)}`
      functionKeys.set(proto.protoId, functionKey)
      const protoName = `proto_${proto.protoId}`
      const constants = JSON.stringify(proto.constants)
      const controlFlowGraph = JSON.stringify({
        entryBlock: proto.cfg.entryBlock,
        exitBlock: proto.cfg.exitBlock,
        blockCount: proto.cfg.blockCount,
        edgeCount: proto.cfg.edgeCount,
        blocks: proto.cfg.blocks.map((block) => [block.id, block.kind, block.instructionCount, block.rawInstructionCount]),
        edges: proto.cfg.edges.map((edge) => [edge.from, edge.to, edge.kind]),
      })
      observations.push({
        kind: 'entity',
        type: 'function',
        key: functionKey,
        label: `Lua prototype ${proto.protoId}`,
        attributes: {
          identity: `${identity}:proto:${proto.protoId}`,
          name: protoName,
          qualifiedName: `${unit.name}::${protoName}`,
          address: `proto:${proto.protoId}`,
          language: 'Lua',
          memberKind: 'function',
          parentCodeUnitKey: key,
          codeArtifactId: unit.codeArtifactId,
          engineVersion: payload.toolVersion,
          debugSourceName: proto.name,
          debugLineStart: proto.lineStart,
          debugLineEnd: proto.lineEnd,
          parameterCount: proto.numParams,
          isVararg: proto.isVararg,
          upvalueCount: proto.numUpvalues,
          constantCount: proto.numConstants,
          instructionCount: proto.numInstructions,
          childProtoIds: JSON.stringify(proto.children),
          constants,
          controlFlowGraph,
        },
      })
    }
    for (const proto of functions) {
      const parentKey = functionKeys.get(proto.protoId)
      if (!parentKey) continue
      for (const childProtoId of proto.children) {
        const childKey = functionKeys.get(childProtoId)
        if (!childKey) continue
        observations.push({
          kind: 'relationship',
          type: 'contains',
          key: `unluac-rs:contains:${createHash('sha256').update(identity).digest('hex').slice(0, 24)}:${proto.protoId}:${childProtoId}`,
          relation: 'contains',
          fromKey: parentKey,
          toKey: childKey,
          attributes: { engineVersion: payload.toolVersion, relationshipEvidence: 'Lua prototype child table' },
        })
      }
    }
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        decompiledModuleCount: 1,
        returnedModuleCount: 1,
        discoveredPrototypeCount: payload.protoCount,
        returnedFunctionCount: functions.length,
        functionMetadataTruncated: payload.metadataTruncated || payload.protoCount > payload.functions.length,
        codeBytes: payload.codeBytes,
        truncated: false,
        toolVersion: payload.toolVersion,
        warnings: (payload.warnings || '').slice(0, 4_000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const unluacRsPlugin: ToolPlugin = { manifest: unluacRsManifest, analyze: executeUnluacRs }
