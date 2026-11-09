/** Shared bounded reads for durable, project-scoped REAmon evidence records. */
import { createHash } from 'node:crypto'
import prisma from '@/lib/prisma'
import { signWorkspaceCursorPayload, verifyWorkspaceCursorPayload } from './workspaceCursorSigning'

export const WORKSPACE_EVIDENCE_DEFAULT_LIMIT = 25
export const WORKSPACE_EVIDENCE_MAX_LIMIT = 50
export const WORKSPACE_EVIDENCE_PAGE_BYTES = 128 * 1024
export const WORKSPACE_EVIDENCE_MAX_DETAIL_BYTES = 32 * 1024 * 1024

export type WorkspaceEvidenceErrorCode = 'invalid_input' | 'not_found' | 'stale_evidence' | 'stale_snapshot' | 'cursor_unavailable' | 'too_large'

export class WorkspaceEvidenceError extends Error {
  constructor(message: string, public code: WorkspaceEvidenceErrorCode) {
    super(message)
    this.name = 'WorkspaceEvidenceError'
  }
}

export interface WorkspaceListEvidenceArgs {
  projectId: string
  artifactId?: string
  limit?: number
  cursor?: string
}

export interface WorkspaceGetEvidenceArgs {
  projectId: string
  evidenceId: string
  offsetBytes?: number
  evidenceHash?: string
}

type EvidenceCursor = {
  version: 1
  projectId: string
  artifactId: string | null
  snapshotAt: string
  snapshotTotal: number
  expiresAt: number
  createdAt: string
  id: string
}

const EVIDENCE_CURSOR_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_EVIDENCE_CURSOR_LENGTH = 512

function encodeCursor(value: EvidenceCursor) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
  const signature = signWorkspaceCursorPayload(payload)
  if (!signature) throw new WorkspaceEvidenceError('Stable evidence paging is unavailable because cursor signing is not configured.', 'cursor_unavailable')
  return `${payload}.${signature}`
}

function decodeCursor(value: string, projectId: string, artifactId: string | undefined): EvidenceCursor {
  if (value.length > MAX_EVIDENCE_CURSOR_LENGTH || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new WorkspaceEvidenceError('Invalid evidence cursor.', 'invalid_input')
  }
  try {
    const [payload, suppliedSignature, ...extra] = value.split('.')
    if (extra.length || !payload || !suppliedSignature) {
      throw new WorkspaceEvidenceError('This evidence cursor predates signed paging. Restart without a cursor.', 'stale_snapshot')
    }
    const signatureValid = verifyWorkspaceCursorPayload(payload, suppliedSignature)
    if (signatureValid === null) {
      throw new WorkspaceEvidenceError('Stable evidence paging is unavailable because cursor signing is not configured.', 'cursor_unavailable')
    }
    if (!signatureValid) {
      throw new WorkspaceEvidenceError('Evidence cursor integrity check failed. Restart without a cursor.', 'stale_snapshot')
    }
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<EvidenceCursor>
    if (parsed.version !== 1 || parsed.projectId !== projectId || parsed.artifactId !== (artifactId || null)
      || typeof parsed.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.id)
      || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.snapshotAt !== 'string' || !Number.isFinite(Date.parse(parsed.snapshotAt))
      || !Number.isSafeInteger(parsed.snapshotTotal) || (parsed.snapshotTotal as number) < 0
      || !Number.isSafeInteger(parsed.expiresAt)) {
      throw new Error('cursor fields do not match')
    }
    if ((parsed.expiresAt as number) <= Date.now()) {
      throw new WorkspaceEvidenceError('Evidence cursor expired. Restart without a cursor.', 'stale_snapshot')
    }
    return parsed as EvidenceCursor
  } catch (error) {
    if (error instanceof WorkspaceEvidenceError) throw error
    throw new WorkspaceEvidenceError('Invalid or mismatched evidence cursor.', 'invalid_input')
  }
}

function pageUtf8(bytes: Buffer, offsetBytes: number) {
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > bytes.length) {
    throw new WorkspaceEvidenceError('offsetBytes must point within the evidence details.', 'invalid_input')
  }
  if (offsetBytes < bytes.length && (bytes[offsetBytes] & 0xc0) === 0x80) {
    throw new WorkspaceEvidenceError('offsetBytes must be a UTF-8 page boundary returned by the previous response.', 'invalid_input')
  }

  let end = Math.min(bytes.length, offsetBytes + WORKSPACE_EVIDENCE_PAGE_BYTES)
  if (end < bytes.length) {
    let lead = end - 1
    while (lead >= offsetBytes && (bytes[lead] & 0xc0) === 0x80) lead -= 1
    if (lead >= offsetBytes) {
      const first = bytes[lead]
      const sequenceLength = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc2 ? 2 : 1
      if (end - lead < sequenceLength) end = lead
    }
  }
  const page = bytes.subarray(offsetBytes, end)
  return { detailsJson: page.toString('utf8'), offsetBytes, nextOffsetBytes: end, hasMore: end < bytes.length }
}

