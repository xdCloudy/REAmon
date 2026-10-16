import { parentPort, workerData } from 'node:worker_threads'
import { decompileRich, detectDialect } from 'unluac-js'

const MAX_PROTOS = 100
const MAX_BLOCKS_PER_CFG = 32
const MAX_EDGES_PER_CFG = 48
const MAX_INSTRUCTION_SAMPLE_BLOCKS = 6
const MAX_SIMILARITY_INSTRUCTIONS = 800

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function instructionMnemonics(cfg, blockOrder) {
  const blocks = Array.isArray(cfg?.blocks) ? cfg.blocks : []
  const blocksById = new Map(blocks.map((block) => [boundedInteger(block?.id), block]))
  const orderedBlocks = Array.isArray(blockOrder) && blockOrder.length
    ? blockOrder.map((id) => blocksById.get(id)).filter(Boolean)
    : blocks
  const mnemonics = []
  for (const block of orderedBlocks) {
    if (!Array.isArray(block?.rawInstructions)) continue
    for (const rawLine of block.rawInstructions) {
      if (typeof rawLine !== 'string') continue
      for (const rawInstruction of rawLine.split(';')) {
        const mnemonic = /^\s*([A-Z][A-Z0-9_]*)\b/.exec(rawInstruction)?.[1]
        if (!mnemonic) continue
        mnemonics.push(mnemonic)
        if (mnemonics.length >= MAX_SIMILARITY_INSTRUCTIONS) return mnemonics
      }
    }
  }
  return mnemonics
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
    instructionMnemonics: instructionMnemonics(cfg, blockOrder),
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
      blocks: blocks.slice(0, MAX_BLOCKS_PER_CFG).map((block, index) => ({
        id: boundedInteger(block?.id),
        kind: typeof block?.kind === 'string' ? block.kind.slice(0, 40) : 'unknown',
        instructionCount: Array.isArray(block?.instructions) ? block.instructions.length : 0,
        rawInstructionCount: Array.isArray(block?.rawInstructions) ? block.rawInstructions.length : 0,
        instructionSamples: index < MAX_INSTRUCTION_SAMPLE_BLOCKS && Array.isArray(block?.instructions)
          ? block.instructions.slice(0, 1).filter((line) => typeof line === 'string').map((line) => line.slice(0, 100))
          : [],
        rawInstructionSamples: index < MAX_INSTRUCTION_SAMPLE_BLOCKS && Array.isArray(block?.rawInstructions)
          ? block.rawInstructions.slice(0, 1).filter((line) => typeof line === 'string').map((line) => line.slice(0, 100))
          : [],
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
  const dialect = await detectDialect(new Uint8Array(workerData.bytes))
  if (!['luau', 'lua5.1', 'lua5.2', 'lua5.3', 'lua5.4', 'lua5.5', 'luajit'].includes(dialect)) {
    throw new Error('Input is not supported Lua 5.1–5.5, LuaJIT, or Luau bytecode')
  }
  const configuredVectorSize = process.env.UNLUAC_RS_LUAU_VECTOR_SIZE || '3'
  const vectorLibrary = process.env.UNLUAC_RS_LUAU_VECTOR_LIBRARY || 'vector'
  const vectorConstructorName = process.env.UNLUAC_RS_LUAU_VECTOR_CONSTRUCTOR || 'create'
  if (dialect === 'luau' && !['3', '4'].includes(configuredVectorSize)) {
    throw new Error('UNLUAC_RS_LUAU_VECTOR_SIZE must be 3 or 4')
  }
  if (dialect === 'luau' && (![vectorLibrary, vectorConstructorName].every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))) {
    throw new Error('Luau vector constructor names must be identifiers')
  }
  const vectorSize = dialect === 'luau' ? Number(configuredVectorSize) : null
  const vectorConstructor = dialect === 'luau'
    ? { library: vectorLibrary, constructor: vectorConstructorName, size: vectorSize }
    : null
  const result = await decompileRich(new Uint8Array(workerData.bytes), {
    dialect,
    generate: {
      mode: 'strict',
      ...(vectorConstructor ? { luauVectorConstructor: vectorConstructor } : {}),
    },
  })
  if (result.kind !== 'source' || typeof result.source !== 'string' || !result.source.trim()) {
    throw new Error('unluac-rs returned diagnostic pseudocode instead of Lua source')
  }
  const protos = Array.isArray(result.protos) ? result.protos : []
  const cfgs = Array.isArray(result.cfgs) ? result.cfgs : []
  const functions = protos.slice(0, MAX_PROTOS).map((proto, index) => summarizeProto(proto, cfgs[index]))
  parentPort.postMessage({
    ok: true,
    dialect,
    vectorConstructor: vectorConstructor ? `${vectorConstructor.library}.${vectorConstructor.constructor}` : null,
    vectorSize: vectorConstructor?.size ?? null,
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
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Lua bytecode decompilation failed' })
}
