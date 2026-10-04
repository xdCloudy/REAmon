export const CODE_UNIT_OBSERVATION_TYPE = 'code_unit'
export const MAINTAINED_SOURCE_OBSERVATION_TYPE = 'maintained_source'
export const MAINTAINED_SOURCE_OBSERVATION_SOURCE = 'reamon-maintained-source'
export const CODE_UNIT_QUERY_LIMIT = 1000

export interface CodeUnitObservationAttributes {
  unitType: string
  name?: string
  qualifiedName?: string
  address?: string
  startAddress?: string
  sizeBytes: number
  decompilationPercent?: number
  coveragePercent?: number
  decompiledBytes?: number
  decompiled?: boolean
  language?: string
  codeArtifactId?: string
  disassemblyArtifactId?: string
  disassemblyLanguage?: string
}

export interface CodeUnitObservationRow {
  id: string
  stableKey: string
  label: string | null
  source: string
  artifactId: string | null
  updatedAt: Date | string
  attributes: unknown
  artifact?: { relativePath: string; originalName: string } | null
}

export interface CodeUnit {
  id: string
  name: string
  address: string | null
  sizeBytes: number
  coveragePercent: number | null
  language: string | null
  unitType: string | null
  artifactId: string | null
  artifactPath: string | null
  source: string
  codeArtifactId: string | null
  disassemblyArtifactId: string | null
  disassemblyLanguage: string | null
  maintainedSource?: boolean
  updatedAt: string
}

function attributesOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalised = value.trim()
  return normalised ? normalised.slice(0, maxLength) : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function coverageOf(attributes: Record<string, unknown>): number | null {
  const explicitPercent = finiteNumber(attributes.decompilationPercent ?? attributes.coveragePercent)
  if (explicitPercent !== null) return Math.max(0, Math.min(100, explicitPercent))

  const sizeBytes = finiteNumber(attributes.sizeBytes)
  const decompiledBytes = finiteNumber(attributes.decompiledBytes)
  if (sizeBytes !== null && sizeBytes > 0 && decompiledBytes !== null) {
    return Math.max(0, Math.min(100, (decompiledBytes / sizeBytes) * 100))
  }
  return attributes.decompiled === true ? 100 : null
}

export function normalizeCodeUnit(row: CodeUnitObservationRow): CodeUnit | null {
  const attributes = attributesOf(row.attributes)
  const sizeBytes = finiteNumber(attributes.sizeBytes)
  if (sizeBytes === null || sizeBytes <= 0 || sizeBytes > Number.MAX_SAFE_INTEGER) return null

  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
  const artifactPath = row.artifact?.relativePath || row.artifact?.originalName || null
  return {
    id: row.id,
    name: text(attributes.qualifiedName, 500) || text(attributes.name, 500) || text(row.label, 500) || text(row.stableKey, 500) || row.id,
    address: text(attributes.address ?? attributes.startAddress, 128),
    sizeBytes: Math.floor(sizeBytes),
    coveragePercent: coverageOf(attributes),
    language: text(attributes.language, 80),
    unitType: text(attributes.unitType, 80),
    artifactId: row.artifactId,
    artifactPath,
    source: row.source.slice(0, 120),
    codeArtifactId: text(attributes.codeArtifactId, 2000),
    disassemblyArtifactId: text(attributes.disassemblyArtifactId, 2000),
    disassemblyLanguage: text(attributes.disassemblyLanguage, 80),
    maintainedSource: false,
    updatedAt,
  }
}

export interface CodeUnitFilter {
  text: string
  minimumBytes?: number
  maximumCoverage?: number
}

function parseSize(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?)(b|kb|mb)?$/i)
  if (!match) return null
  const amount = Number(match[1])
  const unit = (match[2] || 'b').toLowerCase()
  const multiplier = unit === 'mb' ? 1024 * 1024 : unit === 'kb' ? 1024 : 1
  return amount * multiplier
}

export function parseCodeUnitFilter(query: string): CodeUnitFilter {
  const remaining: string[] = []
  const result: CodeUnitFilter = { text: '' }
  for (const token of query.trim().split(/\s+/).filter(Boolean)) {
    const size = token.match(/^>(\d+(?:\.\d+)?(?:b|kb|mb)?)$/i)
    const coverage = token.match(/^<(\d+(?:\.\d+)?)%$/)
    if (size) {
      const bytes = parseSize(size[1])
      if (bytes !== null) result.minimumBytes = bytes
      else remaining.push(token)
    } else if (coverage) {
      result.maximumCoverage = Math.max(0, Math.min(100, Number(coverage[1])))
    } else {
      remaining.push(token)
    }
  }
  result.text = remaining.join(' ').toLocaleLowerCase()
  return result
}

