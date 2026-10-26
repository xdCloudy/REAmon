import { createHash } from 'node:crypto'
import prisma from '@/lib/prisma'
import { CODE_UNIT_OBSERVATION_TYPE } from '@/lib/reamon/code-units'

const MAX_INVENTORY_UNITS = 5000
const MAX_BUILD_FILES = 32
const BUILD_SOURCE = 'reamon-maintained-build'

export interface VerifiedCSharpProjectBuildReceipt {
  version: 'reamon-csharp-project-build-v1'
  taskId: string
  artifactId: string
  sourceSha256: string
  validationStatus: 'PASSED' | 'FAILED'
  validationMethod: string
  validationMessage: string
  compilerVersion: string
  compiledSha256: string | null
  createdAt: string
  files: Array<{
    codeUnitId: string
    acceptedReviewId: string
    relativePath: string
    sourceSha256: string
  }>
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function csharpLanguage(value: unknown): boolean {
  return typeof value === 'string' && ['c#', 'csharp', 'c# source', 'cs'].includes(value.trim().toLowerCase())
}

function safeRelativePath(value: string): string | null {
  if (!value || value.length > 200 || value.includes('\\') || value.startsWith('/')) return null
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  const normalized = parts.map((part) => part.replace(/[^A-Za-z0-9_.-]/g, '_')).join('/')
  return normalized.toLowerCase().endsWith('.cs') ? normalized : null
}

function projectSourceSetHash(files: Array<{ relativePath: string; sourceHash: string }>): string {
  const ordered = [...files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
  const hash = createHash('sha256')
  for (const file of ordered) hash.update(file.relativePath).update('\0').update(file.sourceHash).update('\n')
  return hash.digest('hex')
}

export async function getVerifiedCSharpProjectBuildReceipt(
  projectId: string,
  taskId: string,
  artifactId: string,
): Promise<VerifiedCSharpProjectBuildReceipt | null> {
  const stored = await prisma.reamonObservation.findFirst({
    where: { projectId, taskId, artifactId, source: BUILD_SOURCE, type: 'project_build_receipt' },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: { stableKey: true, attributes: true },
  })
  if (!stored) return null

  const receipt = plainObject(stored.attributes)
  if (receipt.version !== 'reamon-csharp-project-build-v1' || receipt.taskId !== taskId
      || receipt.artifactId !== artifactId || !Array.isArray(receipt.files)
      || receipt.files.length < 1 || receipt.files.length > MAX_BUILD_FILES
      || !['PASSED', 'FAILED'].includes(String(receipt.validationStatus))
      || typeof receipt.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sourceSha256)) return null
  const receiptFiles = receipt.files.map((item) => plainObject(item))
  if (receiptFiles.some((file) => typeof file.codeUnitId !== 'string' || typeof file.acceptedReviewId !== 'string'
      || typeof file.relativePath !== 'string' || safeRelativePath(file.relativePath) !== file.relativePath
      || typeof file.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sourceSha256))) return null
  const receiptUnitIds = receiptFiles.map((file) => file.codeUnitId as string)
  if (new Set(receiptUnitIds).size !== receiptUnitIds.length
      || new Set(receiptFiles.map((file) => String(file.relativePath).toLowerCase())).size !== receiptFiles.length) return null

  const units = await prisma.reamonObservation.findMany({
    where: { projectId, taskId, artifactId, type: CODE_UNIT_OBSERVATION_TYPE },
    take: MAX_INVENTORY_UNITS + 1,
    select: { id: true, attributes: true },
  })
  if (units.length > MAX_INVENTORY_UNITS) return null
  const csharpUnitIds = units.filter((unit) => csharpLanguage(plainObject(unit.attributes).language)).map((unit) => unit.id)
  if (!csharpUnitIds.length || receiptUnitIds.some((unitId) => !csharpUnitIds.includes(unitId))) return null

