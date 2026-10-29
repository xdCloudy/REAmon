import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams { params: Promise<{ id: string; taskId: string }> }
const NO_STORE = { 'Cache-Control': 'private, no-store' }
const MAX_ATTEMPT_BYTES = 96 * 1024
const MAX_BATCH_UNITS = 5
const MAX_CASE_ATTEMPTS = 24
const MAX_CASE_RUNTIME_BUDGET_MS = 30 * 60_000
const MANUAL_RECONSTRUCTION_LANGUAGES = new Map<string, string>([
  ['c', 'C'], ['c++', 'C++'], ['c#', 'C#'], ['csharp', 'C#'],
  ['go', 'Go'], ['java', 'Java'], ['javascript', 'JavaScript'],
  ['kotlin', 'Kotlin'], ['objective-c', 'Objective-C'], ['objective c', 'Objective-C'],
  ['python', 'Python'], ['rust', 'Rust'], ['swift', 'Swift'], ['typescript', 'TypeScript'],
])

function reconstructionLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return MANUAL_RECONSTRUCTION_LANGUAGES.get(value.trim().toLowerCase()) ?? null
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string') return ''
  const bytes = Buffer.from(value, 'utf8')
  return bytes.subarray(0, maxBytes).toString('utf8')
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, taskId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    let body: Record<string, unknown>
    try {
      const parsed: unknown = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body')
      body = parsed as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'A saved provider is required' }, { status: 400, headers: NO_STORE })
    }
    const rawUnitKeys = Array.isArray(body.unitKeys)
      ? body.unitKeys
      : typeof body.unitKey === 'string' ? [body.unitKey] : []
    if (typeof body.providerId !== 'string' || body.providerId.length > 128
      || rawUnitKeys.length < 1 || rawUnitKeys.length > MAX_BATCH_UNITS
      || rawUnitKeys.some((key) => typeof key !== 'string' || !key.trim() || key.length > 500)) {
      return NextResponse.json({ error: 'Choose a code unit and saved OpenAI-compatible provider' }, { status: 400, headers: NO_STORE })
    }
    const requestedUnitKeys = (rawUnitKeys as string[]).map((key) => key.trim())
    if (new Set(requestedUnitKeys).size !== requestedUnitKeys.length) {
      return NextResponse.json({ error: 'Choose each code unit only once' }, { status: 400, headers: NO_STORE })
    }

    const investigation = await prisma.reamonInvestigationCase.findFirst({
      where: { projectId, taskId },
      select: { id: true, artifactId: true, artifactSha256: true, capability: true, requestedBy: true, failureEvidence: true, status: true },
    })
    if (!investigation) return NextResponse.json({ error: 'Queue this failed run for investigation first' }, { status: 404, headers: NO_STORE })
    if (investigation.capability !== 'decompile' && investigation.capability !== 'disassemble') {
      return NextResponse.json({ error: 'Manual source reconstruction currently supports failed decompilation and disassembly runs only' }, { status: 415, headers: NO_STORE })
    }

    const provider = await prisma.userLlmProvider.findFirst({
      where: { id: body.providerId.trim(), userId: user.userId, providerType: 'openai_compatible' },
      select: { id: true, name: true, modelIdentifier: true, timeout: true },
    })
    if (!provider) return NextResponse.json({ error: 'Saved OpenAI-compatible provider not found' }, { status: 404, headers: NO_STORE })

    const failureEvidence = object(investigation.failureEvidence)
    const partial = object(failureEvidence.partialProviderOutput)
    const units = Array.isArray(partial.partialUnits) ? partial.partialUnits : []
    const unitByKey = new Map(units.map(object).filter((candidate) => typeof candidate.key === 'string').map((candidate) => [candidate.key as string, candidate]))
    const selectedUnits = requestedUnitKeys.map((key) => unitByKey.get(key))
    if (selectedUnits.some((unit) => !unit || !['function', 'code_unit'].includes(String(unit.type))
      || reconstructionLanguage(object(unit.attributes).language) === null
      || !['assembly', 'disassembly', 'bytecode', 'instructions'].some((key) => typeof object(unit.attributes)[key] === 'string' && String(object(unit.attributes)[key]).trim()))) {
      return NextResponse.json({ error: 'Selected unit has no instruction evidence for a supported reconstruction language' }, { status: 422, headers: NO_STORE })
    }
    const providerText = object(failureEvidence.providerTextEvidence)
    const providerFields = Array.isArray(providerText.fields) ? providerText.fields : []
    const providerEvidence = providerFields.slice(0, 2).flatMap((value) => {
      const field = object(value)
      const evidence = boundedText(field.text, 8 * 1024)
      return evidence ? [{ provider: `${String(failureEvidence.providerId || 'failed provider')} · ${String(field.field || 'output')}`.slice(0, 128), evidence }] : []
    })
    const timeoutSeconds = Number.isFinite(provider.timeout) ? provider.timeout : 120
    const timeoutMs = Math.max(10_000, Math.min(300_000, timeoutSeconds * 1000))
    const queued: Array<{
      codeUnitId: string
      unitName: string
      payload: Record<string, unknown>
      sourceHash: string
      outputLanguage: string
    }> = []
    for (const unit of selectedUnits) {
      if (!unit) continue
      const attributes = object(unit.attributes)
      const outputLanguage = reconstructionLanguage(attributes.language)
      if (!outputLanguage) continue
      const unitKey = String(unit.key)
      const unitDigest = createHash('sha256').update(unitKey).digest('hex').slice(0, 24)
      const codeUnitId = `investigation:${investigation.id}:unit:${unitDigest}`
      const assembly = ['assembly', 'disassembly', 'bytecode', 'instructions']
        .map((key) => boundedText(attributes[key], 48 * 1024))
        .find((value) => value.trim()) || ''
      const payload = {
        model: `custom/${provider.id}`,
        user_id: user.userId,
        unit_name: boundedText(unit.label || attributes.qualifiedName || attributes.name || unitKey, 500) || 'Recovered code unit',
        artifact_sha256: investigation.artifactSha256,
        output_language: outputLanguage,
        architecture: boundedText(attributes.architecture || attributes.abi, 80) || 'unknown',
        assembly,
        control_flow: boundedText(attributes.controlFlow, 8 * 1024),
        data_references: boundedText(attributes.dataReferences, 8 * 1024),
        provider_evidence: providerEvidence,
        question: 'Reconstruct this failed decompilation unit from the available evidence. Preserve uncertainty and report only what evidence supports.',
        investigationCaseId: investigation.id,
        unitKey,
        taskId,
      }
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_ATTEMPT_BYTES) {
        return NextResponse.json({ error: 'Captured investigation evidence exceeds the attempt size limit' }, { status: 413, headers: NO_STORE })
      }
      const sourceHash = createHash('sha256').update(stableJson(payload)).digest('hex')
      queued.push({ codeUnitId, unitName: String(payload.unit_name), payload, sourceHash, outputLanguage })
    }

    // Lock the case row while checking persisted attempts so concurrent dispatch
    // requests cannot each reserve the same remaining investigation budget.
    const attempts = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM reamon_investigation_cases WHERE id = ${investigation.id} FOR UPDATE`
      const prior = await tx.reamonCodeAttempt.findMany({
        where: {
          projectId, artifactId: investigation.artifactId, runKey: taskId, scope: 'manual-investigation',
          OR: [
            { codeUnitId: { startsWith: `investigation:${investigation.id}:unit:` } },
            { codeUnitId: `investigation:${investigation.id}` },
          ],
        },
        select: { id: true, codeUnitId: true, status: true, timeoutMs: true, createdAt: true },
      })
      const active = prior.filter((attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING')
      const legacyActive = active.some((attempt) => attempt.codeUnitId === `investigation:${investigation.id}`)
      const toCreate = legacyActive ? [] : queued.filter((candidate) => !active.some((attempt) => attempt.codeUnitId === candidate.codeUnitId))
      const reservedRuntimeMs = prior.reduce((sum, attempt) => sum + Math.max(0, attempt.timeoutMs), 0)
      if (toCreate.length > 0 && (prior.length + toCreate.length > MAX_CASE_ATTEMPTS
        || reservedRuntimeMs + toCreate.length * timeoutMs > MAX_CASE_RUNTIME_BUDGET_MS)) {
        return null
      }
      const result = active.filter((attempt) => queued.some((candidate) => candidate.codeUnitId === attempt.codeUnitId)
        || (legacyActive && queued.length > 0)).map(({ id, status, createdAt }) => ({ id, status, createdAt }))
      for (const candidate of toCreate) {
        result.push(await tx.reamonCodeAttempt.create({
          data: {
            projectId,
            ownerUserId: user.userId,
            artifactId: investigation.artifactId,
            runKey: taskId,
            codeUnitId: candidate.codeUnitId,
            unitName: candidate.unitName,
            language: candidate.outputLanguage,
            sourceHash: candidate.sourceHash,
            providerName: provider.name,
            modelIdentifier: provider.modelIdentifier,
            question: String(candidate.payload.question),
            scope: 'manual-investigation',
            status: 'QUEUED',
            timeoutMs,
            requestPayload: candidate.payload as unknown as Prisma.InputJsonObject,
          },
          select: { id: true, status: true, createdAt: true },
        }))
      }
      return {
        attempts: result,
        usedAttempts: prior.length + toCreate.length,
        reservedRuntimeMs: reservedRuntimeMs + toCreate.length * timeoutMs,
      }
    })
    if (attempts === null) {
      return NextResponse.json({
        error: 'This investigation reached its persisted attempt or runtime budget. Review existing drafts or start a new analysis run.',
        budget: { maxAttempts: MAX_CASE_ATTEMPTS, maxReservedRuntimeMs: MAX_CASE_RUNTIME_BUDGET_MS },
      }, { status: 429, headers: NO_STORE })
    }
    return NextResponse.json({
      attempt: attempts.attempts[0] ?? null,
      attempts: attempts.attempts,
      budget: {
        usedAttempts: attempts.usedAttempts,
        maxAttempts: MAX_CASE_ATTEMPTS,
        reservedRuntimeMs: attempts.reservedRuntimeMs,
        maxReservedRuntimeMs: MAX_CASE_RUNTIME_BUDGET_MS,
      },
      candidateStatus: 'QUEUED_FOR_RECONSTRUCTION',
      validationStatus: 'UNAVAILABLE',
    }, { status: 202, headers: NO_STORE })
  } catch (error) {
    console.error('Failed to queue manual REAmon reconstruction:', error)
    return NextResponse.json({ error: 'Failed to queue manual reconstruction' }, { status: 500, headers: NO_STORE })
  }
}
