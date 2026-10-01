import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { profileArtifact } from '@/lib/reamon/profiler'
import { resolveCapabilities } from '@/lib/reamon/capabilities'

interface RouteParams {
  params: Promise<{ id: string }>
}

const defaultMaxBytes = 64 * 1024 * 1024

function maxArtifactBytes(): number {
  const configured = Number.parseInt(process.env.REAMON_MAX_ARTIFACT_BYTES || '', 10)
  return Number.isFinite(configured) && configured > 0 ? configured : defaultMaxBytes
}

function artifactRoot(): string {
  return process.env.REAMON_ARTIFACTS_PATH || path.join(process.cwd(), 'data', 'reamon-artifacts')
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const form = await request.formData()
    const fileValue = form.get('file')
    if (!(fileValue instanceof File)) {
      return NextResponse.json({ error: 'A file is required' }, { status: 400 })
    }
    if (fileValue.size > maxArtifactBytes()) {
      return NextResponse.json({ error: `File exceeds the ${Math.round(maxArtifactBytes() / 1024 / 1024)} MiB limit` }, { status: 413 })
    }

    const bytes = new Uint8Array(await fileValue.arrayBuffer())
    const originalName = fileValue.name.trim() || 'unnamed-artifact'
    const profile = profileArtifact(bytes, originalName, fileValue.type)
    const profileJson = profile as unknown as Prisma.InputJsonValue
    const capabilities = resolveCapabilities(profile)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const targetName = String(form.get('targetName') || originalName).trim() || originalName
    const artifactId = randomUUID()
    const targetId = String(form.get('targetId') || '').trim()
    const relativePath = path.join(projectId, artifactId)
    const absolutePath = path.join(artifactRoot(), relativePath)

    if (targetId) {
      const target = await prisma.target.findFirst({ where: { id: targetId, projectId }, select: { id: true } })
      if (!target) return NextResponse.json({ error: 'Target not found' }, { status: 404 })
    }

    const target = targetId
      ? await prisma.target.update({
          where: { id: targetId },
          data: { status: 'IDENTIFIED', profile: profileJson },
        })
      : await prisma.target.create({
          data: {
            projectId,
            name: targetName,
            targetType: profile.targetType,
            locator: `file:${originalName}`,
            status: 'IDENTIFIED',
            profile: profileJson,
          },
        })

    try {
      await mkdir(path.dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, bytes)
      const artifact = await prisma.artifact.create({
        data: {
          id: artifactId,
          projectId,
          targetId: target.id,
          name: originalName,
          originalName,
          storagePath: relativePath,
          sha256,
          sizeBytes: bytes.byteLength,
          mimeType: profile.mimeType,
          extension: profile.extension,
          status: 'IDENTIFIED',
          profile: profileJson,
          capabilities: capabilities.flatMap((match) => match.capabilities),
        },
      })

      await prisma.evidence.create({
        data: {
          projectId,
          targetId: target.id,
          artifactId: artifact.id,
          kind: 'profile',
          summary: `Profiler identified ${profile.format} (${profile.mimeType})`,
          source: 'reamon-artifact-profiler',
          data: profileJson,
        },
      })
      await prisma.workspaceActivity.create({
        data: {
          projectId,
          actor: 'Profiler',
          eventType: 'artifact.profiled',
          message: `Profiled ${originalName} as ${profile.format}`,
          data: { artifactId: artifact.id, targetId: target.id, format: profile.format },
        },
      })

      return NextResponse.json({
        target: {
          id: target.id,
          name: target.name,
          targetType: target.targetType,
          status: target.status,
          profile: target.profile,
        },
        artifact: {
          id: artifact.id,
          name: artifact.name,
          originalName: artifact.originalName,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          mimeType: artifact.mimeType,
          extension: artifact.extension,
          status: artifact.status,
          profile,
          capabilities,
        },
      }, { status: 201 })
    } catch (error) {
      await prisma.artifact.deleteMany({ where: { id: artifactId, projectId } }).catch(() => {})
      if (!targetId) await prisma.target.deleteMany({ where: { id: target.id, projectId } }).catch(() => {})
      throw error
    }
  } catch (error) {
    console.error('Failed to import REAmon target:', error)
    return NextResponse.json({ error: 'Failed to import target' }, { status: 500 })
  }
}