export async function listPersistedWorkspaceEvidence(args: WorkspaceListEvidenceArgs) {
  if (args.artifactId && args.artifactId.length > 64) throw new WorkspaceEvidenceError('Invalid artifact id.', 'invalid_input')
  if (args.cursor && args.cursor.length > MAX_EVIDENCE_CURSOR_LENGTH) throw new WorkspaceEvidenceError('Invalid evidence cursor.', 'invalid_input')
  if (args.limit != null && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > WORKSPACE_EVIDENCE_MAX_LIMIT)) {
    throw new WorkspaceEvidenceError(`limit must be an integer between 1 and ${WORKSPACE_EVIDENCE_MAX_LIMIT}.`, 'invalid_input')
  }
  const limit = args.limit ?? WORKSPACE_EVIDENCE_DEFAULT_LIMIT
  const baseWhere = { projectId: args.projectId, ...(args.artifactId ? { artifactId: args.artifactId } : {}) }
  const cursor = args.cursor ? decodeCursor(args.cursor, args.projectId, args.artifactId) : null
  const snapshotAt = cursor ? new Date(cursor.snapshotAt) : new Date()
  const snapshotWhere = { ...baseWhere, createdAt: { lte: snapshotAt } }
  if (cursor) {
    const [snapshotTotal, anchor] = await Promise.all([
      prisma.evidence.count({ where: snapshotWhere }),
      prisma.evidence.findFirst({
        where: { ...snapshotWhere, id: cursor.id },
        select: { id: true, createdAt: true },
      }),
    ])
    if (snapshotTotal !== cursor.snapshotTotal || !anchor || anchor.createdAt.toISOString() !== cursor.createdAt) {
      throw new WorkspaceEvidenceError('Evidence changed while paging. Restart with cursor omitted.', 'stale_snapshot')
    }
  }
  const where = cursor
    ? {
        ...snapshotWhere,
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      }
    : snapshotWhere
  const [rows, total] = await Promise.all([
    prisma.evidence.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, targetId: true, artifactId: true, kind: true, summary: true, source: true, createdAt: true },
    }),
    cursor ? Promise.resolve(cursor.snapshotTotal) : prisma.evidence.count({ where: snapshotWhere }),
  ])
  const hasMore = rows.length > limit
  const visible = rows.slice(0, limit)
  const last = visible.at(-1)
  const nextCursor = hasMore && last
    ? encodeCursor({
        version: 1,
        projectId: args.projectId,
        artifactId: args.artifactId || null,
        snapshotAt: snapshotAt.toISOString(),
        snapshotTotal: cursor?.snapshotTotal ?? total,
        expiresAt: cursor?.expiresAt ?? Date.now() + EVIDENCE_CURSOR_TTL_MS,
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      })
    : null

  return {
    projectId: args.projectId,
    artifactId: args.artifactId || null,
    evidence: visible.map((row) => ({
      id: row.id,
      targetId: row.targetId,
      artifactId: row.artifactId,
      kind: row.kind,
      summary: row.summary.slice(0, 500),
      summaryTruncated: row.summary.length > 500,
      source: row.source.slice(0, 120),
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    limit,
    hasMore,
    nextCursor,
    semantics: 'Persisted project evidence, ordered newest first. Use the detail endpoint or workspace_get_evidence for complete hash-checked details; new evidence does not shift an existing cursor page.',
  }
}

export async function readPersistedWorkspaceEvidence(args: WorkspaceGetEvidenceArgs) {
  if (!args.evidenceId || args.evidenceId.length > 64) throw new WorkspaceEvidenceError('Invalid evidence id.', 'invalid_input')
  const offsetBytes = args.offsetBytes ?? 0
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > WORKSPACE_EVIDENCE_MAX_DETAIL_BYTES) {
    throw new WorkspaceEvidenceError('offsetBytes must be a non-negative byte offset no greater than 32 MiB.', 'invalid_input')
  }
  if (offsetBytes > 0 && !args.evidenceHash) {
    throw new WorkspaceEvidenceError('Pass evidenceHash from the first page when continuing evidence details.', 'invalid_input')
  }
  if (args.evidenceHash && !/^[a-f0-9]{64}$/.test(args.evidenceHash)) {
    throw new WorkspaceEvidenceError('evidenceHash must be a 64-character lowercase SHA-256 digest.', 'invalid_input')
  }

  const row = await prisma.evidence.findFirst({
    where: { id: args.evidenceId, projectId: args.projectId },
    select: { id: true, targetId: true, artifactId: true, kind: true, summary: true, source: true, sourceReference: true, createdAt: true, data: true },
  })
  if (!row) throw new WorkspaceEvidenceError('Evidence record not found in this project.', 'not_found')
  if (row.summary.length > WORKSPACE_EVIDENCE_MAX_DETAIL_BYTES) throw new WorkspaceEvidenceError('Evidence details exceed the 32 MiB retrieval limit.', 'too_large')
  const serialized = JSON.stringify({ summary: row.summary, data: row.data })
  if (serialized.length > WORKSPACE_EVIDENCE_MAX_DETAIL_BYTES || Buffer.byteLength(serialized, 'utf8') > WORKSPACE_EVIDENCE_MAX_DETAIL_BYTES) {
    throw new WorkspaceEvidenceError('Evidence details exceed the 32 MiB retrieval limit.', 'too_large')
  }
  const bytes = Buffer.from(serialized, 'utf8')
  const evidenceHash = createHash('sha256').update(bytes).digest('hex')
  if (args.evidenceHash && args.evidenceHash !== evidenceHash) {
    throw new WorkspaceEvidenceError('Evidence changed while paging. Restart at offsetBytes 0 without evidenceHash.', 'stale_evidence')
  }
  if (offsetBytes > bytes.length) throw new WorkspaceEvidenceError('offsetBytes is past the end of this evidence record.', 'invalid_input')
  const page = pageUtf8(bytes, offsetBytes)
  return {
    projectId: args.projectId,
    evidence: {
      id: row.id,
      targetId: row.targetId,
      artifactId: row.artifactId,
      kind: row.kind,
      source: row.source,
      sourceReference: row.sourceReference,
      createdAt: row.createdAt.toISOString(),
    },
    evidenceHash,
    totalBytes: bytes.length,
    ...page,
    semantics: 'detailsJson is a UTF-8 byte page of the exact persisted JSON object {summary, data}. Append pages in order and parse the complete JSON only when hasMore is false.',
  }
}
