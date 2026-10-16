import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { normalizeCodeUnit } from '@/lib/reamon/code-units'
import { rankSimilarInstructionFunctions, type SimilarInstructionFunction } from '@/lib/reamon/instruction-similarity'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_FUNCTIONS = 2_000
const MAX_FUNCTION_OBSERVATIONS = 8_000
const MAX_NO_STORE = { 'Cache-Control': 'private, no-store' }

function attributesRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function sameNativeArchitecture(left: { attributes: unknown; artifact: { profile: unknown } | null; artifactId: string | null }, right: { attributes: unknown; artifact: { profile: unknown } | null; artifactId: string | null }): boolean {
  if (left.artifactId && left.artifactId === right.artifactId) return true
  const leftArchitecture = attributesRecord(left.attributes).instructionArchitecture
  const rightArchitecture = attributesRecord(right.attributes).instructionArchitecture
  return typeof leftArchitecture === 'string' && leftArchitecture.length > 0
    && typeof rightArchitecture === 'string' && leftArchitecture === rightArchitecture
}

function instructionMnemonics(value: unknown): string[] {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.slice(0, 800).filter((item): item is string =>
    typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_./-]{0,31}$/.test(item))
}

function functionFeatures(row: { id: string; stableKey: string; label: string | null; attributes: unknown }): SimilarInstructionFunction {
  const attributes = attributesRecord(row.attributes)
  return {
    key: row.id,
    name: (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName) || row.label || 'Unknown function',
    address: typeof attributes.address === 'string' ? attributes.address : null,
    mnemonics: instructionMnemonics(attributes.instructionMnemonics),
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
    if (!task?.artifactId || (providerId !== 'reamon-ghidra' && providerId !== 'reamon-wabt' && providerId !== 'reamon-jadx' && providerId !== 'reamon-ilspy')) {
      return NextResponse.json({ error: 'Instruction-pattern matches are unavailable for this analysis run' }, { status: 404, headers: MAX_NO_STORE })
    }

    const observationWhere = {
      projectId,
      type: providerId === 'reamon-jadx' || providerId === 'reamon-ilspy' ? 'function' : 'code_unit',
      source: providerId,
      artifact: { is: selection.artifactWhere },
      task: { is: {
        projectId,
        status: 'COMPLETED',
        capability: { in: ['decompile', 'disassemble'] },
        provider: { is: { pluginId: providerId } },
      } },
    }
    const [focus, rows] = await Promise.all([
      prisma.reamonObservation.findFirst({
        where: { ...observationWhere, OR: [{ id: unitId }, { stableKey: unitId }] },
        select: {
          id: true, stableKey: true, canonicalKey: true, label: true, attributes: true, artifactId: true,
          artifact: { select: { profile: true } },
        },
      }),
      prisma.reamonObservation.findMany({
        where: observationWhere,
        orderBy: [{ updatedAt: 'desc' }, { stableKey: 'asc' }],
        take: MAX_FUNCTION_OBSERVATIONS + 1,
        select: {
          id: true, stableKey: true, canonicalKey: true, label: true, source: true, artifactId: true,
          updatedAt: true, attributes: true,
          artifact: { select: { relativePath: true, originalName: true, sha256: true, profile: true } },
        },
      }),
    ])
    if (!focus) return NextResponse.json({ error: 'Function is outside this project history' }, { status: 404, headers: MAX_NO_STORE })

    const target = functionFeatures(focus)
    const uniqueRows = new Map<string, typeof rows[number]>()
    const compatibleRows = providerId === 'reamon-ghidra'
      ? rows.filter((row) => sameNativeArchitecture(focus, row))
      : rows
    for (const row of compatibleRows.slice(0, MAX_FUNCTION_OBSERVATIONS)) {
      const identity = `${row.artifactId}:${row.canonicalKey}`
      if (!uniqueRows.has(identity)) uniqueRows.set(identity, row)
    }
    const distinctRows = [...uniqueRows.values()]
    const truncated = compatibleRows.length > MAX_FUNCTION_OBSERVATIONS || distinctRows.length > MAX_FUNCTIONS
    const boundedRows = distinctRows.slice(0, MAX_FUNCTIONS)
      .filter((row) => row.artifactId !== focus.artifactId || row.canonicalKey !== focus.canonicalKey)
    const features = boundedRows.map(functionFeatures)
    const ranked = rankSimilarInstructionFunctions(target, features)
    const byKey = new Map(boundedRows.map((row) => [row.id, row]))
    const matches = ranked.flatMap((match) => {
      const row = byKey.get(match.key)
      const codeUnit = row ? normalizeCodeUnit(row) : null
      return row && codeUnit ? [{
        codeUnit,
        similarity: match.similarity,
        artifact: { name: row.artifact?.originalName || 'Unknown artifact', sha256: row.artifact?.sha256 || null },
      }] : []
    })
    return NextResponse.json({ focusId: focus.id, matches, truncated }, { headers: MAX_NO_STORE })
  } catch (error) {
    console.error('Failed to load similar functions:', error)
    return NextResponse.json({ error: 'Failed to load similar functions' }, { status: 500, headers: MAX_NO_STORE })
  }
}
