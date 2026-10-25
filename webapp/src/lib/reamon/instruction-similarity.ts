import { nativeArchitectureGroup } from './native-function-identity'

const MAX_SIGNATURE = 800
const MIN_FUNCTION_LENGTH = 4
const MAX_ORDERED_CANDIDATES = 150
const MAX_CFG_BLOCKS = 32
const MAX_CFG_EDGES = 48

export interface SimilarFunctionControlFlowMetrics {
  blockCount: number
  edgeCount: number
  entryBlockCount: number
  exitBlockCount: number
  truncated: boolean
}

export interface SimilarFunctionControlFlowGraph {
  version: 'reamon-normalized-cfg-v1'
  entryBlock: number
  exitBlocks: number[]
  blockCount: number
  edgeCount: number
  truncated: false
  blocks: Array<[number, string, number, number, string[], string[], string]>
  edges: Array<[number, number, string]>
}

export interface SimilarInstructionFunction {
  key: string
  name: string
  address: string | null
  mnemonics: string[]
  referencedStrings?: string[]
  controlFlowMetrics?: SimilarFunctionControlFlowMetrics
  controlFlowGraph?: SimilarFunctionControlFlowGraph
}

export interface RankedSimilarInstructionFunction extends SimilarInstructionFunction {
  similarity: number
  instructionSimilarity: number
  controlFlowSimilarity: number | null
  controlFlowTopologySimilarity: number | null
  stringReferenceSimilarity: number | null
}

export interface InstructionSequenceIdentity {
  providerId: string
  artifactId: string | null
  attributes: unknown
}

/** Match only instruction sequences with a shared, explicit execution vocabulary. */
export function instructionSequenceFamily(input: InstructionSequenceIdentity): string | null {
  const attributes = input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes)
    ? input.attributes as Record<string, unknown>
    : {}
  const nativeArchitecture = nativeArchitectureGroup(attributes)
  if (nativeArchitecture) return `native:${nativeArchitecture}`

  const language = [attributes.instructionLanguage, attributes.disassemblyLanguage, attributes.dialect]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (language) {
    const normalized = language.toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (['asm', 'assembly', 'disassembly', 'machinecode', 'bytecode'].includes(normalized)) {
      return input.providerId && input.artifactId
        ? `provider-artifact:${input.providerId}:${input.artifactId}`
        : null
    }
    if (normalized === 'dalvik' || normalized === 'smali') return 'bytecode:dex'
    if (normalized === 'il' || normalized === 'cil' || normalized === 'msil' || normalized === 'ecma335') return 'bytecode:dotnet-il'
    if (normalized === 'wat' || normalized === 'wasm' || normalized.includes('webassembly')) return 'bytecode:wasm'
    if (normalized === 'luajit') return 'bytecode:luajit'
    if (/^lua5[1-5]$/.test(normalized)) return `bytecode:${normalized}`
    return `bytecode:${normalized}`
  }

  return input.providerId && input.artifactId
    ? `provider-artifact:${input.providerId}:${input.artifactId}`
    : null
}

export function instructionSequencesAreCompatible(left: InstructionSequenceIdentity, right: InstructionSequenceIdentity): boolean {
  const family = instructionSequenceFamily(left)
  return family !== null && family === instructionSequenceFamily(right)
}

