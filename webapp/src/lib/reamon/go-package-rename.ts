import { createHash } from 'node:crypto'

export const MAX_GO_PACKAGE_RENAME_FILES = 256
export const MAX_GO_PACKAGE_RENAME_FILE_BYTES = 512 * 1024
export const MAX_GO_PACKAGE_RENAME_BYTES = 8 * 1024 * 1024

export interface GoPackageRenameUnit {
  unitId: string
  unitName: string
  relativePath: string
}

export interface GoPackageAcceptedSource {
  codeUnitId: string
  relativePath: string
  sourceCode: string
  sourceHash: string | null
  acceptedReviewId: string | null
}

export interface GoPackageReviewReceipt {
  id: string
  codeUnitId: string
  maintainedSourceHash: string
  decision: string
}

export interface GoPackageRenameFile {
  codeUnitId: string
  unitName: string
  relativePath: string
  sourceCode: string
  sourceHash: string
  acceptedReviewId: string | null
  artifactSourceSha256?: string
}

export class GoPackageRenameSnapshotError extends Error {
  status: number

  constructor(message: string, status = 409) {
    super(message)
    this.status = status
  }
}

export function isSafeGoPackagePath(value: string): boolean {
  return Boolean(value && value.length <= 200 && /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.go$/.test(value)
    && !value.includes('\\') && !value.startsWith('/')
    && value.split('/').every((part) => part && part !== '.' && part !== '..'))
}

function goDirectory(value: string): string {
  const separator = value.lastIndexOf('/')
  return separator < 0 ? '' : value.slice(0, separator)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Build a complete, review-bound source set for one Go package. The selected
 * file is the operator's current editor contents; every sibling must match an
 * accepted maintained-source record and its immutable ACCEPTED review receipt.
 */
export function buildGoPackageRenameSnapshot(input: {
  selectedUnitId: string
  selectedPath: string
  selectedSource: string
  units: GoPackageRenameUnit[]
  acceptedSources: GoPackageAcceptedSource[]
  reviews: GoPackageReviewReceipt[]
}): GoPackageRenameFile[] {
  if (!isSafeGoPackagePath(input.selectedPath)) {
    throw new GoPackageRenameSnapshotError('Selected Go package path is invalid.')
  }
  const selectedDirectory = goDirectory(input.selectedPath)
  const units = input.units.filter((unit) => isSafeGoPackagePath(unit.relativePath)
    && goDirectory(unit.relativePath) === selectedDirectory)
  if (!units.some((unit) => unit.unitId === input.selectedUnitId && unit.relativePath === input.selectedPath)) {
    throw new GoPackageRenameSnapshotError('Selected Go unit is not part of the package snapshot.')
  }
  if (units.length < 2) {
    throw new GoPackageRenameSnapshotError('Cross-file Go rename requires at least two source files in the package.')
  }
  if (units.length > MAX_GO_PACKAGE_RENAME_FILES) {
    throw new GoPackageRenameSnapshotError(`Go package rename is limited to ${MAX_GO_PACKAGE_RENAME_FILES} files.`, 413)
  }

  const acceptedByUnit = new Map<string, GoPackageAcceptedSource>()
  for (const source of input.acceptedSources) {
    if (acceptedByUnit.has(source.codeUnitId)) {
      throw new GoPackageRenameSnapshotError('Accepted Go package sources contain duplicate code units.')
    }
    acceptedByUnit.set(source.codeUnitId, source)
  }
  const reviewsById = new Map(input.reviews.map((review) => [review.id, review]))
  const paths = new Set<string>()
  const files: GoPackageRenameFile[] = []
  let totalBytes = 0

  for (const unit of units) {
    const key = unit.relativePath.toLowerCase()
    if (paths.has(key)) throw new GoPackageRenameSnapshotError('Go package files have colliding paths.')
    paths.add(key)

    const accepted = acceptedByUnit.get(unit.unitId)
    let sourceCode: string
    let acceptedReviewId: string | null
    if (unit.unitId === input.selectedUnitId) {
      sourceCode = input.selectedSource
      acceptedReviewId = accepted?.acceptedReviewId ?? null
    } else {
      const review = accepted?.acceptedReviewId ? reviewsById.get(accepted.acceptedReviewId) : undefined
      const sourceHash = accepted ? sha256(accepted.sourceCode) : ''
      if (!accepted || accepted.relativePath !== unit.relativePath || !accepted.sourceHash
          || accepted.sourceHash.toLowerCase() !== sourceHash || !review
          || review.decision !== 'ACCEPTED' || review.codeUnitId !== unit.unitId
          || review.maintainedSourceHash.toLowerCase() !== sourceHash) {
        throw new GoPackageRenameSnapshotError(`Sibling Go source ${unit.relativePath} is not backed by a current accepted review receipt.`)
      }
      sourceCode = accepted.sourceCode
      acceptedReviewId = review.id
    }

    const sourceHash = sha256(sourceCode)
    const sourceBytes = Buffer.byteLength(sourceCode, 'utf8')
    if (sourceBytes > MAX_GO_PACKAGE_RENAME_FILE_BYTES) {
      throw new GoPackageRenameSnapshotError(`${unit.relativePath} exceeds the 512 KiB package-rename limit.`, 413)
    }
    totalBytes += sourceBytes
    if (totalBytes > MAX_GO_PACKAGE_RENAME_BYTES) {
      throw new GoPackageRenameSnapshotError('Go package source exceeds the 8 MiB package-rename limit.', 413)
    }
    files.push({
      codeUnitId: unit.unitId,
      unitName: unit.unitName,
      relativePath: unit.relativePath,
      sourceCode,
      sourceHash,
      acceptedReviewId,
    })
  }

  return files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
}
