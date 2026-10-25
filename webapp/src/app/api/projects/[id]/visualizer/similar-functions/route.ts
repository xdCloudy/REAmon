import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { normalizeCodeUnit } from '@/lib/reamon/code-units'
import { instructionSequencesAreCompatible, parseControlFlowGraph, parseControlFlowMetrics, parseReferencedStrings, rankSimilarInstructionFunctions, type SimilarInstructionFunction } from '@/lib/reamon/instruction-similarity'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_FUNCTIONS = 2_000
const MAX_FUNCTION_OBSERVATIONS = 8_000
const MAX_NO_STORE = { 'Cache-Control': 'private, no-store' }

function attributesRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function instructionMnemonics(value: unknown): string[] {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.slice(0, 800).filter((item): item is string =>
    typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_./-]{0,31}$/.test(item))
    .map((mnemonic) => mnemonic.toLowerCase())
}

function functionFeatures(row: { id: string; stableKey: string; label: string | null; attributes: unknown }): SimilarInstructionFunction {
  const attributes = attributesRecord(row.attributes)
  return {
    key: row.id,
    name: (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName) || row.label || 'Unknown function',
    address: typeof attributes.address === 'string' ? attributes.address : null,
    mnemonics: instructionMnemonics(attributes.instructionMnemonics),
    referencedStrings: parseReferencedStrings(attributes.referencedStrings, attributes.referencedStringsTruncated),
    controlFlowMetrics: parseControlFlowMetrics(attributes.controlFlowMetrics),
    controlFlowGraph: parseControlFlowGraph(attributes.controlFlowGraph, attributes.cfgTruncated),
  }
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const search = new URL(request.url).searchParams
    const taskId = search.get('taskId')?.trim() || ''
    const unitId = search.get('unitId')?.trim() || ''
    if (!taskId || taskId.length > 128 || !unitId || unitId.length > 128) {
      return NextResponse.json({ error: 'A valid function and analysis run are required' }, { status: 400, headers: MAX_NO_STORE })
    }

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        projectId,
        capability: { in: ['decompile', 'disassemble'] },
        status: 'COMPLETED',
        artifact: { is: selection.artifactWhere },
      },
      select: { id: true, artifactId: true, provider: { select: { pluginId: true } } },
    })
    const providerId = task?.provider?.pluginId
    if (!task?.artifactId || !providerId) {
      return NextResponse.json({ error: 'Similar-function matches are unavailable for this analysis run' }, { status: 404, headers: MAX_NO_STORE })
    }

    const isNativeProvider = providerId === 'reamon-ghidra' || providerId === 'reamon-kuna'
    const relatedSources = isNativeProvider ? ['reamon-ghidra', 'reamon-kuna'] : null
    const observationWhere = {
      projectId,
      type: { in: ['code_unit', 'function'] },
      ...(relatedSources ? { source: { in: relatedSources } } : {}),
      artifact: { is: selection.artifactWhere },
      task: { is: {
        projectId,
        status: 'COMPLETED',
        capability: { in: ['decompile', 'disassemble'] },
        ...(relatedSources ? { provider: { is: { pluginId: { in: relatedSources } } } } : {}),
      } },
    }
    const focusWhere = { ...observationWhere, source: providerId, taskId, artifactId: task.artifactId }
    const [focus, rows] = await Promise.all([
      prisma.reamonObservation.findFirst({
        where: { ...focusWhere, OR: [{ id: unitId }, { stableKey: unitId }] },
        select: {
          id: true, taskId: true, stableKey: true, canonicalKey: true, label: true, attributes: true, artifactId: true, source: true,
          artifact: { select: { profile: true } },
        },
      }),
      prisma.reamonObservation.findMany({
        where: observationWhere,
        orderBy: [{ updatedAt: 'desc' }, { stableKey: 'asc' }],
        take: MAX_FUNCTION_OBSERVATIONS + 1,
        select: {
          id: true, taskId: true, stableKey: true, canonicalKey: true, label: true, source: true, artifactId: true,
          updatedAt: true, attributes: true,
          artifact: { select: { relativePath: true, originalName: true, sha256: true, profile: true } },
        },
      }),
    ])
    if (!focus) return NextResponse.json({ error: 'Function is outside this project history' }, { status: 404, headers: MAX_NO_STORE })

    const target = functionFeatures(focus)
    if (target.mnemonics.length < 4) {
      return NextResponse.json({ focusId: focus.id, matches: [], truncated: false, unavailableReason: 'This function has no stored instruction sequence for similarity matching.' }, { headers: MAX_NO_STORE })
    }
    const sourceObservationRowsTruncated = rows.length > MAX_FUNCTION_OBSERVATIONS
    const uniqueRows = new Map<string, typeof rows[number]>()
    const focusSequence = { providerId: focus.source, artifactId: focus.artifactId, attributes: focus.attributes }
    const compatibleRows = rows.filter((row) => instructionSequencesAreCompatible(focusSequence, {
      providerId: row.source,
      artifactId: row.artifactId,
      attributes: row.attributes,
    }))
    for (const row of compatibleRows.slice(0, MAX_FUNCTION_OBSERVATIONS)) {
      if (isNativeProvider && row.source !== focus.source) {
        const focusIdentity = attributesRecord(focus.attributes).identity
        if (typeof focusIdentity === 'string' && focusIdentity
          && focusIdentity === attributesRecord(row.attributes).identity) continue
      }
      const identity = `${row.artifactId}:${row.source}:${row.canonicalKey}`
      if (!uniqueRows.has(identity)) uniqueRows.set(identity, row)
    }
    const distinctRows = [...uniqueRows.values()]
    const truncated = sourceObservationRowsTruncated || compatibleRows.length > MAX_FUNCTION_OBSERVATIONS || distinctRows.length > MAX_FUNCTIONS
    const boundedRows = distinctRows.slice(0, MAX_FUNCTIONS)
      .filter((row) => row.artifactId !== focus.artifactId || row.canonicalKey !== focus.canonicalKey)
    const features = boundedRows.map(functionFeatures)
    const ranked = rankSimilarInstructionFunctions(target, features)
    const byKey = new Map(boundedRows.map((row) => [row.id, row]))
    const rankedRows = ranked.flatMap((match) => {
      const row = byKey.get(match.key)
      return row ? [{
        row,
        similarity: match.similarity,
        instructionSimilarity: match.instructionSimilarity,
        controlFlowSimilarity: match.controlFlowSimilarity,
        controlFlowTopologySimilarity: match.controlFlowTopologySimilarity,
        stringReferenceSimilarity: match.stringReferenceSimilarity,
      }] : []
    })
    const functionParentSources = [...new Set(rankedRows.flatMap(({ row }) =>
      typeof attributesRecord(row.attributes).parentCodeUnitKey === 'string' ? [row.source] : []
    ))]
    const functionParentKeys = functionParentSources.length
      ? [...new Set(rankedRows.flatMap(({ row }) => {
        const key = attributesRecord(row.attributes).parentCodeUnitKey
        return typeof key === 'string' && key ? [key] : []
      }))]
      : []
    const functionParentTaskIds = functionParentSources.length
      ? [...new Set(rankedRows.map(({ row }) => row.taskId).filter((value): value is string => Boolean(value)))]
      : []
    const functionParentRows = functionParentKeys.length && functionParentTaskIds.length
      ? await prisma.reamonObservation.findMany({
        where: {
          projectId,
          source: { in: functionParentSources },
          type: 'code_unit',
          taskId: { in: functionParentTaskIds },
          stableKey: { in: functionParentKeys },
          artifact: { is: selection.artifactWhere },
        },
        select: {
          id: true, taskId: true, stableKey: true, label: true, source: true, artifactId: true,
          updatedAt: true, attributes: true,
          artifact: { select: { relativePath: true, originalName: true } },
        },
      })
      : []
    const functionParentsByKey = new Map(functionParentRows.map((row) => [`${row.taskId}:${row.stableKey}`, row]))
    const matches = rankedRows.flatMap(({ row, similarity, instructionSimilarity, controlFlowSimilarity, controlFlowTopologySimilarity, stringReferenceSimilarity }) => {
      const attributes = attributesRecord(row.attributes)
      const artifact = {
        name: row.artifact?.originalName || 'Unknown artifact',
        sha256: row.artifact?.sha256 || null,
        provider: typeof attributesRecord(row.attributes).decompiler === 'string'
          ? attributesRecord(row.attributes).decompiler as string
          : row.source,
      }
      const needsParent = typeof attributes.parentCodeUnitKey === 'string'
      if (needsParent) {
        const parentKey = typeof attributes.parentCodeUnitKey === 'string' ? attributes.parentCodeUnitKey : ''
        const parentRow = functionParentsByKey.get(`${row.taskId}:${parentKey}`)
        const codeUnit = parentRow ? normalizeCodeUnit(parentRow) : null
        return codeUnit ? [{
          codeUnit,
          taskId: row.taskId,
          function: {
            id: row.id,
            ...(row.taskId ? { taskId: row.taskId } : {}),
            name: row.label || functionFeatures(row).name,
            address: typeof attributes.address === 'string' ? attributes.address : null,
            hasControlFlowGraph: typeof attributes.controlFlowGraph === 'string',
          },
          similarity,
          instructionSimilarity,
          controlFlowSimilarity,
          controlFlowTopologySimilarity,
          stringReferenceSimilarity,
          artifact,
        }] : []
      }
      const codeUnit = normalizeCodeUnit(row)
      return codeUnit ? [{ codeUnit, taskId: row.taskId, similarity, instructionSimilarity, controlFlowSimilarity, controlFlowTopologySimilarity, stringReferenceSimilarity, artifact }] : []
    })
    return NextResponse.json({ focusId: focus.id, matches, truncated }, { headers: MAX_NO_STORE })
  } catch (error) {
    console.error('Failed to load similar functions:', error)
    return NextResponse.json({ error: 'Failed to load similar functions' }, { status: 500, headers: MAX_NO_STORE })
  }
}