  const sources = await prisma.reamonMaintainedSource.findMany({
    where: { projectId, artifactId, codeUnitId: { in: csharpUnitIds }, acceptedReviewId: { not: null } },
    orderBy: [{ relativePath: 'asc' }, { codeUnitId: 'asc' }],
    take: MAX_BUILD_FILES + 1,
    select: { codeUnitId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, relativePath: true },
  })
  if (sources.length > MAX_BUILD_FILES || sources.length !== receiptFiles.length) return null
  const sourceUnitIds = sources.map((source) => source.codeUnitId)
  if (new Set(sourceUnitIds).size !== sourceUnitIds.length
      || sourceUnitIds.some((unitId) => !receiptUnitIds.includes(unitId))) return null

  const reviewIds = sources.flatMap((source) => source.acceptedReviewId ? [source.acceptedReviewId] : [])
  const reviews = await prisma.reamonCodeReview.findMany({
    where: { projectId, artifactId, id: { in: reviewIds }, decision: 'ACCEPTED' },
    select: { id: true, codeUnitId: true, maintainedSourceHash: true },
  })
  const unitsById = new Map(units.map((unit) => [unit.id, unit]))
  const sourcesById = new Map(sources.map((source) => [source.codeUnitId, source]))
  const reviewsById = new Map(reviews.map((review) => [review.id, review]))
  const receiptFilesById = new Map(receiptFiles.map((file) => [file.codeUnitId as string, file]))
  for (const file of receiptFiles) {
    const unitId = file.codeUnitId as string
    const reviewId = file.acceptedReviewId as string
    const source = sourcesById.get(unitId)
    const relativePath = source ? safeRelativePath(source.relativePath) : null
    const review = reviewsById.get(reviewId)
    const actualHash = source
      ? createHash('sha256').update(source.sourceCode, 'utf8').digest('hex')
      : ''
    if (!unitsById.has(unitId) || !csharpLanguage(plainObject(unitsById.get(unitId)?.attributes).language)
        || !source || source.acceptedReviewId !== reviewId || relativePath !== file.relativePath
        || !source.sourceHash || source.sourceHash !== file.sourceSha256 || actualHash !== file.sourceSha256
        || !review || review.codeUnitId !== unitId || review.maintainedSourceHash !== file.sourceSha256) return null
  }

  const sourceHash = projectSourceSetHash(sources.map((source) => ({
    relativePath: safeRelativePath(source.relativePath) ?? '',
    sourceHash: source.sourceHash ?? '',
  })))
  const sourceSetMatches = sources.every((source) => {
    const file = receiptFilesById.get(source.codeUnitId)
    return !!file && file.acceptedReviewId === source.acceptedReviewId
      && file.relativePath === safeRelativePath(source.relativePath) && file.sourceSha256 === source.sourceHash
  })
  if (!sourceSetMatches || sourceHash !== receipt.sourceSha256
      || stored.stableKey !== `csharp-build:${taskId}:${sourceHash}`) return null

  const files = receiptFiles.map((file) => ({
    codeUnitId: file.codeUnitId as string,
    acceptedReviewId: file.acceptedReviewId as string,
    relativePath: file.relativePath as string,
    sourceSha256: file.sourceSha256 as string,
  }))
  return {
    version: 'reamon-csharp-project-build-v1',
    taskId,
    artifactId,
    sourceSha256: receipt.sourceSha256,
    validationStatus: receipt.validationStatus as 'PASSED' | 'FAILED',
    validationMethod: typeof receipt.validationMethod === 'string' ? receipt.validationMethod.slice(0, 120) : 'unknown',
    validationMessage: typeof receipt.validationMessage === 'string' ? receipt.validationMessage.slice(0, 2000) : '',
    compilerVersion: typeof receipt.compilerVersion === 'string' ? receipt.compilerVersion.slice(0, 80) : 'unknown',
    compiledSha256: typeof receipt.compiledSha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.compiledSha256)
      ? receipt.compiledSha256 : null,
    createdAt: typeof receipt.createdAt === 'string' && !Number.isNaN(Date.parse(receipt.createdAt))
      ? new Date(receipt.createdAt).toISOString() : '',
    files,
  }
}