export function filterCodeUnits(units: CodeUnit[], query: string): CodeUnit[] {
  const filter = parseCodeUnitFilter(query)
  return units.filter((unit) => {
    if (filter.minimumBytes !== undefined && unit.sizeBytes < filter.minimumBytes) return false
    if (filter.maximumCoverage !== undefined && (unit.coveragePercent === null || unit.coveragePercent >= filter.maximumCoverage)) return false
    if (filter.text) {
      const searchable = `${unit.name} ${unit.address || ''} ${unit.artifactPath || ''} ${unit.language || ''}`.toLocaleLowerCase()
      if (!searchable.includes(filter.text)) return false
    }
    return true
  })
}

export interface CodeUnitRect<T> {
  unit: T
  x: number
  y: number
  width: number
  height: number
}

export interface CodeUnitTreemapEntry {
  key: string
  name: string
  sizeBytes: number
  coveragePercent: number | null
  codeUnit?: CodeUnit
  packagePath?: string
  unitCount: number
  maintainedUnitCount: number
}

function codeUnitPath(unit: CodeUnit): string[] {
  const artifactPath = unit.codeArtifactId?.replace(/\\/g, '/')
  if (artifactPath) {
    const parts = artifactPath.split('/').filter(Boolean)
    const isJvmClass = (unit.language === 'Java' || unit.language === 'Smali') && unit.unitType === 'class'
    const sourceRoot = isJvmClass
      ? Math.max(parts.lastIndexOf('sources'), parts.lastIndexOf('smali'))
      : parts.lastIndexOf('functions')
    if (sourceRoot >= 0) return parts.slice(sourceRoot + 1, -1)
  }

  if ((unit.language === 'Java' || unit.language === 'Smali') && unit.unitType === 'class') {
    const nameParts = unit.name.split('.')
    if (nameParts.length > 1) return nameParts.slice(0, -1)
  }
  return []
}

export function buildCodeUnitTreemapEntries(units: CodeUnit[], packagePath = ''): CodeUnitTreemapEntry[] {
  const selectedPath = packagePath.split('.').filter(Boolean)
  const groups = new Map<string, { sizeBytes: number; weightedCoverage: number; measuredBytes: number; unitCount: number; maintainedUnitCount: number }>()
  const entries: CodeUnitTreemapEntry[] = []

  for (const unit of units) {
    const path = codeUnitPath(unit)
    if (selectedPath.some((part, index) => path[index] !== part)) continue
    if (path.length > selectedPath.length) {
      const segment = path[selectedPath.length]
      const group = groups.get(segment) || { sizeBytes: 0, weightedCoverage: 0, measuredBytes: 0, unitCount: 0, maintainedUnitCount: 0 }
      group.sizeBytes += unit.sizeBytes
      group.unitCount += 1
      if (unit.maintainedSource) group.maintainedUnitCount += 1
      if (unit.coveragePercent !== null) {
        group.weightedCoverage += unit.sizeBytes * unit.coveragePercent
        group.measuredBytes += unit.sizeBytes
      }
      groups.set(segment, group)
      continue
    }
    if (path.length !== selectedPath.length) continue
    entries.push({
      key: `unit:${unit.id}`,
      name: unit.name,
      sizeBytes: unit.sizeBytes,
      coveragePercent: unit.coveragePercent,
      codeUnit: unit,
      unitCount: 1,
      maintainedUnitCount: unit.maintainedSource ? 1 : 0,
    })
  }

  for (const [segment, group] of groups) {
    const childPath = [...selectedPath, segment].join('.')
    entries.push({
      key: `package:${childPath}`,
      name: segment,
      sizeBytes: group.sizeBytes,
      coveragePercent: group.measuredBytes > 0 ? group.weightedCoverage / group.measuredBytes : null,
      packagePath: childPath,
      unitCount: group.unitCount,
      maintainedUnitCount: group.maintainedUnitCount,
    })
  }

  return entries.sort((left, right) => right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name))
}

export function filterCodeUnitsByPackage(units: CodeUnit[], packagePath: string): CodeUnit[] {
  const selectedPath = packagePath.split('.').filter(Boolean)
  if (!selectedPath.length) return units
  return units.filter((unit) => {
    const path = codeUnitPath(unit)
    return selectedPath.every((part, index) => path[index] === part)
  })
}

