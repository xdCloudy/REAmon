import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'

interface RouteParams { params: Promise<{ id: string; taskId: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const INVESTIGATABLE_CAPABILITIES = ['decompile', 'disassemble']
const MAX_PARTIAL_UNITS = 100
const MAX_PARTIAL_UNIT_TEXT_BYTES = 48 * 1024
const MAX_PARTIAL_UNIT_TEXT_FIELD_BYTES = 8 * 1024
const MAX_PROVIDER_TEXT_BYTES = 48 * 1024
const MAX_PROVIDER_TEXT_FIELD_BYTES = 24 * 1024
const MANUAL_RECONSTRUCTION_LANGUAGES = new Set([
  'c', 'c++', 'c#', 'csharp', 'go', 'java', 'javascript', 'kotlin',
  'objective-c', 'objective c', 'python', 'rust', 'swift', 'typescript',
])
const PROVIDER_TEXT_FIELDS = ['assembly', 'disassembly', 'bytecode', 'instructions', 'controlFlow', 'dataReferences', 'ir', 'output', 'stdout', 'stderr'] as const
const PARTIAL_UNIT_TEXT_FIELDS = new Set(['assembly', 'disassembly', 'bytecode', 'instructions', 'controlFlow', 'dataReferences', 'ir', 'providerOutput'])
const PARTIAL_UNIT_ATTRIBUTE_KEYS = [
  'address', 'startAddress', 'endAddress', 'relativePath', 'language', 'unitType', 'codeArtifactId',
  'codeArtifactSha256', 'inputArtifactSha256', 'identity', 'qualifiedName', 'name', 'methodName',
  'signature', 'descriptor', 'sizeBytes', 'parentCodeUnitKey', 'assembly', 'disassembly', 'bytecode',
  'instructions', 'controlFlow', 'dataReferences', 'ir', 'providerOutput',
] as const

function partialUnitSnapshot(result: Record<string, unknown> | null) {
  const providerFailure = result?.providerFailure
  if (!providerFailure || typeof providerFailure !== 'object' || Array.isArray(providerFailure)) return null
  const failure = providerFailure as Record<string, unknown>
  if (failure.schemaVersion !== 1 || !Array.isArray(failure.partialUnits)) return null
  let remainingTextBytes = MAX_PARTIAL_UNIT_TEXT_BYTES
  let textEvidenceTruncated = false
  const partialUnits = failure.partialUnits.slice(0, MAX_PARTIAL_UNITS).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const unit = value as Record<string, unknown>
    if ((unit.type !== 'code_unit' && unit.type !== 'function') || typeof unit.key !== 'string' || !unit.key.trim()) return []
    const attributes: Record<string, string | number | boolean> = {}
    const textEvidence: Record<string, { sha256: string; capturedSha256: string; originalBytes: number; capturedBytes: number; truncated: boolean; originalHashVerified: boolean }> = {}
    const rawTextEvidence = unit.textEvidence && typeof unit.textEvidence === 'object' && !Array.isArray(unit.textEvidence)
      ? unit.textEvidence as Record<string, unknown>
      : {}
    if (unit.attributes && typeof unit.attributes === 'object' && !Array.isArray(unit.attributes)) {
      const rawAttributes = unit.attributes as Record<string, unknown>
      for (const key of PARTIAL_UNIT_ATTRIBUTE_KEYS) {
        const candidate = rawAttributes[key]
        if (typeof candidate === 'string' && PARTIAL_UNIT_TEXT_FIELDS.has(key)) {
          const originalBytes = Buffer.byteLength(candidate, 'utf8')
          const captured = truncateUtf8(candidate, Math.min(MAX_PARTIAL_UNIT_TEXT_FIELD_BYTES, remainingTextBytes))
          const capturedBytes = Buffer.byteLength(captured, 'utf8')
          remainingTextBytes -= capturedBytes
          attributes[key] = captured
          const capturedSha256 = createHash('sha256').update(captured, 'utf8').digest('hex')
          const supplied = rawTextEvidence[key] && typeof rawTextEvidence[key] === 'object' && !Array.isArray(rawTextEvidence[key])
            ? rawTextEvidence[key] as Record<string, unknown>
            : null
          if (supplied
            && typeof supplied.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(supplied.sha256)
            && supplied.capturedSha256 === capturedSha256
            && supplied.capturedBytes === capturedBytes
            && typeof supplied.originalBytes === 'number' && Number.isSafeInteger(supplied.originalBytes) && supplied.originalBytes >= capturedBytes
            && supplied.truncated === (supplied.originalBytes > capturedBytes)) {
            textEvidence[key] = {
              sha256: supplied.sha256.toLowerCase(),
              capturedSha256,
              originalBytes: supplied.originalBytes,
              capturedBytes,
              truncated: supplied.originalBytes > capturedBytes,
              originalHashVerified: true,
            }
          } else {
            textEvidence[key] = {
              sha256: capturedSha256,
              capturedSha256,
              originalBytes,
              capturedBytes,
              truncated: capturedBytes < originalBytes,
              originalHashVerified: false,
            }
          }
          textEvidenceTruncated ||= textEvidence[key].truncated
        } else if (typeof candidate === 'string' && candidate.length <= 2_000) attributes[key] = candidate
        else if (typeof candidate === 'number' && Number.isFinite(candidate)) attributes[key] = candidate
        else if (typeof candidate === 'boolean') attributes[key] = candidate
      }
    }
    for (const hashKey of ['codeArtifactSha256', 'inputArtifactSha256'] as const) {
      if (typeof attributes[hashKey] === 'string' && !/^[a-f0-9]{64}$/i.test(attributes[hashKey] as string)) delete attributes[hashKey]
    }
    return [{
      type: unit.type,
      key: unit.key.trim().slice(0, 500),
      label: typeof unit.label === 'string' ? unit.label.slice(0, 500) : '',
      attributes,
      textEvidence,
    }]
  })
  return {
    schemaVersion: 1,
    runToken: typeof failure.runToken === 'string' && /^[a-f0-9-]{16,128}$/i.test(failure.runToken) ? failure.runToken : null,
    inputArtifactSha256: typeof failure.inputArtifactSha256 === 'string' && /^[a-f0-9]{64}$/i.test(failure.inputArtifactSha256)
      ? failure.inputArtifactSha256.toLowerCase()
      : null,
    observationCount: typeof failure.observationCount === 'number' && Number.isSafeInteger(failure.observationCount) ? failure.observationCount : null,
    partialCodeUnitCount: typeof failure.partialCodeUnitCount === 'number' && Number.isSafeInteger(failure.partialCodeUnitCount) ? failure.partialCodeUnitCount : partialUnits.length,
    partialUnits,
    partialUnitsTruncated: failure.partialUnitsTruncated === true || (Array.isArray(failure.partialUnits) && failure.partialUnits.length > partialUnits.length),
    partialUnitTextEvidenceBytes: MAX_PARTIAL_UNIT_TEXT_BYTES - remainingTextBytes,
    partialUnitTextEvidenceTruncated: textEvidenceTruncated,
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let captured = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    captured += character
    bytes += characterBytes
  }
  return captured
}