function cosineSimilarity(left: string[], right: string[]): number {
  const leftCounts = new Map<string, number>()
  const rightCounts = new Map<string, number>()
  for (const mnemonic of left) leftCounts.set(mnemonic, (leftCounts.get(mnemonic) || 0) + 1)
  for (const mnemonic of right) rightCounts.set(mnemonic, (rightCounts.get(mnemonic) || 0) + 1)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (const count of leftCounts.values()) leftNorm += count * count
  for (const [mnemonic, count] of rightCounts) {
    rightNorm += count * count
    dot += count * (leftCounts.get(mnemonic) || 0)
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

function stringReferenceSimilarity(left: string[] | undefined, right: string[] | undefined): number | null {
  if (!left?.length || !right?.length) return null
  const leftValues = new Set(left)
  const rightValues = new Set(right)
  let shared = 0
  for (const value of leftValues) if (rightValues.has(value)) shared += 1
  return (2 * shared) / (leftValues.size + rightValues.size)
}

export function parseControlFlowMetrics(value: unknown): SimilarFunctionControlFlowMetrics | undefined {
  const parsed = parseBoundedJsonObject(value, 512)
  if (!parsed) return undefined
  const counts = ['blockCount', 'edgeCount', 'entryBlockCount', 'exitBlockCount'] as const
  if (parsed.version !== 'ghidra-basic-blocks-v1' || typeof parsed.truncated !== 'boolean'
      || !counts.every((key) => Number.isSafeInteger(parsed[key])
        && typeof parsed[key] === 'number' && (parsed[key] as number) >= 0 && (parsed[key] as number) <= 1_000_000)) return undefined
  return {
    blockCount: parsed.blockCount as number,
    edgeCount: parsed.edgeCount as number,
    entryBlockCount: parsed.entryBlockCount as number,
    exitBlockCount: parsed.exitBlockCount as number,
    truncated: parsed.truncated,
  }
}

export function parseControlFlowGraph(value: unknown, externallyTruncated?: unknown): SimilarFunctionControlFlowGraph | undefined {
  const parsed = parseBoundedJsonObject(value, 4_096)
  if (!parsed || (parsed.version !== undefined && parsed.version !== 'ghidra-basic-block-graph-v1')
      || (parsed.version === 'ghidra-basic-block-graph-v1' && typeof parsed.truncated !== 'boolean')
      || parsed.truncated === true || externallyTruncated === true
      || !Number.isSafeInteger(parsed.entryBlock) || typeof parsed.entryBlock !== 'number'
      || !Number.isSafeInteger(parsed.exitBlock) || typeof parsed.exitBlock !== 'number'
      || !Number.isSafeInteger(parsed.blockCount) || typeof parsed.blockCount !== 'number'
      || !Number.isSafeInteger(parsed.edgeCount) || typeof parsed.edgeCount !== 'number'
      || !Array.isArray(parsed.blocks) || !Array.isArray(parsed.edges)) return undefined
  const { blocks, edges } = parsed
  if (blocks.length === 0 || blocks.length > MAX_CFG_BLOCKS || edges.length > MAX_CFG_EDGES
      || parsed.blockCount !== blocks.length || parsed.edgeCount !== edges.length
      || (Array.isArray(parsed.exitBlocks) && parsed.exitBlocks.length > MAX_CFG_BLOCKS)) return undefined

  const blockIndexes = new Map<number, number>()
  const normalizedBlocks: SimilarFunctionControlFlowGraph['blocks'] = []
  for (const [index, rawBlock] of blocks.entries()) {
    if (!Array.isArray(rawBlock) || (rawBlock.length !== 4 && rawBlock.length !== 6 && rawBlock.length !== 7)
        || (parsed.version === 'ghidra-basic-block-graph-v1' && rawBlock.length !== 7)) return undefined
    const [id, kind, instructionCount, rawInstructionCount] = rawBlock
    const instructionSamples = rawBlock.length >= 6 ? rawBlock[4] : []
    const rawInstructionSamples = rawBlock.length >= 6 ? rawBlock[5] : []
    const blockLabel = rawBlock.length === 7 ? rawBlock[6] : kind
    if (!Number.isSafeInteger(id) || typeof id !== 'number' || id < 0 || blockIndexes.has(id)
        || typeof kind !== 'string' || kind.length > 128
        || !Number.isSafeInteger(instructionCount) || typeof instructionCount !== 'number' || instructionCount < 0
        || !Number.isSafeInteger(rawInstructionCount) || typeof rawInstructionCount !== 'number' || rawInstructionCount < 0
        || !Array.isArray(instructionSamples) || instructionSamples.length > 16
        || !instructionSamples.every((label) => typeof label === 'string' && label.length <= 256)
        || !Array.isArray(rawInstructionSamples) || rawInstructionSamples.length > 16
        || !rawInstructionSamples.every((label) => typeof label === 'string' && label.length <= 256)
        || typeof blockLabel !== 'string' || blockLabel.length > 128
        || (rawBlock.length === 7 && !/^[A-Za-z0-9:_-]{1,128}$/.test(blockLabel))) return undefined
    blockIndexes.set(id, index)
    normalizedBlocks.push([index, kind, instructionCount, rawInstructionCount, instructionSamples, rawInstructionSamples, blockLabel])
  }
  const entryIndex = blockIndexes.get(parsed.entryBlock)
  const exitIndex = blockIndexes.get(parsed.exitBlock)
  if (entryIndex === undefined || exitIndex === undefined) return undefined
  const rawExitBlocks = Array.isArray(parsed.exitBlocks) ? parsed.exitBlocks : [parsed.exitBlock]
  if (!rawExitBlocks.every((block) => Number.isSafeInteger(block) && typeof block === 'number' && blockIndexes.has(block))) return undefined
  const exitBlocks = [...new Set(rawExitBlocks.map((block) => blockIndexes.get(block as number) as number))]

  const normalizedEdges: SimilarFunctionControlFlowGraph['edges'] = []
  for (const edge of edges) {
    if (Array.isArray(edge) && edge.length !== 3) return undefined
    const source = Array.isArray(edge) ? edge[0] : edge && typeof edge === 'object' ? (edge as Record<string, unknown>).from : undefined
    const target = Array.isArray(edge) ? edge[1] : edge && typeof edge === 'object' ? (edge as Record<string, unknown>).to : undefined
    const kind = Array.isArray(edge) ? edge[2] : edge && typeof edge === 'object' ? (edge as Record<string, unknown>).kind : undefined
    const sourceIndex = typeof source === 'number' ? blockIndexes.get(source) : undefined
    const targetIndex = typeof target === 'number' ? blockIndexes.get(target) : undefined
    if (!Number.isSafeInteger(source) || sourceIndex === undefined || !Number.isSafeInteger(target) || targetIndex === undefined
        || typeof kind !== 'string' || !/^[A-Za-z0-9_]{1,40}$/.test(kind)) return undefined
    normalizedEdges.push([sourceIndex, targetIndex, kind])
  }
  return {
    version: 'reamon-normalized-cfg-v1',
    entryBlock: entryIndex,
    exitBlocks,
    blockCount: normalizedBlocks.length,
    edgeCount: normalizedEdges.length,
    truncated: false,
    blocks: normalizedBlocks,
    edges: normalizedEdges,
  }
}

function parseBoundedJsonObject(value: unknown, maxBytes: number): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    if (value.length > maxBytes) return undefined
    try { value = JSON.parse(value) as unknown } catch { return undefined }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Parse bounded exact strings referenced by a function in provider metadata. */
export function parseReferencedStrings(value: unknown, truncated?: unknown): string[] | undefined {
  if (truncated === true) return undefined
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 20 * 1024) return undefined
    try { value = JSON.parse(value) as unknown } catch { return undefined }
  }
  if (!Array.isArray(value) || value.length > 100) return undefined
  const strings = [...new Set(value.flatMap((entry) => {
    if (typeof entry !== 'string' || entry.length > 512) return []
    const normalized = entry.trim()
    return normalized.length >= 4 ? [normalized] : []
  }))].slice(0, 32)
  return strings.length ? strings : undefined
}

