import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { parseReaEvidenceBundle, ReaEvidenceBundleError } from '@/lib/reamon/reaEvidenceBundle'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024
const MAX_MULTIPART_BYTES = MAX_BUNDLE_BYTES + 64 * 1024

async function readBoundedBody(request: Request): Promise<ArrayBuffer> {
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) throw new RangeError('REA Evidence bundle exceeds the 8 MiB upload limit')
  if (!request.body) throw new Error('Request body is empty')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_MULTIPART_BYTES) {
      void reader.cancel().catch(() => {})
      throw new RangeError('REA Evidence bundle exceeds the 8 MiB upload limit')
    }
    chunks.push(value)
  }
  const body = new ArrayBuffer(total)
  const view = new Uint8Array(body)
  let offset = 0
  for (const chunk of chunks) { view.set(chunk, offset); offset += chunk.byteLength }
  return body
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    let boundedRequest: Request
    try {
      const headers = new Headers(request.headers)
      headers.delete('content-length')
      boundedRequest = new Request(request.url, { method: 'POST', headers, body: await readBoundedBody(request) })
    } catch (error) {
      if (error instanceof RangeError) return NextResponse.json({ error: error.message }, { status: 413, headers: { 'Cache-Control': 'no-store' } })
      return NextResponse.json({ error: 'Unable to read the uploaded bundle' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    let form: FormData
    try { form = await boundedRequest.formData() } catch {
      return NextResponse.json({ error: 'Upload must use multipart form data with one bundle file' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'Choose a REA Evidence bundle JSON file' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    if (file.size > MAX_BUNDLE_BYTES) return NextResponse.json({ error: 'REA Evidence bundle exceeds the 8 MiB limit' }, { status: 413, headers: { 'Cache-Control': 'no-store' } })

    let decoded: unknown
    try { decoded = JSON.parse(await file.text()) } catch {
      return NextResponse.json({ error: 'The selected file is not valid JSON' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const validated = parseReaEvidenceBundle(decoded)
    const digests = [...new Set(validated.records.flatMap((record) => record.subject ? [record.subject.digest.sha256] : []))]
    const artifacts = digests.length ? await prisma.artifact.findMany({
      where: { projectId, sha256: { in: digests } },
      select: { id: true, sha256: true, targetId: true },
    }) : []
    const artifactMatches = new Map<string, typeof artifacts>()
    for (const artifact of artifacts) artifactMatches.set(artifact.sha256, [...(artifactMatches.get(artifact.sha256) ?? []), artifact])

    const summary = { records: validated.records.length, bound: 0, unbound: 0, ambiguous: 0 }
    await prisma.$transaction(async (tx) => {
      for (const record of validated.records) {
        const digest = record.subject?.digest.sha256
        const matches = digest ? artifactMatches.get(digest) ?? [] : []
        const linkedArtifact = matches.length === 1 ? matches[0] : null
        const bindingStatus = !digest ? 'no-subject-digest' : matches.length === 0 ? 'no-project-hash-match' : matches.length > 1 ? 'ambiguous-project-hash-match' : 'exact-sha256-match'
        if (linkedArtifact) summary.bound++
        else if (matches.length > 1) summary.ambiguous++
        else summary.unbound++
        const summaryText = `${record.provider.name}: ${record.operation} · ${record.predicate_type} · ${record.confidence}/${record.authority}`.slice(0, 500)
        await tx.evidence.upsert({
          where: { projectId_source_sourceReference: { projectId, source: 'rea-evidence-v2', sourceReference: record.evidence_id } },
          create: {
            projectId,
            targetId: linkedArtifact?.targetId ?? null,
            artifactId: linkedArtifact?.id ?? null,
            kind: 'rea-evidence',
            summary: summaryText,
            source: 'rea-evidence-v2',
            sourceReference: record.evidence_id,
            data: { format: 'REA Evidence v2', bundleDigest: validated.bundleDigest, bindingStatus, record } as unknown as Prisma.InputJsonValue,
          },
          update: {
            targetId: linkedArtifact?.targetId ?? null,
            artifactId: linkedArtifact?.id ?? null,
            summary: summaryText,
            data: { format: 'REA Evidence v2', bundleDigest: validated.bundleDigest, bindingStatus, record } as unknown as Prisma.InputJsonValue,
          },
        })
      }
      await tx.workspaceActivity.create({
        data: {
          projectId,
          actor: 'REA Evidence importer',
          eventType: 'evidence.imported',
          message: `Imported ${summary.records.toLocaleString()} REA Evidence records (${summary.bound.toLocaleString()} bound by exact SHA-256)`,
          data: { ...summary, bundleDigest: validated.bundleDigest },
        },
      })
    }, { timeout: 30_000 })

    return NextResponse.json({ ...summary, bundleDigest: validated.bundleDigest }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof ReaEvidenceBundleError) return NextResponse.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    console.error('Failed to import REA Evidence bundle:', error)
    return NextResponse.json({ error: 'Failed to import REA Evidence bundle' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