export function layoutCodeUnitTreemap<T extends { sizeBytes: number; name: string }>(units: T[], width: number, height: number): CodeUnitRect<T>[] {
  if (!units.length || width <= 0 || height <= 0) return []
  const sorted = [...units].sort((left, right) => right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name))
  const totalSize = sorted.reduce((sum, unit) => sum + unit.sizeBytes, 0)
  if (!Number.isFinite(totalSize) || totalSize <= 0) return []
  const rectangles: CodeUnitRect<T>[] = []
  let remainingIndex = 0
  let x = 0, y = 0, remainingWidth = width, remainingHeight = height
  const areaScale = width * height / totalSize

  function worstRowAspect(rowSize: number, smallestSize: number, largestSize: number, shortSide: number): number {
    if (rowSize <= 0 || smallestSize <= 0 || shortSide <= 0) return Number.POSITIVE_INFINITY
    const sideSquared = shortSide * shortSide
    const rowArea = rowSize * areaScale
    const smallestArea = smallestSize * areaScale
    const largestArea = largestSize * areaScale
    return Math.max(sideSquared * largestArea / (rowArea * rowArea), rowArea * rowArea / (sideSquared * smallestArea))
  }

  while (remainingIndex < sorted.length && remainingWidth > 0 && remainingHeight > 0) {
    if (remainingIndex === sorted.length - 1) {
      rectangles.push({ unit: sorted[remainingIndex], x, y, width: remainingWidth, height: remainingHeight })
      break
    }
    const shortSide = Math.min(remainingWidth, remainingHeight)
    const row: T[] = []
    let rowSize = 0, smallestSize = Number.POSITIVE_INFINITY, largestSize = 0
    while (remainingIndex < sorted.length) {
      const candidate = sorted[remainingIndex]
      const nextSize = rowSize + candidate.sizeBytes
      const nextSmallest = Math.min(smallestSize, candidate.sizeBytes)
      const nextLargest = Math.max(largestSize, candidate.sizeBytes)
      if (row.length && worstRowAspect(nextSize, nextSmallest, nextLargest, shortSide) > worstRowAspect(rowSize, smallestSize, largestSize, shortSide)) break
      row.push(candidate)
      rowSize = nextSize
      smallestSize = nextSmallest
      largestSize = nextLargest
      remainingIndex += 1
    }
    if (!row.length) break
    const rowArea = rowSize * areaScale
    if (remainingWidth >= remainingHeight) {
      const stripWidth = Math.min(remainingWidth, rowArea / remainingHeight)
      let cellY = y
      row.forEach((unit, index) => {
        const cellHeight = index === row.length - 1 ? y + remainingHeight - cellY : remainingHeight * (unit.sizeBytes / rowSize)
        rectangles.push({ unit, x, y: cellY, width: stripWidth, height: cellHeight })
        cellY += cellHeight
      })
      x += stripWidth
      remainingWidth -= stripWidth
    } else {
      const stripHeight = Math.min(remainingHeight, rowArea / remainingWidth)
      let cellX = x
      row.forEach((unit, index) => {
        const cellWidth = index === row.length - 1 ? x + remainingWidth - cellX : remainingWidth * (unit.sizeBytes / rowSize)
        rectangles.push({ unit, x: cellX, y, width: cellWidth, height: stripHeight })
        cellX += cellWidth
      })
      y += stripHeight
      remainingHeight -= stripHeight
    }
  }
  return rectangles
}

export function summarizeCodeUnits(units: CodeUnit[]) {
  const totalBytes = units.reduce((sum, unit) => sum + unit.sizeBytes, 0)
  const sourceLinkedUnits = units.filter((unit) => Boolean(unit.artifactId && unit.codeArtifactId)).length
  const measuredUnits = units.filter((unit) => unit.coveragePercent !== null)
  const measuredBytes = measuredUnits.reduce((sum, unit) => sum + unit.sizeBytes, 0)
  const decompiledBytes = measuredUnits.reduce((sum, unit) => sum + unit.sizeBytes * ((unit.coveragePercent || 0) / 100), 0)
  return {
    totalBytes,
    sourceLinkedUnits,
    sourceLinkedPercent: units.length ? Math.round((sourceLinkedUnits / units.length) * 100) : null,
    measuredBytes,
    unmeasuredBytes: totalBytes - measuredBytes,
    coveragePercent: measuredBytes ? Math.round((decompiledBytes / measuredBytes) * 100) : null,
    decompiledUnits: units.filter((unit) => unit.coveragePercent === 100).length,
  }
}