function orderedSimilarity(leftInput: string[], rightInput: string[]): number {
  const left = leftInput.slice(0, MAX_SIGNATURE)
  const right = rightInput.slice(0, MAX_SIGNATURE)
  const rightPositions = new Map<string, number[]>()
  for (let index = 0; index < right.length; index += 1) {
    const positions = rightPositions.get(right[index]) || []
    positions.push(index)
    rightPositions.set(right[index], positions)
  }

  const ranges: Array<[number, number, number, number]> = [[0, left.length, 0, right.length]]
  let matchingInstructions = 0
  while (ranges.length) {
    const [leftStart, leftEnd, rightStart, rightEnd] = ranges.pop()!
    let bestLeft = leftStart
    let bestRight = rightStart
    let bestLength = 0
    let previous = new Map<number, number>()
    for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
      const current = new Map<number, number>()
      for (const rightIndex of rightPositions.get(left[leftIndex]) || []) {
        if (rightIndex < rightStart || rightIndex >= rightEnd) continue
        const length = (previous.get(rightIndex - 1) || 0) + 1
        current.set(rightIndex, length)
        if (length > bestLength) {
          bestLeft = leftIndex - length + 1
          bestRight = rightIndex - length + 1
          bestLength = length
        }
      }
      previous = current
    }

    while (bestLeft > leftStart && bestRight > rightStart
      && left[bestLeft - 1] === right[bestRight - 1]) {
      bestLeft -= 1
      bestRight -= 1
      bestLength += 1
    }
    while (bestLeft + bestLength < leftEnd && bestRight + bestLength < rightEnd
      && left[bestLeft + bestLength] === right[bestRight + bestLength]) bestLength += 1

    if (!bestLength) continue
    matchingInstructions += bestLength
    if (leftStart < bestLeft && rightStart < bestRight) {
      ranges.push([leftStart, bestLeft, rightStart, bestRight])
    }
    const leftAfter = bestLeft + bestLength
    const rightAfter = bestRight + bestLength
    if (leftAfter < leftEnd && rightAfter < rightEnd) {
      ranges.push([leftAfter, leftEnd, rightAfter, rightEnd])
    }
  }
  return (2 * matchingInstructions) / (left.length + right.length)
}

