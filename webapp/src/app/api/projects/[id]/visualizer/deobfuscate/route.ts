import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { AgentUnreachableError, agentFetch } from '@/lib/agentFetch'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'

interface RouteParams { params: Promise<{ id: string }> }
interface DeobfuscateBody { unitId?: unknown; providerId?: unknown; question?: unknown }

const MAX_SOURCE_BYTES = 64 * 1024
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const MAX_QUESTION_CHARS = 1000
const MAX_RESULT_BYTES = 128 * 1024

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    let body: DeobfuscateBody
    try { body = await request.json() as DeobfuscateBody } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !validId(body.unitId) || !validId(body.providerId)) {
      return NextResponse.json({ error: 'A code unit and saved provider are required' }, { status: 400 })
    }
    if (body.question !== undefined && (typeof body.question !== 'string' || body.question.length > MAX_QUESTION_CHARS)) {
      return NextResponse.json({ error: `Request must be at most ${MAX_QUESTION_CHARS} characters` }, { status: 400 })
    }

    const provider = await prisma.userLlmProvider.findFirst({
      where: { id: body.providerId.trim(), userId: user.userId, providerType: 'openai_compatible' },
      select: { id: true, name: true, modelIdentifier: true, timeout: true },
    })
    if (!provider) return NextResponse.json({ error: 'Saved OpenAI-compatible provider not found' }, { status: 404 })

    const observation = await prisma.reamonObservation.findFirst({
      where: { id: body.unitId.trim(), projectId, type: 'code_unit' },
      select: { id: true, artifactId: true, label: true, attributes: true },
    })
    if (!observation?.artifactId) return NextResponse.json({ error: 'Code unit not found' }, { status: 404 })

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const artifact = await prisma.artifact.findFirst({
      where: { AND: [{ id: observation.artifactId, projectId }, selection.artifactWhere] },
      select: { id: true },
    })
    if (!artifact) return NextResponse.json({ error: 'Code unit is not part of the active workspace' }, { status: 404 })

    const attributes = plainObject(observation.attributes)
    const codeArtifactId = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
    const pathPrefix = `${projectId}/${artifact.id}/`
    const segments = codeArtifactId.split('/')
    if (!codeArtifactId.startsWith(pathPrefix) || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
      return NextResponse.json({ error: 'Code unit has no valid linked source artifact' }, { status: 404 })
    }

    const configuredRoot = derivedArtifactRoot()
    const filePath = resolveDerivedArtifactPath(codeArtifactId)
    const [rootPath, sourcePath] = await Promise.all([realpath(configuredRoot), realpath(filePath)])
    if (!isInside(rootPath, sourcePath)) return NextResponse.json({ error: 'Linked source path is invalid' }, { status: 404 })
    const sourceInfo = await stat(sourcePath)
    if (!sourceInfo.isFile() || sourceInfo.size > MAX_ARTIFACT_BYTES) {
      return NextResponse.json({ error: 'Linked source exceeds the deobfuscation limit' }, { status: 413 })
    }
    const bytes = await readFile(sourcePath)
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'This source file is too large for one AI transformation. Edit it in a local tool or select a smaller code unit.' }, { status: 413 })
    }
    const unitName = (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
      || (typeof attributes.name === 'string' && attributes.name)
      || observation.label
      || 'Selected code unit'
    const language = typeof attributes.language === 'string' ? attributes.language : 'unknown'
    const timeoutSeconds = typeof provider.timeout === 'number' && Number.isFinite(provider.timeout) ? provider.timeout : 120
    const timeoutMs = Math.max(10_000, Math.min(300_000, timeoutSeconds * 1000))

    const response = await agentFetch('/reamon/code/deobfuscate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `custom/${provider.id}`,
        user_id: user.userId,
        unit_name: String(unitName).slice(0, 500),
        language: language.slice(0, 80),
        source_code: bytes.toString('utf8'),
        question: typeof body.question === 'string' ? body.question.trim() : '',
      }),
    }, { timeoutMs })

    const result = plainObject(await response.json().catch(() => null))
    if (!response.ok) {
      const message = result.code === 'providers_unreachable'
        ? 'Could not load your saved AI provider. Try again shortly.'
        : result.code === 'model_unavailable'
          ? 'The selected AI provider could not answer. Check its settings and try again.'
          : 'AI could not produce a maintainable version. Try again shortly.'
      return NextResponse.json({ error: message }, { status: response.status, headers: { 'Cache-Control': 'no-store' } })
    }
    if (typeof result.source_code !== 'string' || !result.source_code.trim()) {
      return NextResponse.json({ error: 'The AI provider returned no rewritten source' }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
    }
    if (Buffer.byteLength(result.source_code, 'utf8') > MAX_RESULT_BYTES) {
      return NextResponse.json({ error: 'The rewritten source exceeds the save limit' }, { status: 502, headers: { 'Cache-Control': 'no-store' } })
    }

    return NextResponse.json({
      sourceCode: result.source_code,
      providerName: provider.name,
      model: provider.modelIdentifier,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof AgentUnreachableError) {
      console.error('AI deobfuscation could not reach the agent:', error.message)
      return NextResponse.json({ error: 'The AI analysis service is unavailable. Try again shortly.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    }
    console.error('Failed to deobfuscate REAmon code unit:', error)
    return NextResponse.json({ error: 'Failed to improve this code unit' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
