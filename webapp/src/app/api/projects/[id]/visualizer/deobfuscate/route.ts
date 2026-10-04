import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { AgentUnreachableError, agentFetch } from '@/lib/agentFetch'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { buildProjectSymbolContext } from '@/lib/reamon/maintenance-memory'

interface RouteParams { params: Promise<{ id: string }> }
interface DeobfuscateBody { unitId?: unknown; providerId?: unknown; question?: unknown }

const MAX_SOURCE_BYTES = 64 * 1024
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const MAX_QUESTION_CHARS = 1000
const MAX_RESULT_BYTES = 128 * 1024
const MAX_CONTEXT_UNITS = 8
const MAX_CONTEXT_BYTES = 16 * 1024
const MAX_DISASSEMBLY_BYTES = 8 * 1024

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

function classReferencesOf(value: unknown): string[] {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim()).filter((entry) => entry && entry.length <= 500))].slice(0, 100)
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

    // Give the model a small, same-run neighborhood so names can be inferred from
    // how this class interacts with its collaborators, rather than this file alone.
    const runPrefix = `${segments.slice(0, 4).join('/')}/`
    const references = classReferencesOf(attributes.classReferences).filter((name) => name !== unitName)
    const relatedRows = references.length ? await prisma.reamonObservation.findMany({
      where: { projectId, artifactId: artifact.id, type: 'code_unit', label: { in: references } },
      select: { id: true, label: true, attributes: true },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    }) : []
    const relatedByName = new Map<string, Record<string, unknown>>()
    const relatedUnitIdByName = new Map<string, string>()
    for (const row of relatedRows) {
      const name = row.label || ''
      const relatedAttributes = plainObject(row.attributes)
      const relatedArtifactId = typeof relatedAttributes.codeArtifactId === 'string' ? relatedAttributes.codeArtifactId : ''
      if (references.includes(name) && relatedArtifactId.startsWith(runPrefix) && !relatedByName.has(name)) {
        relatedByName.set(name, relatedAttributes)
        relatedUnitIdByName.set(name, row.id)
      }
    }
    const relatedUnitIds = [...relatedUnitIdByName.values()]
    const [maintainedRelatedRows, projectSymbolRows] = await Promise.all([
      relatedUnitIds.length ? prisma.reamonMaintainedSource.findMany({
        where: { projectId, codeUnitId: { in: relatedUnitIds } },
        select: { codeUnitId: true, unitName: true, language: true, sourceCode: true },
        orderBy: { updatedAt: 'desc' },
      }) : Promise.resolve([]),
      prisma.reamonMaintainedSource.findMany({
        where: { projectId },
        select: { unitName: true, language: true, symbolIndex: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ])
    const maintainedByUnitId = new Map(maintainedRelatedRows.map((row) => [row.codeUnitId, row]))
    const projectSymbolContext = buildProjectSymbolContext(projectSymbolRows, new Set(references))
    const contextSources: Array<{ unit_name: string; language: string; source_code: string }> = []
    let contextBytes = 0
    for (const name of references) {
      if (contextSources.length >= MAX_CONTEXT_UNITS || contextBytes >= MAX_CONTEXT_BYTES) break
      const relatedAttributes = relatedByName.get(name)
      const relatedArtifactId = typeof relatedAttributes?.codeArtifactId === 'string' ? relatedAttributes.codeArtifactId : ''
      if (!relatedArtifactId.startsWith(runPrefix) || !relatedArtifactId.includes('/sources/')) continue
      const relatedUnitId = relatedUnitIdByName.get(name)
      const maintainedSource = relatedUnitId ? maintainedByUnitId.get(relatedUnitId) : undefined
      if (maintainedSource?.sourceCode.trim()) {
        const source = maintainedSource.sourceCode.slice(0, MAX_CONTEXT_BYTES - contextBytes)
        contextSources.push({
          unit_name: `${name} (saved maintained version: ${maintainedSource.unitName})`,
          language: maintainedSource.language.slice(0, 80),
          source_code: source,
        })
        contextBytes += Buffer.byteLength(source, 'utf8')
        continue
      }
      const relatedPath = resolveDerivedArtifactPath(relatedArtifactId)
      try {
        const safeRelatedPath = await realpath(relatedPath)
        if (!isInside(rootPath, safeRelatedPath)) continue
        const relatedInfo = await stat(safeRelatedPath)
        if (!relatedInfo.isFile() || relatedInfo.size > MAX_ARTIFACT_BYTES) continue
        const remaining = MAX_CONTEXT_BYTES - contextBytes
        const relatedBytes = await readFile(safeRelatedPath)
        const source = relatedBytes.subarray(0, Math.min(remaining, MAX_CONTEXT_BYTES)).toString('utf8')
        if (!source.trim()) continue
        contextSources.push({
          unit_name: name,
          language: typeof relatedAttributes?.language === 'string' ? relatedAttributes.language.slice(0, 80) : language,
          source_code: source,
        })
        contextBytes += Buffer.byteLength(source, 'utf8')
      } catch {
        // Related evidence is optional; the selected source remains usable.
      }
    }

    const disassemblyArtifactId = typeof attributes.disassemblyArtifactId === 'string' ? attributes.disassemblyArtifactId : ''
    let disassemblySource = ''
    if (disassemblyArtifactId.startsWith(runPrefix)) {
      try {
        const safeDisassemblyPath = await realpath(resolveDerivedArtifactPath(disassemblyArtifactId))
        if (isInside(rootPath, safeDisassemblyPath)) {
          const disassemblyInfo = await stat(safeDisassemblyPath)
          if (disassemblyInfo.isFile() && disassemblyInfo.size <= MAX_ARTIFACT_BYTES) {
            disassemblySource = (await readFile(safeDisassemblyPath)).subarray(0, MAX_DISASSEMBLY_BYTES).toString('utf8')
          }
        }
      } catch {
        // Bytecode evidence is optional; the selected source remains usable.
      }
    }
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
        context_sources: contextSources,
        disassembly_source: disassemblySource,
        project_symbol_context: projectSymbolContext,
        question: typeof body.question === 'string' ? body.question.trim() : '',
      }),
    }, { timeoutMs })

    const result = plainObject(await response.json().catch(() => null))
    if (!response.ok) {
      const message = result.code === 'providers_unreachable'
        ? 'Could not load your saved AI provider. Try again shortly.'
        : result.code === 'model_unavailable'
          ? 'The selected AI provider could not answer. Check its settings and try again.'
          : result.code === 'incomplete_source'
            ? 'The model stopped before returning the complete file. Increase its output token limit or choose a model with a larger context window, then retry.'
            : result.code === 'invalid_source'
              ? 'The model draft did not parse as complete source. Try a stronger model or a more focused transformation.'
            : result.code === 'behavior_dropped'
              ? 'The model removed executable Java logic. Choose a stronger model or retry with a narrower transformation.'
            : result.code === 'wrong_target'
              ? 'The model still returned a different Java type after retrying with the selected file only. Choose a stronger model.'
              : result.code === 'context_exceeded'
                ? 'This code unit exceeds the model context window even after related-code context was removed. Choose a larger-context model or a smaller code unit.'
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
      syntaxValidated: result.syntax_validated === true,
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