function controlFlowSimilarity(
  left: SimilarInstructionFunction['controlFlowMetrics'],
  right: SimilarInstructionFunction['controlFlowMetrics'],
): number | null {
  if (!left || !right || left.truncated || right.truncated) return null
  const values: Array<[number, number]> = [
    [left.blockCount, right.blockCount],
    [left.edgeCount, right.edgeCount],
    [left.entryBlockCount, right.entryBlockCount],
    [left.exitBlockCount, right.exitBlockCount],
  ]
  return values.reduce((score, [a, b]) => score + (a === 0 && b === 0 ? 1 : Math.min(a, b) / Math.max(a, b)), 0) / values.length
}

function flowKindFamily(kind: string): string {
  const normalized = kind.toLowerCase()
  if (normalized.includes('unconditional')) return 'jump'
  if (normalized.includes('conditional') || normalized.includes('true') || normalized.includes('false') || normalized.includes('switch')) return 'branch'
  if (normalized.includes('fall') || normalized === 'flow') return 'flow'
  if (normalized.includes('jump') || normalized.includes('branch')) return 'jump'
  return 'other'
}

// BinDiff documents normalized flow-graph structure as a useful function
// matching feature. This bounded color-refinement summary is an independent
// REAmon implementation across normalized provider graphs, and remains a
// ranking signal rather than identity.
function compactColor(signature: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function colorHistogramSimilarity(left: string[], right: string[]): number {
  const counts = (colors: string[]) => colors.reduce((result, color) => {
    result.set(color, (result.get(color) || 0) + 1)
    return result
  }, new Map<string, number>())
  const leftCounts = counts(left)
  const rightCounts = counts(right)
  let overlap = 0
  for (const [color, count] of leftCounts) overlap += Math.min(count, rightCounts.get(color) || 0)
  return left.length + right.length ? (2 * overlap) / (left.length + right.length) : 1
}

function graphNodeColors(graph: SimilarFunctionControlFlowGraph): string[][] {
  const outgoing = graph.blocks.map((): Array<{ target: number; kind: string }> => [])
  const incoming = graph.blocks.map((): Array<{ source: number; kind: string }> => [])
  const totalInstructions = graph.blocks.reduce((total, block) => total + block[2], 0)
  for (const [source, target, rawKind] of graph.edges) {
    const kind = flowKindFamily(rawKind)
    outgoing[source].push({ target, kind })
    incoming[target].push({ source, kind })
  }
  const exits = new Set(graph.exitBlocks)
  let colors = graph.blocks.map((_, index) => compactColor(JSON.stringify([
    index === graph.entryBlock,
    exits.has(index),
    incoming[index].length,
    outgoing[index].length,
    instructionShareClass(graph.blocks[index][2], totalInstructions),
  ])))
  const levels = [colors]
  for (let depth = 0; depth < 3; depth += 1) {
    colors = graph.blocks.map((_, index) => compactColor(JSON.stringify([
      colors[index],
      outgoing[index].map(({ target, kind }) => `${kind}:${colors[target]}`).sort(),
      incoming[index].map(({ source, kind }) => `${kind}:${colors[source]}`).sort(),
    ])))
    levels.push(colors)
  }
  return levels
}

function instructionShareClass(instructionCount: number, functionInstructionCount: number): number {
  if (instructionCount <= 0 || functionInstructionCount <= 0) return 0
  const share = instructionCount / functionInstructionCount
  if (share <= 0.025) return 1
  if (share <= 0.05) return 2
  if (share <= 0.1) return 3
  if (share <= 0.2) return 4
  if (share <= 0.4) return 5
  return 6
}

function controlFlowTopologySimilarity(
  left: SimilarInstructionFunction['controlFlowGraph'],
  right: SimilarInstructionFunction['controlFlowGraph'],
): number | null {
  if (!left || !right || left.truncated || right.truncated) return null
  const leftLevels = graphNodeColors(left)
  const rightLevels = graphNodeColors(right)
  return leftLevels.reduce((score, colors, index) => score + colorHistogramSimilarity(colors, rightLevels[index]), 0) / leftLevels.length
}

export function rankSimilarInstructionFunctions(
  target: SimilarInstructionFunction,
  candidates: SimilarInstructionFunction[],
  limit = 8,
): RankedSimilarInstructionFunction[] {
  if (target.mnemonics.length < MIN_FUNCTION_LENGTH) return []
  const rough = candidates.flatMap((candidate) => {
    const targetLength = target.mnemonics.length
    const candidateLength = candidate.mnemonics.length
    if (candidate.key === target.key || candidateLength < MIN_FUNCTION_LENGTH) return []
    const controlFlow = controlFlowSimilarity(target.controlFlowMetrics, candidate.controlFlowMetrics)
    const topology = controlFlowTopologySimilarity(target.controlFlowGraph, candidate.controlFlowGraph)
    const strings = stringReferenceSimilarity(target.referencedStrings, candidate.referencedStrings)
    if (controlFlow === null
        && topology === null
        && (candidateLength / targetLength < 0.6 || candidateLength / targetLength > 1 / 0.6)) return []
    const frequency = cosineSimilarity(target.mnemonics, candidate.mnemonics)
    const structural = controlFlow === null ? topology : topology === null ? controlFlow : 0.4 * controlFlow + 0.6 * topology
    const baseShortlistScore = structural === null ? frequency : 0.6 * frequency + 0.4 * structural
    const shortlistScore = strings === null ? baseShortlistScore : 0.8 * baseShortlistScore + 0.2 * strings
    const minimumShortlistScore = strings !== null && strings >= 0.75 && frequency >= 0.25
      ? 0.45
      : structural === null ? 0.6 : 0.5
    return shortlistScore >= minimumShortlistScore ? [{ candidate, shortlistScore }] : []
  }).sort((left, right) => right.shortlistScore - left.shortlistScore).slice(0, MAX_ORDERED_CANDIDATES)

  return rough.map(({ candidate }) => {
    const scores = scoreInstructionFunctionPair(target, candidate)
    return scores ? { ...candidate, ...scores } : null
  }).filter((candidate): candidate is RankedSimilarInstructionFunction => candidate !== null && candidate.similarity >= 0.6)
    .sort((left, right) => right.similarity - left.similarity || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((candidate) => ({
      ...candidate,
      similarity: Math.round(candidate.similarity * 100),
      instructionSimilarity: Math.round(candidate.instructionSimilarity * 100),
      controlFlowSimilarity: candidate.controlFlowSimilarity === null
        ? null
        : Math.round(candidate.controlFlowSimilarity * 100),
      controlFlowTopologySimilarity: candidate.controlFlowTopologySimilarity === null
        ? null
        : Math.round(candidate.controlFlowTopologySimilarity * 100),
      stringReferenceSimilarity: candidate.stringReferenceSimilarity === null
        ? null
        : Math.round(candidate.stringReferenceSimilarity * 100),
    }))
}

/** Score one exact function pair with the same bounded features used for ranking. */
export function scoreInstructionFunctionPair(
  target: SimilarInstructionFunction,
  candidate: SimilarInstructionFunction,
): {
  similarity: number
  instructionSimilarity: number
  controlFlowSimilarity: number | null
  controlFlowTopologySimilarity: number | null
  stringReferenceSimilarity: number | null
} | null {
  if (target.mnemonics.length < MIN_FUNCTION_LENGTH || candidate.mnemonics.length < MIN_FUNCTION_LENGTH) return null
  const instructionSimilarity = orderedSimilarity(target.mnemonics, candidate.mnemonics)
  const controlFlowSimilarity = controlFlowSimilarityForPair(target.controlFlowMetrics, candidate.controlFlowMetrics)
  const controlFlowTopologySimilarity = controlFlowTopologySimilarityForPair(target.controlFlowGraph, candidate.controlFlowGraph)
  const stringReferenceSimilarityScore = stringReferenceSimilarity(target.referencedStrings, candidate.referencedStrings)
  const structuralSimilarity = controlFlowSimilarity === null
    ? controlFlowTopologySimilarity
    : controlFlowTopologySimilarity === null
      ? controlFlowSimilarity
      : 0.4 * controlFlowSimilarity + 0.6 * controlFlowTopologySimilarity
  const baseSimilarity = structuralSimilarity === null
    ? instructionSimilarity
    : 0.6 * instructionSimilarity + 0.4 * structuralSimilarity
  const similarity = stringReferenceSimilarityScore === null
    ? baseSimilarity
    : 0.8 * baseSimilarity + 0.2 * stringReferenceSimilarityScore
  return {
    similarity,
    instructionSimilarity,
    controlFlowSimilarity,
    controlFlowTopologySimilarity,
    stringReferenceSimilarity: stringReferenceSimilarityScore,
  }
}

function controlFlowTopologySimilarityForPair(
  left: SimilarInstructionFunction['controlFlowGraph'],
  right: SimilarInstructionFunction['controlFlowGraph'],
): number | null {
  return controlFlowTopologySimilarity(left, right)
}

function controlFlowSimilarityForPair(
  left: SimilarInstructionFunction['controlFlowMetrics'],
  right: SimilarInstructionFunction['controlFlowMetrics'],
): number | null {
  return controlFlowSimilarity(left, right)
}
