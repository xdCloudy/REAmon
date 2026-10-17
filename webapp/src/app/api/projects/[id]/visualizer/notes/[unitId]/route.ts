import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { CODE_UNIT_OBSERVATION_TYPE } from '@/lib/reamon/code-units'
import { codeNoteText, MAX_REAMON_CODE_NOTE_CHARS, REAMON_CODE_NOTE_SOURCE, REAMON_CODE_NOTE_TYPE } from '@/lib/reamon/code-notes'

interface RouteParams { params: Promise<{ id: string; unitId: string }> }

async function resolveCodeUnit(projectId: string, unitId: string) {
  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return { response: user } as const
  const access = await requireProjectAccess(user, projectId)
  if (access instanceof NextResponse) return { response: access } as const
  const unit = await prisma.reamonObservation.findFirst({
    where: { id: unitId, projectId, type: CODE_UNIT_OBSERVATION_TYPE },
    select: { id: true, artifactId: true, label: true, attributes: true },
  })
  if (!unit?.artifactId) return { response: NextResponse.json({ error: 'Code unit not found' }, { status: 404 }) } as const
  const selection = await getActiveWorkspaceImportSelection(projectId)
  const artifact = await prisma.artifact.findFirst({
    where: { AND: [{ id: unit.artifactId, projectId }, selection.artifactWhere] },
    select: { id: true },
  })
  if (!artifact) return { response: NextResponse.json({ error: 'Code unit is not part of the active workspace' }, { status: 404 }) } as const
  const attributes = unit.attributes && typeof unit.attributes === 'object' && !Array.isArray(unit.attributes)
    ? unit.attributes as Record<string, unknown>
    : {}
  return { user, unit, artifact, attributes } as const
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveCodeUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const saved = await prisma.reamonObservation.findFirst({
      where: { projectId, source: REAMON_CODE_NOTE_SOURCE, stableKey: resolved.unit.id, artifactId: resolved.artifact.id },
      select: { attributes: true, updatedAt: true },
    })
    const savedAttributes = saved?.attributes && typeof saved.attributes === 'object' && !Array.isArray(saved.attributes)
      ? saved.attributes as Record<string, unknown>
      : {}
    const savedSourceHash = typeof savedAttributes.sourceHash === 'string' && /^[a-f0-9]{64}$/i.test(savedAttributes.sourceHash)
      ? savedAttributes.sourceHash.toLowerCase()
      : null
    const currentSourceHash = typeof resolved.attributes.decompiledSourceSha256 === 'string'
      && /^[a-f0-9]{64}$/i.test(resolved.attributes.decompiledSourceSha256)
      ? resolved.attributes.decompiledSourceSha256.toLowerCase()
      : null
    const stale = Boolean(savedSourceHash && (!currentSourceHash || savedSourceHash !== currentSourceHash))
    return NextResponse.json({ unitId, note: codeNoteText(saved?.attributes, currentSourceHash || undefined), stale, updatedAt: saved?.updatedAt.toISOString() ?? null }, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (error) {
    console.error('Could not load REAmon code-unit notes:', error)
    return NextResponse.json({ error: 'Could not load the saved project note' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveCodeUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const body = await request.json().catch(() => null) as unknown
    const noteValue = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).note
      : undefined
    if (typeof noteValue !== 'string' || noteValue.length > MAX_REAMON_CODE_NOTE_CHARS || Buffer.byteLength(noteValue, 'utf8') > 4 * 1024) {
      return NextResponse.json({ error: `A project note must be text of at most ${MAX_REAMON_CODE_NOTE_CHARS} characters` }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const note = noteValue.trim()
    if (!note) {
      await prisma.reamonObservation.deleteMany({
        where: { projectId, source: REAMON_CODE_NOTE_SOURCE, stableKey: resolved.unit.id, artifactId: resolved.artifact.id },
      })
      return NextResponse.json({ unitId, note: '', stale: false, updatedAt: null }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    const updatedAt = new Date()
    const sourceHash = typeof resolved.attributes.decompiledSourceSha256 === 'string'
      && /^[a-f0-9]{64}$/i.test(resolved.attributes.decompiledSourceSha256)
      ? resolved.attributes.decompiledSourceSha256.toLowerCase()
      : null
    const attributes = {
      codeUnitId: resolved.unit.id,
      note,
      sourceHash,
      updatedBy: resolved.user.userId,
      updatedAt: updatedAt.toISOString(),
    }
    const saved = await prisma.reamonObservation.upsert({
      where: { projectId_source_stableKey: { projectId, source: REAMON_CODE_NOTE_SOURCE, stableKey: resolved.unit.id } },
      update: {
        artifactId: resolved.artifact.id,
        kind: 'knowledge',
        type: REAMON_CODE_NOTE_TYPE,
        canonicalKey: `code-unit-note:${resolved.artifact.id}:${resolved.unit.id}`,
        label: resolved.unit.label?.slice(0, 500) || 'Code unit note',
        attributes,
      },
      create: {
        projectId,
        artifactId: resolved.artifact.id,
        kind: 'knowledge',
        type: REAMON_CODE_NOTE_TYPE,
        stableKey: resolved.unit.id,
        canonicalKey: `code-unit-note:${resolved.artifact.id}:${resolved.unit.id}`,
        label: resolved.unit.label?.slice(0, 500) || 'Code unit note',
        source: REAMON_CODE_NOTE_SOURCE,
        attributes,
      },
      select: { updatedAt: true },
    })
    return NextResponse.json({ unitId, note, stale: false, updatedAt: saved.updatedAt.toISOString() }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Could not save REAmon code-unit note:', error)
    return NextResponse.json({ error: 'Could not save the project note' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
