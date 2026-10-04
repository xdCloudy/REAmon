export const CODE_UNIT_OBSERVATION_TYPE = 'code_unit'
export const CODE_UNIT_QUERY_LIMIT = 5000

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
    codeArtifactId: text(attributes.codeArtifactId, 128),
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

export interface CodeUnitRect {
  unit: CodeUnit
  x: number
  y: number
  width: number
  height: number
}

export function layoutCodeUnitTreemap(units: CodeUnit[], width: number, height: number): CodeUnitRect[] {
  if (!units.length || width <= 0 || height <= 0) return []
  const sorted = [...units].sort((left, right) => right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name))
  const rectangles: CodeUnitRect[] = []

  function place(items: CodeUnit[], x: number, y: number, w: number, h: number): void {
    if (!items.length || w <= 0 || h <= 0) return
    if (items.length === 1) {
      rectangles.push({ unit: items[0], x, y, width: w, height: h })
      return
    }

    const total = items.reduce((sum, item) => sum + item.sizeBytes, 0)
    let splitAt = 1
    let accumulated = items[0].sizeBytes
    while (splitAt < items.length - 1 && accumulated < total / 2) {
      accumulated += items[splitAt].sizeBytes
      splitAt += 1
    }
    const ratio = accumulated / total
    if (w >= h) {
      const firstWidth = w * ratio
      place(items.slice(0, splitAt), x, y, firstWidth, h)
      place(items.slice(splitAt), x + firstWidth, y, w - firstWidth, h)
    } else {
      const firstHeight = h * ratio
      place(items.slice(0, splitAt), x, y, w, firstHeight)
      place(items.slice(splitAt), x, y + firstHeight, w, h - firstHeight)
    }
  }

  place(sorted, 0, 0, width, height)
  return rectangles
}

export function summarizeCodeUnits(units: CodeUnit[]) {
  const totalBytes = units.reduce((sum, unit) => sum + unit.sizeBytes, 0)
  const measuredUnits = units.filter((unit) => unit.coveragePercent !== null)
  const measuredBytes = measuredUnits.reduce((sum, unit) => sum + unit.sizeBytes, 0)
  const decompiledBytes = measuredUnits.reduce((sum, unit) => sum + unit.sizeBytes * ((unit.coveragePercent || 0) / 100), 0)
  return {
    totalBytes,
    measuredBytes,
    unmeasuredBytes: totalBytes - measuredBytes,
    coveragePercent: measuredBytes ? Math.round((decompiledBytes / measuredBytes) * 100) : null,
    decompiledUnits: units.filter((unit) => unit.coveragePercent === 100).length,
  }
}
