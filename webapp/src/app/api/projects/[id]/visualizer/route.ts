import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import {
  CODE_UNIT_OBSERVATION_TYPE,
  CODE_UNIT_QUERY_LIMIT,
  MAINTAINED_SOURCE_OBSERVATION_SOURCE,
  MAINTAINED_SOURCE_OBSERVATION_TYPE,
  normalizeCodeUnit,
  summarizeCodeUnits,
} from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_FUNCTION_MAP_MEMBERS = 20_000

function resultRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function currentOutputHash(attributes: unknown): string | null {
  const record = resultRecord(attributes)
  const candidate = record.codeArtifactSha256 ?? record.decompiledSourceSha256
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : null
}

function maintainedBaseSourceHash(symbolIndex: unknown): string | null {
  const sourceLineage = resultRecord(resultRecord(symbolIndex).sourceLineage)
  const candidate = sourceLineage.baseSourceHash
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : null
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const searchParams = new URL(request.url).searchParams
    const search = searchParams.get('q')?.trim() || ''
    const requestedUnitId = searchParams.get('unitId')?.trim() || ''
    const requestedTaskId = searchParams.get('taskId')?.trim() || null
    if (search.length > 300) {
      return NextResponse.json({ error: 'Code unit search is too long' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    if (requestedUnitId.length > 128) {
      return NextResponse.json({ error: 'Invalid code unit id' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    if (requestedTaskId && requestedTaskId.length > 128) {
      return NextResponse.json({ error: 'Invalid analysis run id' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    const selection = await getActiveWorkspaceImportSelection(projectId)
    const runSelect = {
      id: true,
      artifactId: true,
      title: true,
      createdAt: true,
      completedAt: true,
      result: true,
      runToken: true,
      provider: { select: { pluginId: true } },
      artifact: { select: { originalName: true, relativePath: true } },
    } as const
    let decompileTasks = await prisma.task.findMany({
      where: {
        projectId,
        capability: { in: ['decompile', 'disassemble'] },
        status: 'COMPLETED',
        artifact: { is: selection.artifactWhere },
      },
      orderBy: { completedAt: 'desc' },
      take: 100,
      select: runSelect,
    })
    if (requestedTaskId && !decompileTasks.some((task) => task.id === requestedTaskId)) {
      const historicalRun = await prisma.task.findFirst({
        where: {
          id: requestedTaskId,
          projectId,
          capability: { in: ['decompile', 'disassemble'] },
          status: 'COMPLETED',
          artifact: { is: selection.artifactWhere },
        },
        select: runSelect,
      })
      if (historicalRun) decompileTasks = [...decompileTasks, historicalRun]
    }
    const decompileTaskIds = decompileTasks.map((task) => task.id)
    const observationCounts = decompileTaskIds.length
      ? await prisma.reamonObservation.groupBy({
        by: ['taskId'],
        where: {
          projectId,
          type: CODE_UNIT_OBSERVATION_TYPE,
          taskId: { in: decompileTaskIds },
          artifact: { is: selection.artifactWhere },
        },
        _count: { _all: true },
      })
      : []
    const countByTaskId = new Map(observationCounts.map((row) => [row.taskId, row._count._all]))
    const runs = decompileTasks
      .map((task) => {
        const result = resultRecord(task.result)
        const codeUnitCount = countByTaskId.get(task.id) || 0
        const isWasm = task.provider?.pluginId === 'reamon-wabt'
        const discoveredUnitCount = finiteCount(isWasm ? result.wasmFunctionCount : result.decompiledCodeUnitCount ?? result.decompiledClassCount ?? result.decompiledFunctionCount)
        const returnedUnitCount = finiteCount(result.returnedCodeUnitCount ?? result.returnedClassCount ?? result.returnedFunctionCount) ?? codeUnitCount
        const indexedUnitCount = Math.min(codeUnitCount, returnedUnitCount)
        const unitLabel = task.provider?.pluginId === 'reamon-ghidra'
          || task.provider?.pluginId === 'reamon-recurse' || isWasm ? 'functions' : 'code units'
        return {
          id: task.id,
          title: task.title,
          createdAt: task.createdAt.toISOString(),
          completedAt: task.completedAt?.toISOString() || null,
          artifactName: task.artifact?.relativePath || task.artifact?.originalName || 'Unknown artifact',
          providerId: task.provider?.pluginId || null,
          apktoolProjectAvailable: task.provider?.pluginId === 'reamon-jadx'
            && typeof result.apktoolProjectPath === 'string'
            && Boolean(task.runToken)
            && result.apktoolProjectPath === `${projectId}/${task.artifactId}/${task.id}/${task.runToken}/apktool-project`,
          codeUnitCount,
          unitLabel,
          discoveredUnitCount,
          returnedUnitCount,
          indexedUnitCount,
          codeBytes: finiteCount(result.codeBytes),
          linkPercent: discoveredUnitCount ? Math.min(100, Math.round((indexedUnitCount / discoveredUnitCount) * 100)) : null,
          truncated: result.truncated === true || (discoveredUnitCount !== null && returnedUnitCount < discoveredUnitCount),
          warnings: typeof result.warnings === 'string' ? result.warnings.slice(0, 4000) : '',
          failedUnitCount: finiteCount(result.failedFunctionCount),
          visitedUnitCount: finiteCount(result.visitedFunctionCount),
        }
      })
    if (requestedTaskId && !runs.some((run) => run.id === requestedTaskId)) {
      return NextResponse.json({ error: 'Analysis run not found' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
    }
    const selectedRunId = requestedTaskId || runs[0]?.id || null
    const matchingFunctionRows = search && selectedRunId ? await prisma.reamonObservation.findMany({
      where: {
        projectId,
        taskId: selectedRunId,
        artifact: { is: selection.artifactWhere },
        kind: 'entity',
        type: 'function',
        OR: [
          { label: { contains: search, mode: 'insensitive' } },
          ...['name', 'qualifiedName', 'address'].map((key) => ({
            attributes: { path: [key], string_contains: search, mode: 'insensitive' as const },
          })),
        ],
      },
      select: { attributes: true },
      take: 2_000,
    }) : []
    const matchingFunctionParentKeys = [...new Set(matchingFunctionRows.flatMap((row) => {
      const parentKey = resultRecord(row.attributes).parentCodeUnitKey
      return typeof parentKey === 'string' ? [parentKey] : []
    }))]
    const where = {
      projectId,
      type: CODE_UNIT_OBSERVATION_TYPE,
      artifact: { is: selection.artifactWhere },
      ...(selectedRunId ? { taskId: selectedRunId } : {}),
      ...(requestedUnitId ? { id: requestedUnitId } : {}),
      ...(search ? {
        OR: [
          { label: { contains: search, mode: 'insensitive' as const } },
          { stableKey: { contains: search, mode: 'insensitive' as const } },
          ...['name', 'qualifiedName', 'address', 'startAddress', 'language', 'sourceLanguage', 'referencedStrings', 'bundlePath'].map((key) => ({
            attributes: { path: [key], string_contains: search, mode: 'insensitive' as const },
          })),
          { artifact: { is: {
            OR: [
              { relativePath: { contains: search, mode: 'insensitive' as const } },
              { originalName: { contains: search, mode: 'insensitive' as const } },
            ],
          } } },
          ...(matchingFunctionParentKeys.length ? [{ stableKey: { in: matchingFunctionParentKeys } }] : []),
        ],
      } : {}),
    }
    const cursorId = searchParams.get('cursor')?.trim() || null
    if (cursorId && cursorId.length > 128) {
      return NextResponse.json({ error: 'Invalid code unit cursor' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    if (cursorId) {
      const cursor = await prisma.reamonObservation.findFirst({ where: { ...where, id: cursorId }, select: { id: true } })
      if (!cursor) return NextResponse.json({ error: 'Code unit cursor is outside this analysis run' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    const maintainedWhere = {
      projectId,
      source: MAINTAINED_SOURCE_OBSERVATION_SOURCE,
      type: MAINTAINED_SOURCE_OBSERVATION_TYPE,
      artifact: { is: selection.artifactWhere },
    }
    const [rows, total, maintainedCount] = await Promise.all([
      prisma.reamonObservation.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { stableKey: 'asc' }, { id: 'asc' }],
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        take: CODE_UNIT_QUERY_LIMIT + 1,
        select: {
          id: true,
          stableKey: true,
          label: true,
          source: true,
          artifactId: true,
          updatedAt: true,
          attributes: true,
          artifact: { select: { relativePath: true, originalName: true } },
        },
      }),
      prisma.reamonObservation.count({ where }),
      prisma.reamonObservation.count({ where: maintainedWhere }),
    ])

    const pageRows = rows.slice(0, CODE_UNIT_QUERY_LIMIT)
    const [maintainedSourceRows, draftRows] = pageRows.length
      ? await Promise.all([pageRows[0].artifactId ? prisma.reamonMaintainedSource.findMany({
        where: {
          projectId,
          artifactId: { in: [...new Set(pageRows.flatMap((row) => row.artifactId ? [row.artifactId] : []))] },
          codeUnitId: { in: pageRows.map((row) => row.id) },
        },
        select: { codeUnitId: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
      }) : Promise.resolve([]), pageRows[0].artifactId ? prisma.reamonCodeDraft.findMany({
        where: { projectId, artifactId: pageRows[0].artifactId, codeUnitId: { in: pageRows.map((row) => row.id) } },
        select: { codeUnitId: true },
        distinct: ['codeUnitId'],
      }) : Promise.resolve([])])
      : [[], []]
    const currentOutputHashByUnit = new Map(pageRows.map((row) => [row.id, currentOutputHash(row.attributes)] as const))
    const currentSourceRows = maintainedSourceRows.filter((source) => {
      const baseSourceHash = maintainedBaseSourceHash(source.symbolIndex)
      return baseSourceHash !== null && baseSourceHash === currentOutputHashByUnit.get(source.codeUnitId)
    })
    const currentReviewIds = [...new Set(currentSourceRows.flatMap((source) => source.acceptedReviewId ? [source.acceptedReviewId] : []))]
    const currentReviews = currentReviewIds.length ? await prisma.reamonCodeReview.findMany({
      where: { projectId, id: { in: currentReviewIds }, decision: 'ACCEPTED' },
      select: { id: true, codeUnitId: true, maintainedSourceHash: true },
    }) : []
    const currentReviewById = new Map(currentReviews.map((review) => [review.id, review]))
    const maintainedUnitIds = new Set(currentSourceRows.filter((source) => {
      if (!source.sourceHash || !source.acceptedReviewId) return false
      const review = currentReviewById.get(source.acceptedReviewId)
      return review?.codeUnitId === source.codeUnitId && review.maintainedSourceHash === source.sourceHash
    }).map((source) => source.codeUnitId))
    const draftedUnitIds = new Set(draftRows.map((row) => row.codeUnitId))
    const units = pageRows
      .map((row) => normalizeCodeUnit(row, { includeSourceAddressMap: Boolean(requestedUnitId) }))
      .filter((unit) => unit !== null)
      .map((unit) => ({
        ...unit,
        maintainedSource: maintainedUnitIds.has(unit.id),
        draftSource: draftedUnitIds.has(unit.id),
      }))
    const parentByStableKey = new Map(pageRows.flatMap((row) => {
      const unit = units.find((candidate) => candidate.id === row.id)
      return unit ? [[row.stableKey, unit] as const] : []
    }))
    const parentKeys = [...parentByStableKey.keys()]
    const functionRows = parentKeys.length && selectedRunId ? await prisma.reamonObservation.findMany({
      where: {
        projectId,
        taskId: selectedRunId,
        artifact: { is: selection.artifactWhere },
        kind: 'entity',
        type: 'function',
        OR: parentKeys.map((parentCodeUnitKey) => ({
          attributes: { path: ['parentCodeUnitKey'], equals: parentCodeUnitKey },
        })),
      },
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      take: MAX_FUNCTION_MAP_MEMBERS + 1,
      select: { id: true, stableKey: true, label: true, source: true, attributes: true },
    }) : []
    const functionMapTruncated = functionRows.length > MAX_FUNCTION_MAP_MEMBERS
    const functionMapEntries = functionRows.slice(0, MAX_FUNCTION_MAP_MEMBERS).flatMap((row) => {
      const attributes = resultRecord(row.attributes)
      const parentKey = typeof attributes.parentCodeUnitKey === 'string' ? attributes.parentCodeUnitKey : ''
      const parentCodeUnit = parentByStableKey.get(parentKey)
      if (!parentCodeUnit) return []
      const fullName = (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
        || (typeof attributes.name === 'string' && attributes.name)
        || row.label
        || ''
      if (!fullName) return []
      const afterOwner = fullName.includes('->') ? fullName.slice(fullName.lastIndexOf('->') + 2) : fullName
      let memberName = afterOwner.split('(')[0].split(/::|\./).at(-1)?.trim() || afterOwner
      const parentTypeName = parentCodeUnit.name.split('.').at(-1)?.split('$').at(-1) || parentCodeUnit.name
      const isConstructor = memberName === '<init>' || memberName === '.ctor' || memberName === 'constructor' || memberName === parentTypeName
      if (isConstructor) memberName = parentTypeName
      return [{
        id: row.id,
        key: row.stableKey,
        source: row.source,
        name: memberName.slice(0, 500),
        fullName: fullName.slice(0, 1000),
        address: typeof attributes.address === 'string' ? attributes.address.slice(0, 128) : null,
        language: typeof attributes.language === 'string' ? attributes.language.slice(0, 80) : parentCodeUnit.language,
        similarityAvailable: typeof attributes.instructionMnemonics === 'string' && attributes.instructionMnemonics.length > 2,
        memberKind: typeof attributes.memberKind === 'string' ? attributes.memberKind.slice(0, 80) : isConstructor ? 'constructor' : 'method',
        line: typeof attributes.line === 'number' && Number.isSafeInteger(attributes.line) ? attributes.line : null,
        hasControlFlowGraph: (row.source === 'reamon-unluac-rs' || row.source === 'reamon-dex-decompiler')
          && typeof attributes.controlFlowGraph === 'string',
        parentCodeUnit,
      }]
    })
    const outlinedMemberNames = new Set(functionMapEntries
      .filter((entry) => entry.source === 'reamon-tree-sitter-outline')
      .map((entry) => `${entry.parentCodeUnit.id}:${entry.name.toLocaleLowerCase()}`))
    const functionMapMembers = functionMapEntries
      .filter((entry) => entry.source === 'reamon-tree-sitter-outline'
        || !outlinedMemberNames.has(`${entry.parentCodeUnit.id}:${entry.name.toLocaleLowerCase()}`))
      .map(({ source: _source, ...entry }) => entry)
    const nextCursor = rows.length > CODE_UNIT_QUERY_LIMIT ? pageRows.at(-1)?.id || null : null
    return NextResponse.json({
      units,
      functionMapMembers,
      functionMapTruncated,
      total,
      maintainedCount,
      hasMore: nextCursor !== null,
      nextCursor,
      runs,
      selectedRunId,
      summary: summarizeCodeUnits(units),
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load REAmon code visualizer units:', error)
    return NextResponse.json({ error: 'Failed to load code visualizer units' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
