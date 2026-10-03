import { Prisma } from '@prisma/client'

export const MAX_PROVENANCE_INPUTS = 32
export const PROVENANCE_RELATION = 'DERIVED_FROM'
const MAX_ARTIFACT_ID_LENGTH = 128

export type ProvenanceSourceArtifact = {
  id: string
  relativePath: string
  sha256: string
}

function boundedId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= MAX_ARTIFACT_ID_LENGTH ? normalized : null
}

/** Parse the JSON form field used by multipart uploads, with strict bounds. */
export function parseProvenanceArtifactIds(value: FormDataEntryValue | null): string[] {
  if (value === null || value === '') return []
  if (typeof value !== 'string') throw new Error('sourceArtifactIds must be a JSON array')

  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new Error('sourceArtifactIds must be valid JSON')
  }
  if (!Array.isArray(decoded)) throw new Error('sourceArtifactIds must be an array')
  if (decoded.length > MAX_PROVENANCE_INPUTS) throw new Error(`A derived artifact can have at most ${MAX_PROVENANCE_INPUTS} source artifacts`)

  const ids: string[] = []
  const seen = new Set<string>()
  for (const candidate of decoded) {
    const id = boundedId(candidate)
    if (!id) throw new Error('sourceArtifactIds must contain non-empty artifact IDs')
    if (seen.has(id)) throw new Error('sourceArtifactIds must not contain duplicates')
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function parseProvenanceTaskId(value: FormDataEntryValue | null): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new Error('sourceTaskId must be an artifact task ID')
  const id = boundedId(value)
  if (!id) throw new Error('sourceTaskId must be a non-empty task ID')
  return id
}

export function buildProvenanceKey(outputArtifactId: string, sourceArtifactId: string, taskId: string | null): string {
  return `${outputArtifactId}:${sourceArtifactId}:${taskId || '-'}:${PROVENANCE_RELATION}`
}

export async function recordArtifactProvenance(
  tx: Prisma.TransactionClient,
  input: {
    projectId: string
    artifactId: string
    sourceArtifacts: ProvenanceSourceArtifact[]
    taskId: string | null
  },
): Promise<void> {
  if (input.sourceArtifacts.length > MAX_PROVENANCE_INPUTS) {
    throw new Error(`A derived artifact can have at most ${MAX_PROVENANCE_INPUTS} source artifacts`)
  }
  const seen = new Set<string>()
  for (const source of input.sourceArtifacts) {
    if (!source.id || source.id === input.artifactId || seen.has(source.id)) {
      throw new Error('Derived artifact provenance contains an invalid source artifact')
    }
    seen.add(source.id)
    const provenanceKey = buildProvenanceKey(input.artifactId, source.id, input.taskId)
    await tx.artifactProvenance.upsert({
      where: { provenanceKey },
      create: {
        projectId: input.projectId,
        artifactId: input.artifactId,
        sourceArtifactId: source.id,
        taskId: input.taskId,
        relation: PROVENANCE_RELATION,
        provenanceKey,
        metadata: {
          sourceRelativePath: source.relativePath.slice(0, 512),
          sourceSha256: source.sha256.slice(0, 128),
        } satisfies Prisma.InputJsonValue,
      },
      update: {},
    })
  }
}
