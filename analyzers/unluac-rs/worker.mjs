import { parentPort, workerData } from 'node:worker_threads'
import { decompileRich } from 'unluac-js'

const MAX_PROTOS = 100
const MAX_BLOCKS_PER_CFG = 32
const MAX_EDGES_PER_CFG = 48

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function summarizeProto(proto, cfg) {
  const blocks = Array.isArray(cfg?.blocks) ? cfg.blocks : []
  const edges = Array.isArray(cfg?.edges) ? cfg.edges : []
  const blockOrder = Array.isArray(cfg?.blockOrder) ? cfg.blockOrder : []
  const constants = Array.isArray(proto?.constants) ? proto.constants : []
  const summary = {
    protoId: boundedInteger(proto?.id),
    name: typeof proto?.name === 'string' ? proto.name.slice(0, 500) : null,
    lineStart: boundedInteger(proto?.lineStart),
    lineEnd: boundedInteger(proto?.lineEnd),
    numParams: boundedInteger(proto?.numParams),
    isVararg: proto?.isVararg === true,
    numUpvalues: boundedInteger(proto?.numUpvalues),
    numConstants: boundedInteger(proto?.numConstants),
    numInstructions: boundedInteger(proto?.numInstructions),
    children: Array.isArray(proto?.children) ? proto.children.filter((id) => Number.isSafeInteger(id) && id >= 0).slice(0, MAX_PROTOS) : [],
    constants: constants.slice(0, 8).map((constant) => ({
      index: boundedInteger(constant?.index),
      type: typeof constant?.type === 'string' ? constant.type.slice(0, 40) : 'unknown',
      display: typeof constant?.display === 'string' ? constant.display.slice(0, 120) : '',
    })),
    cfg: {
      entryBlock: boundedInteger(cfg?.entryBlock),
      exitBlock: boundedInteger(cfg?.exitBlock),
      blockCount: blocks.length,
      edgeCount: edges.length,
      blockOrder: blockOrder.slice(0, MAX_BLOCKS_PER_CFG).filter((id) => Number.isSafeInteger(id) && id >= 0),
      blocks: blocks.slice(0, MAX_BLOCKS_PER_CFG).map((block) => ({
        id: boundedInteger(block?.id),
        kind: typeof block?.kind === 'string' ? block.kind.slice(0, 40) : 'unknown',
        instructionCount: Array.isArray(block?.instructions) ? block.instructions.length : 0,
        rawInstructionCount: Array.isArray(block?.rawInstructions) ? block.rawInstructions.length : 0,
      })),
      edges: edges.slice(0, MAX_EDGES_PER_CFG).map((edge) => ({
        from: boundedInteger(edge?.from),
        to: boundedInteger(edge?.to),
        kind: typeof edge?.kind === 'string' ? edge.kind.slice(0, 40) : 'unknown',
      })),
    },
  }
  return summary
}

try {
  const result = await decompileRich(new Uint8Array(workerData.bytes), {
    dialect: 'lua5.5',
    generate: { mode: 'strict' },
  })
  if (result.kind !== 'source' || typeof result.source !== 'string' || !result.source.trim()) {
    throw new Error('unluac-rs returned diagnostic pseudocode instead of Lua source')
  }
  const protos = Array.isArray(result.protos) ? result.protos : []
  const cfgs = Array.isArray(result.cfgs) ? result.cfgs : []
  const functions = protos.slice(0, MAX_PROTOS).map((proto, index) => summarizeProto(proto, cfgs[index]))
  parentPort.postMessage({
    ok: true,
    source: result.source,
    functions,
    protoCount: protos.length,
    metadataTruncated: protos.length > MAX_PROTOS || cfgs.length !== protos.length
      || functions.some(({ cfg, children, constants }, index) => cfg.blockCount > MAX_BLOCKS_PER_CFG
        || cfg.edgeCount > MAX_EDGES_PER_CFG
        || (Array.isArray(protos[index]?.children) && protos[index].children.length > children.length)
        || (Array.isArray(protos[index]?.constants) && protos[index].constants.length > constants.length)
        || (Array.isArray(cfgs[index]?.blockOrder) && cfgs[index].blockOrder.length > cfg.blockOrder.length)),
  })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Lua 5.5 decompilation failed' })
}
