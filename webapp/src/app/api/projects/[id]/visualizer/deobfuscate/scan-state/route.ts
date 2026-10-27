import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'

interface RouteParams { params: Promise<{ id: string }> }

const MAX_STATE_BYTES = 1024 * 1024
const MAX_CURSOR_LENGTH = 500
const MAX_BACKLOG = 400
const MAX_PENDING_UNITS = 40

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum
}

function isCursor(value: unknown): value is string | null {
  return value === null || boundedText(value, MAX_CURSOR_LENGTH)
}

function isMember(value: unknown): boolean {
  const member = objectValue(value)
  return Boolean(member
    && boundedText(member.name, 500) && member.name.trim()
    && boundedText(member.kind, 100)
    && Number.isSafeInteger(member.start_byte) && Number.isSafeInteger(member.end_byte)
    && Number.isSafeInteger(member.line) && (member.line as number) >= 1
    && Number.isSafeInteger(member.source_bytes) && (member.source_bytes as number) > 0 && (member.source_bytes as number) <= 64 * 1024
    && (member.start_byte as number) >= 0 && (member.end_byte as number) > (member.start_byte as number))
}

function isCandidate(value: unknown): boolean {
  const candidate = objectValue(value)
  const unit = objectValue(candidate?.unit)
  return Boolean(candidate && unit
    && boundedText(unit.id, 128) && unit.id
    && boundedText(unit.name, 500) && boundedText(unit.language, 80) && unit.language.trim()
    && isMember(candidate.member))
}

function isPendingUnit(value: unknown): boolean {
  const unit = objectValue(value)
  return Boolean(unit
    && boundedText(unit.id, 128) && unit.id
    && boundedText(unit.name, 500) && boundedText(unit.language, 80) && unit.language.trim()
    && Number.isSafeInteger(unit.memberOffset) && (unit.memberOffset as number) >= 0)
}

function isScanState(value: unknown): value is Record<string, unknown> {
  const state = objectValue(value)
  return Boolean(state && state.version === 1 && isCursor(state.cursor)
    && typeof state.complete === 'boolean'
    && Array.isArray(state.backlog) && state.backlog.length <= MAX_BACKLOG && state.backlog.every(isCandidate)
    && Array.isArray(state.pendingUnits) && state.pendingUnits.length <= MAX_PENDING_UNITS && state.pendingUnits.every(isPendingUnit)
    && isCursor(state.segmentAfterCursor)
    && typeof state.segmentComplete === 'boolean' && typeof state.segmentActive === 'boolean')
}

async function findCompletedTask(projectId: string, taskId: string) {
  const selection = await getActiveWorkspaceImportSelection(projectId)
  return prisma.task.findFirst({
    where: {
      id: taskId,
      projectId,
      capability: { in: ['decompile', 'disassemble'] },
      status: 'COMPLETED',
      artifact: { is: selection.artifactWhere },
    },
    select: { id: true, artifactId: true },
  })
}

export async function GET(request: Request, { params }: RouteParams) {
  const { id: projectId } = await params
  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return user
  const access = await requireProjectAccess(user, projectId)
  if (access instanceof NextResponse) return access

  const taskId = new URL(request.url).searchParams.get('taskId')?.trim() || ''
  if (!taskId || taskId.length > 128) return NextResponse.json({ error: 'A completed analysis run is required' }, { status: 400 })
  const task = await findCompletedTask(projectId, taskId)
  if (!task?.artifactId) return NextResponse.json({ error: 'Analysis run not found' }, { status: 404 })
  const saved = await prisma.reamonFunctionQueueState.findUnique({ where: { taskId }, select: { projectId: true, artifactId: true, state: true } })
  if (!saved || saved.projectId !== projectId || saved.artifactId !== task.artifactId || !isScanState(saved.state)) {
    return NextResponse.json({ state: null }, { headers: { 'Cache-Control': 'no-store' } })
  }
  return NextResponse.json({ state: saved.state }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(request: Request, { params }: RouteParams) {
  const { id: projectId } = await params
  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return user
  const access = await requireProjectAccess(user, projectId)
  if (access instanceof NextResponse) return access

  const taskId = new URL(request.url).searchParams.get('taskId')?.trim() || ''
  if (!taskId || taskId.length > 128) return NextResponse.json({ error: 'A completed analysis run is required' }, { status: 400 })
  const task = await findCompletedTask(projectId, taskId)
  if (!task?.artifactId) return NextResponse.json({ error: 'Analysis run not found' }, { status: 404 })

  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) return NextResponse.json({ error: 'The function scan checkpoint is too large' }, { status: 413 })
  let body: unknown
  try { body = JSON.parse(text) as unknown } catch { return NextResponse.json({ error: 'The function scan checkpoint is invalid JSON' }, { status: 400 }) }
  const state = objectValue(body)?.state
  if (!isScanState(state)) return NextResponse.json({ error: 'The function scan checkpoint is invalid or exceeds its limits' }, { status: 400 })

  const saved = await prisma.reamonFunctionQueueState.upsert({
    where: { taskId },
    create: { projectId, taskId, artifactId: task.artifactId, state: state as Prisma.InputJsonValue },
    update: { projectId, artifactId: task.artifactId, state: state as Prisma.InputJsonValue },
    select: { updatedAt: true },
  })
  return NextResponse.json({ savedAt: saved.updatedAt.toISOString() }, { headers: { 'Cache-Control': 'no-store' } })
}
