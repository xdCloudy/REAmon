import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getWorkspaceArtifact } from '@/lib/reamon/inventory-query'
import { resolveCapabilities } from '@/lib/reamon/capabilities'
import { ensureProviderRegistered, getBuiltinProvider } from '@/lib/reamon/provider-registry'
import type { TargetProfile } from '@/lib/reamon/types'

interface RouteParams { params: Promise<{ id: string }> }

interface ScheduleBody {
  artifactId?: unknown
  providerId?: unknown
  capability?: unknown
}

const NO_STORE = { 'Cache-Control': 'no-store' }

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400, headers: NO_STORE })
}

function readString(body: ScheduleBody, key: keyof ScheduleBody, max: number): string | null {
  const value = body[key]
  if (typeof value !== 'string') return null
  const normalised = value.trim()
  return normalised && normalised.length <= max ? normalised : null
}

function serialiseTask(task: {
  id: string
  title: string
  category: string
  status: string
  progress: number
  providerId: string | null
  capability: string | null
  artifactId: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: task.id,
    title: task.title,
    category: task.category,
    status: task.status,
    progress: task.progress,
    providerId: task.providerId,
    capability: task.capability,
    artifactId: task.artifactId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    let body: ScheduleBody
    try {
      body = await request.json() as ScheduleBody
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Request body must be an object')

    const artifactId = readString(body, 'artifactId', 128)
    const providerId = readString(body, 'providerId', 128)
    const requestedCapability = readString(body, 'capability', 64)?.toLowerCase() || null
    if (!artifactId || !providerId || !requestedCapability) {
      return badRequest('artifactId, providerId, and capability are required')
    }

    const artifact = await getWorkspaceArtifact(projectId, artifactId)
    if (!artifact) return NextResponse.json({ error: 'Workspace artifact not found' }, { status: 404, headers: NO_STORE })

    const plugin = getBuiltinProvider(providerId)
    if (!plugin) return NextResponse.json({ error: 'Provider not found' }, { status: 404, headers: NO_STORE })
    const match = resolveCapabilities(artifact.profile as TargetProfile, [plugin])[0]
    const capability = match?.capabilities.find((candidate) => candidate.toLowerCase() === requestedCapability)
    if (!match || !capability) {
      return NextResponse.json({ error: 'Provider is not compatible with this artifact capability' }, { status: 409, headers: NO_STORE })
    }

    const provider = await ensureProviderRegistered(plugin.manifest)
    if (!provider.enabled) {
      return NextResponse.json({ error: 'Provider is disabled' }, { status: 409, headers: NO_STORE })
    }

    const idempotencyKey = `analysis:${projectId}:${artifact.id}:${provider.pluginId}:${capability}`
    const taskSelect = {
      id: true,
      title: true,
      category: true,
      status: true,
      progress: true,
      providerId: true,
      capability: true,
      artifactId: true,
      createdAt: true,
      updatedAt: true,
    } as const
    const existing = await prisma.task.findUnique({ where: { idempotencyKey }, select: taskSelect })
    if (existing) {
      return NextResponse.json({ scheduled: false, reused: true, task: serialiseTask(existing) }, { headers: NO_STORE })
    }

    try {
      const task = await prisma.$transaction(async (tx) => {
        const created = await tx.task.create({
          data: {
            projectId,
            targetId: artifact.targetId,
            artifactId: artifact.id,
            providerId: provider.id,
            capability,
            title: `${plugin.manifest.name}: ${capability} · ${artifact.relativePath}`,
            category: plugin.manifest.category,
            status: 'QUEUED',
            progress: 0,
            options: {},
            idempotencyKey,
          },
          select: taskSelect,
        })
        await tx.workspaceActivity.create({
          data: {
            projectId,
            actor: 'Operator',
            eventType: 'analysis.task.queued',
            message: `Queued ${capability} for ${artifact.relativePath}`,
            data: { taskId: created.id, artifactId: artifact.id, providerId: provider.pluginId, capability },
          },
        })
        return created
      })
      return NextResponse.json({ scheduled: true, reused: false, task: serialiseTask(task) }, { status: 201, headers: NO_STORE })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const winner = await prisma.task.findUnique({ where: { idempotencyKey }, select: taskSelect })
      if (!winner) throw error
      return NextResponse.json({ scheduled: false, reused: true, task: serialiseTask(winner) }, { headers: NO_STORE })
    }
  } catch (error) {
    console.error('Failed to schedule REAmon analysis task:', error)
    return NextResponse.json({ error: 'Failed to schedule analysis task' }, { status: 500, headers: NO_STORE })
  }
}