function providerTextSnapshot(result: Record<string, unknown> | null) {
  let remainingBytes = MAX_PROVIDER_TEXT_BYTES
  const fields = []
  for (const field of PROVIDER_TEXT_FIELDS) {
    const value = result?.[field]
    if (typeof value !== 'string' || value.length === 0) continue
    const originalBytes = Buffer.byteLength(value, 'utf8')
    const captured = truncateUtf8(value, Math.min(MAX_PROVIDER_TEXT_FIELD_BYTES, remainingBytes))
    const capturedBytes = Buffer.byteLength(captured, 'utf8')
    remainingBytes -= capturedBytes
    fields.push({
      field,
      text: captured,
      sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
      capturedSha256: createHash('sha256').update(captured, 'utf8').digest('hex'),
      originalBytes,
      capturedBytes,
      truncated: capturedBytes < originalBytes,
    })
  }
  return {
    schemaVersion: 1,
    fields,
    capturedBytes: MAX_PROVIDER_TEXT_BYTES - remainingBytes,
    truncated: fields.some((field) => field.truncated),
  }
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, taskId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const summaryOnly = new URL(request.url).searchParams.get('summary') === '1'
    const investigation = await prisma.reamonInvestigationCase.findFirst({
      where: { projectId, taskId },
      select: {
        id: true,
        taskId: true,
        artifactId: true,
        artifactSha256: true,
        capability: true,
        providerId: true,
        providerVersion: true,
        status: true,
        failureEvidence: true,
        ...(!summaryOnly ? { history: true } : {}),
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    const attempts = investigation ? await prisma.reamonCodeAttempt.findMany({
      where: {
        projectId, artifactId: investigation.artifactId, runKey: taskId, scope: 'manual-investigation',
        OR: [
          { codeUnitId: `investigation:${investigation.id}` },
          { codeUnitId: { startsWith: `investigation:${investigation.id}:unit:` } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, codeUnitId: true, unitName: true, status: true, providerName: true, modelIdentifier: true, errorCode: true, errorMessage: true, resultSource: true, qualityReview: true, validationStatus: true, createdAt: true, completedAt: true },
    }) : []
    const latestAttempt = attempts[0]
    const evidence = investigation?.failureEvidence && typeof investigation.failureEvidence === 'object' && !Array.isArray(investigation.failureEvidence)
      ? investigation.failureEvidence as Record<string, unknown>
      : {}
    const partial = evidence.partialProviderOutput && typeof evidence.partialProviderOutput === 'object' && !Array.isArray(evidence.partialProviderOutput)
      ? evidence.partialProviderOutput as Record<string, unknown>
      : {}
    const partialUnits = Array.isArray(partial.partialUnits) ? partial.partialUnits : []
    const candidateUnits = partialUnits.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const unit = value as Record<string, unknown>
      const attributes = unit.attributes && typeof unit.attributes === 'object' && !Array.isArray(unit.attributes)
        ? unit.attributes as Record<string, unknown>
        : {}
      const language = typeof attributes.language === 'string' ? attributes.language.toLowerCase() : ''
      const instructionFields = ['assembly', 'disassembly', 'bytecode', 'instructions']
        .filter((field) => typeof attributes[field] === 'string' && (attributes[field] as string).trim())
      if (typeof unit.key !== 'string' || !unit.key.trim() || !MANUAL_RECONSTRUCTION_LANGUAGES.has(language) || !instructionFields.length) return []
      return [{ key: unit.key.slice(0, 500), label: typeof unit.label === 'string' ? unit.label.slice(0, 500) : unit.key.slice(0, 500), language, instructionFields }]
    }).slice(0, MAX_PARTIAL_UNITS)
    const status = latestAttempt?.status || investigation?.status || null
    return NextResponse.json({
      investigation: investigation ? {
        id: investigation.id,
        taskId: investigation.taskId,
        artifactId: investigation.artifactId,
        artifactSha256: investigation.artifactSha256,
        capability: investigation.capability,
        providerId: investigation.providerId,
        providerVersion: investigation.providerVersion,
        status,
        revision: investigation.revision,
        createdAt: investigation.createdAt,
        updatedAt: investigation.updatedAt,
        ...(!summaryOnly ? { failureEvidence: investigation.failureEvidence, history: investigation.history } : {}),
      } : null,
      attempts,
      candidateUnits,
    }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to load REAmon investigation case:', error)
    return NextResponse.json({ error: 'Failed to load investigation case' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, taskId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        projectId,
        status: { in: ['FAILED', 'CANCELLED'] },
        capability: { in: INVESTIGATABLE_CAPABILITIES },
        artifact: { is: selection.artifactWhere },
      },
      select: {
        id: true,
        projectId: true,
        artifactId: true,
        capability: true,
        status: true,
        title: true,
        progressMessage: true,
        error: true,
        result: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        artifact: { select: { sha256: true } },
        provider: { select: { pluginId: true, version: true } },
      },
    })
    if (!task?.artifactId || !task.artifact?.sha256 || !task.capability) {
      return NextResponse.json({ error: 'Only failed analysis runs for the active artifact can be investigated' }, { status: 409, headers: NO_STORE })
    }

    const existing = await prisma.reamonInvestigationCase.findUnique({
      where: { taskId },
      select: { id: true, status: true, revision: true },
    })
    if (existing) return NextResponse.json({ investigation: existing, alreadyQueued: true }, { headers: NO_STORE })

    const observationCount = await prisma.reamonObservation.count({ where: { projectId, taskId } })
    const result = task.result && typeof task.result === 'object' && !Array.isArray(task.result)
      ? task.result as Record<string, unknown>
      : null
    const failureEvidence = {
      schemaVersion: 1,
      taskId: task.id,
      capability: task.capability,
      taskTitle: task.title.slice(0, 500),
      taskStatus: task.status,
      artifactSha256: task.artifact.sha256.toLowerCase(),
      providerId: task.provider?.pluginId ?? null,
      providerVersion: task.provider?.version ?? null,
      lastProgress: task.progressMessage.slice(0, 500),
      failureMessage: task.error.slice(0, 4000),
      startedAt: task.startedAt?.toISOString() ?? null,
      failedAt: task.completedAt?.toISOString() ?? null,
      existingObservationCount: observationCount,
      resultKeys: result ? Object.keys(result).slice(0, 100) : [],
      partialProviderOutput: partialUnitSnapshot(result),
      providerTextEvidence: providerTextSnapshot(result),
    }

    let investigation
    try {
      investigation = await prisma.reamonInvestigationCase.create({
        data: {
          projectId,
          taskId,
          artifactId: task.artifactId,
          artifactSha256: task.artifact.sha256.toLowerCase(),
          capability: task.capability,
          providerId: task.provider?.pluginId ?? null,
          providerVersion: task.provider?.version ?? null,
          status: 'QUEUED',
          failureEvidence,
          history: [{ event: 'QUEUED', at: new Date().toISOString(), requestedBy: user.userId }],
          requestedBy: user.userId,
        },
        select: { id: true, status: true, revision: true, createdAt: true },
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      const concurrent = await prisma.reamonInvestigationCase.findUnique({
        where: { taskId },
        select: { id: true, status: true, revision: true },
      })
      if (!concurrent) throw error
      return NextResponse.json({ investigation: concurrent, alreadyQueued: true }, { headers: NO_STORE })
    }
    return NextResponse.json({ investigation, alreadyQueued: false }, { status: 201, headers: NO_STORE })
  } catch (error) {
    console.error('Failed to queue REAmon investigation:', error)
    return NextResponse.json({ error: 'Failed to queue investigation' }, { status: 500, headers: NO_STORE })
  }
}
