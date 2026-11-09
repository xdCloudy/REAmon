/** Shared bounded reads for durable, project-scoped REAmon evidence records. */
import { createHash } from 'node:crypto'
import prisma from '@/lib/prisma'

export const WORKSPACE_EVIDENCE_DEFAULT_LIMIT = 25
export const WORKSPACE_EVIDENCE_MAX_LIMIT = 50
export const WORKSPACE_EVIDENCE_PAGE_BYTES = 128 * 1024
export const WORKSPACE_EVIDENCE_MAX_DETAIL_BYTES = 32 * 1024 * 1024

export type WorkspaceEvidenceErrorCode = 'invalid_input' | 'not_found' | 'stale_evidence' | 'too_large'

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
  projectId: string
  artifactId: string | null
  createdAt: string
  id: string
}

function encodeCursor(value: EvidenceCursor) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeCursor(value: string, projectId: string, artifactId: string | undefined): EvidenceCursor {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WorkspaceEvidenceError('Invalid evidence cursor.', 'invalid_input')
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<EvidenceCursor>
    if (parsed.projectId !== projectId || parsed.artifactId !== (artifactId || null)
      || typeof parsed.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.id)
      || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) {
      throw new Error('cursor fields do not match')
    }
    return parsed as EvidenceCursor
  } catch {
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
  if (args.cursor && args.cursor.length > 512) throw new WorkspaceEvidenceError('Invalid evidence cursor.', 'invalid_input')
  if (args.limit != null && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > WORKSPACE_EVIDENCE_MAX_LIMIT)) {
    throw new WorkspaceEvidenceError(`limit must be an integer between 1 and ${WORKSPACE_EVIDENCE_MAX_LIMIT}.`, 'invalid_input')
  }
  const limit = args.limit ?? WORKSPACE_EVIDENCE_DEFAULT_LIMIT
  const baseWhere = { projectId: args.projectId, ...(args.artifactId ? { artifactId: args.artifactId } : {}) }
  const cursor = args.cursor ? decodeCursor(args.cursor, args.projectId, args.artifactId) : null
  const where = cursor
    ? {
        ...baseWhere,
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      }
    : baseWhere
  const [rows, total] = await Promise.all([
    prisma.evidence.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, targetId: true, artifactId: true, kind: true, summary: true, source: true, createdAt: true },
    }),
    prisma.evidence.count({ where: baseWhere }),
  ])
  const hasMore = rows.length > limit
  const visible = rows.slice(0, limit)
  const last = visible.at(-1)
  const nextCursor = hasMore && last
    ? encodeCursor({ projectId: args.projectId, artifactId: args.artifactId || null, createdAt: last.createdAt.toISOString(), id: last.id })
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
