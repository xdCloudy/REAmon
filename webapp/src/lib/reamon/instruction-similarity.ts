const MAX_SIGNATURE = 800
const MIN_FUNCTION_LENGTH = 4
const MAX_ORDERED_CANDIDATES = 150

export interface SimilarInstructionFunction {
  key: string
  name: string
  address: string | null
  mnemonics: string[]
}

export interface RankedSimilarInstructionFunction extends SimilarInstructionFunction {
  similarity: number
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

export function rankSimilarInstructionFunctions(
  target: SimilarInstructionFunction,
  candidates: SimilarInstructionFunction[],
  limit = 8,
): RankedSimilarInstructionFunction[] {
  if (target.mnemonics.length < MIN_FUNCTION_LENGTH) return []
  const rough = candidates.flatMap((candidate) => {
    const targetLength = target.mnemonics.length
    const candidateLength = candidate.mnemonics.length
    if (candidate.key === target.key || candidateLength < MIN_FUNCTION_LENGTH
        || candidateLength / targetLength < 0.6 || candidateLength / targetLength > 1 / 0.6) return []
    const frequency = cosineSimilarity(target.mnemonics, candidate.mnemonics)
    return frequency >= 0.6 ? [{ candidate, frequency }] : []
  }).sort((left, right) => right.frequency - left.frequency).slice(0, MAX_ORDERED_CANDIDATES)

  return rough.map(({ candidate }) => ({
    ...candidate,
    similarity: orderedSimilarity(target.mnemonics, candidate.mnemonics),
  })).filter((candidate) => candidate.similarity >= 0.6)
    .sort((left, right) => right.similarity - left.similarity || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((candidate) => ({ ...candidate, similarity: Math.round(candidate.similarity * 100) }))
}
