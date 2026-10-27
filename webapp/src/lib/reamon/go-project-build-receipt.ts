import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import prisma from '@/lib/prisma'
import { CODE_UNIT_OBSERVATION_TYPE } from '@/lib/reamon/code-units'
import { resolveArtifactStoragePath } from '@/lib/reamon/artifact-storage'
import type { Prisma } from '@prisma/client'

const MAX_INVENTORY_UNITS = 5000
const MAX_BUILD_FILES = 64
const MAX_DEPENDENCIES = 2
const MAX_MANIFEST_BYTES = 1024 * 1024
const BUILD_SOURCE = 'reamon-maintained-build'

export interface VerifiedGoProjectBuildReceipt {
  version: 'reamon-go-project-build-v1'
  taskId: string
  artifactId: string
  sourceSha256: string
  dependencySha256: string
  validationStatus: 'PASSED' | 'FAILED'
  validationMethod: string
  validationMessage: string
  compilerVersion: string
  compiledSha256: string | null
  packageCount: number
  createdAt: string
  files: Array<{
    codeUnitId: string
    acceptedReviewId: string
    relativePath: string
    buildPath: string
    sourceSha256: string
  }>
  dependencies: Array<{
    artifactId: string
    relativePath: string
    buildPath: 'go.mod' | 'go.sum'
    sourceSha256: string
  }>
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function goLanguage(value: unknown): boolean {
  return typeof value === 'string' && ['go', 'golang', 'go source'].includes(value.trim().toLowerCase())
}

function safePath(value: string, extension: '.go' | '.mod' | '.sum'): boolean {
  return !!value && value.length <= 200 && !value.includes('\\') && !value.startsWith('/')
    && value.split('/').every((part) => part && part !== '.' && part !== '..')
    && /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(value)
    && value.toLowerCase().endsWith(extension)
}

function setHash(files: Array<{ path: string; sourceHash: string }>): string {
  const ordered = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const hash = createHash('sha256')
  for (const file of ordered) hash.update(file.path).update('\0').update(file.sourceHash).update('\n')
  return hash.digest('hex')
}

export async function getVerifiedGoProjectBuildReceipt(
  projectId: string,
  taskId: string,
  artifactId: string,
  artifactWhere: Prisma.ArtifactWhereInput,
): Promise<VerifiedGoProjectBuildReceipt | null> {
  const stored = await prisma.reamonObservation.findFirst({
    where: { projectId, taskId, artifactId, source: BUILD_SOURCE, type: 'project_build_receipt' },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: { stableKey: true, attributes: true },
  })
  if (!stored) return null
  const receipt = plainObject(stored.attributes)
  if (receipt.version !== 'reamon-go-project-build-v1' || receipt.taskId !== taskId || receipt.artifactId !== artifactId
      || !Array.isArray(receipt.files) || receipt.files.length < 1 || receipt.files.length > MAX_BUILD_FILES
      || !Array.isArray(receipt.dependencies) || receipt.dependencies.length > MAX_DEPENDENCIES
      || !['PASSED', 'FAILED'].includes(String(receipt.validationStatus))
      || typeof receipt.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sourceSha256)
      || typeof receipt.dependencySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.dependencySha256)) return null

  const receiptFiles = receipt.files.map((item) => plainObject(item))
  if (receiptFiles.some((file) => typeof file.codeUnitId !== 'string' || typeof file.acceptedReviewId !== 'string'
      || typeof file.relativePath !== 'string' || !safePath(file.relativePath, '.go')
      || typeof file.buildPath !== 'string' || !safePath(file.buildPath, '.go')
      || typeof file.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sourceSha256))) return null
  const receiptDependencies = receipt.dependencies.map((item) => plainObject(item))
  if (receiptDependencies.some((dependency) => typeof dependency.artifactId !== 'string'
      || typeof dependency.relativePath !== 'string' || !['go.mod', 'go.sum'].includes(String(dependency.buildPath))
      || !safePath(dependency.relativePath, dependency.buildPath === 'go.mod' ? '.mod' : '.sum')
      || typeof dependency.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dependency.sourceSha256))) return null

  const fileIds = receiptFiles.map((file) => file.codeUnitId as string)
  const buildPaths = receiptFiles.map((file) => String(file.buildPath).toLowerCase())
  const dependencyPaths = receiptDependencies.map((dependency) => String(dependency.buildPath))
  if (new Set(fileIds).size !== fileIds.length || new Set(buildPaths).size !== buildPaths.length
      || new Set(dependencyPaths).size !== dependencyPaths.length) return null

  const units = await prisma.reamonObservation.findMany({
    where: { projectId, taskId, artifactId, type: CODE_UNIT_OBSERVATION_TYPE },
    take: MAX_INVENTORY_UNITS + 1,
    select: { id: true, attributes: true },
  })
  if (units.length > MAX_INVENTORY_UNITS) return null
  const goUnitIds = units.filter((unit) => goLanguage(plainObject(unit.attributes).language)).map((unit) => unit.id)
  if (!goUnitIds.length || fileIds.some((unitId) => !goUnitIds.includes(unitId))) return null

  const sources = await prisma.reamonMaintainedSource.findMany({
    where: { projectId, artifactId, codeUnitId: { in: goUnitIds }, acceptedReviewId: { not: null } },
    orderBy: [{ relativePath: 'asc' }, { codeUnitId: 'asc' }],
    take: MAX_BUILD_FILES + 1,
    select: { codeUnitId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, relativePath: true },
  })
  if (sources.length > MAX_BUILD_FILES || sources.length !== receiptFiles.length) return null
  if (new Set(sources.map((source) => source.codeUnitId)).size !== sources.length
      || sources.some((source) => !fileIds.includes(source.codeUnitId))) return null
  const reviewIds = sources.flatMap((source) => source.acceptedReviewId ? [source.acceptedReviewId] : [])
  const reviews = await prisma.reamonCodeReview.findMany({
    where: { projectId, artifactId, id: { in: reviewIds }, decision: 'ACCEPTED' },
    select: { id: true, codeUnitId: true, maintainedSourceHash: true },
  })
  const unitsById = new Map(units.map((unit) => [unit.id, unit]))
  const sourcesById = new Map(sources.map((source) => [source.codeUnitId, source]))
  const reviewsById = new Map(reviews.map((review) => [review.id, review]))
  const filesById = new Map(receiptFiles.map((file) => [file.codeUnitId as string, file]))
  for (const file of receiptFiles) {
    const unitId = file.codeUnitId as string
    const reviewId = file.acceptedReviewId as string
    const source = sourcesById.get(unitId)
    const review = reviewsById.get(reviewId)
    const actualHash = source ? createHash('sha256').update(source.sourceCode, 'utf8').digest('hex') : ''
    if (!unitsById.has(unitId) || !goLanguage(plainObject(unitsById.get(unitId)?.attributes).language)
        || !source || source.acceptedReviewId !== reviewId || source.relativePath !== file.relativePath
        || !source.sourceHash || source.sourceHash !== file.sourceSha256 || actualHash !== file.sourceSha256
        || !review || review.codeUnitId !== unitId || review.maintainedSourceHash !== file.sourceSha256) return null
    if (!filesById.has(unitId)) return null
  }

  const sourceHash = setHash(receiptFiles.map((file) => ({
    path: file.buildPath as string,
    sourceHash: file.sourceSha256 as string,
  })))
  if (sourceHash !== receipt.sourceSha256) return null

  let dependencyHash: string
  if (receiptDependencies.length) {
    const artifacts = await prisma.artifact.findMany({
      where: { ...artifactWhere, projectId, id: { in: receiptDependencies.map((dependency) => dependency.artifactId as string) } },
      select: { id: true, relativePath: true, storagePath: true, sha256: true, sizeBytes: true },
    })
    const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
    if (artifacts.length !== receiptDependencies.length) return null
    for (const dependency of receiptDependencies) {
      const artifact = artifactsById.get(dependency.artifactId as string)
      if (!artifact || artifact.relativePath !== dependency.relativePath
          || artifact.sha256.toLowerCase() !== dependency.sourceSha256
          || artifact.sizeBytes < 0n || artifact.sizeBytes > BigInt(MAX_MANIFEST_BYTES)) return null
      try {
        const bytes = await readFile(resolveArtifactStoragePath(artifact.storagePath))
        if (bytes.length !== Number(artifact.sizeBytes)
            || createHash('sha256').update(bytes).digest('hex') !== dependency.sourceSha256) return null
      } catch {
        return null
      }
    }
    dependencyHash = setHash(receiptDependencies.map((dependency) => ({
      path: dependency.buildPath as string,
      sourceHash: dependency.sourceSha256 as string,
    })))
  } else {
    dependencyHash = setHash([])
  }
  if (dependencyHash !== receipt.dependencySha256
      || stored.stableKey !== `go-build:${taskId}:${sourceHash}:${dependencyHash}`) return null

  return {
    version: 'reamon-go-project-build-v1',
    taskId,
    artifactId,
    sourceSha256: sourceHash,
    dependencySha256: dependencyHash,
    validationStatus: receipt.validationStatus as 'PASSED' | 'FAILED',
    validationMethod: typeof receipt.validationMethod === 'string' ? receipt.validationMethod.slice(0, 120) : 'unknown',
    validationMessage: typeof receipt.validationMessage === 'string' ? receipt.validationMessage.slice(0, 2000) : '',
    compilerVersion: typeof receipt.compilerVersion === 'string' ? receipt.compilerVersion.slice(0, 80) : 'unknown',
    compiledSha256: typeof receipt.compiledSha256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.compiledSha256) ? receipt.compiledSha256 : null,
    packageCount: Number.isInteger(receipt.packageCount) ? Number(receipt.packageCount) : 0,
    createdAt: typeof receipt.createdAt === 'string' && !Number.isNaN(Date.parse(receipt.createdAt))
      ? new Date(receipt.createdAt).toISOString() : '',
    files: receiptFiles.map((file) => ({
      codeUnitId: file.codeUnitId as string,
      acceptedReviewId: file.acceptedReviewId as string,
      relativePath: file.relativePath as string,
      buildPath: file.buildPath as string,
      sourceSha256: file.sourceSha256 as string,
    })),
    dependencies: receiptDependencies.map((dependency) => ({
      artifactId: dependency.artifactId as string,
      relativePath: dependency.relativePath as string,
      buildPath: dependency.buildPath as 'go.mod' | 'go.sum',
      sourceSha256: dependency.sourceSha256 as string,
    })),
  }
}
