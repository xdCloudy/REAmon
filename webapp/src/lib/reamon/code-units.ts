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
  sourceLanguage?: string
  representation?: string
  decompiler?: string
  decompilerVersion?: string
  nameEvidence?: string
  symbolSource?: string
  goPackage?: string
  goUnstripSignature?: string | null
  goUnstripSourceFile?: string | null
  goUnstripSourceLine?: number | null
  goUnstripInterfaces?: Array<{
    interfaceName: string
    concreteType: string
    method: string
    itabAddress: string
    concreteFunctionAddress: string
    incomplete: boolean
  }>
  goUnstripInterfacesTruncated?: boolean
  relativePath?: string
  bundlePath?: string
  codeArtifactId?: string
  disassemblyArtifactId?: string
  disassemblyLanguage?: string
  classReferences?: string[]
  referencedStrings?: string[]
  referencedStringsTruncated?: boolean
  importedCalls?: string[]
  fieldReferences?: string[]
  fieldReferencesTruncated?: boolean
  sourceAddressMap?: Array<{ ghidraLineNumber: number; address: string }>
  sourceAddressMapTruncated?: boolean
  prototype?: string
  recoveredVariables?: Array<{ kind: 'parameter' | 'local'; name: string; dataType: string; sizeBytes?: number; parameterIndex?: number; storageStartAddress?: string; nameLocked?: boolean; typeLocked?: boolean }>
  recoveredVariablesTruncated?: boolean
  toCodeInputProvenance?: string
  toCodeClaimedInputPath?: string
  toCodeClaimedInputSha256?: string
  toCodeInputRelativePath?: string
  toCodeInputArtifactSha256?: string
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
  sourceLanguage?: string | null
  representation?: string | null
  decompiler?: string | null
  decompilerVersion?: string | null
  nameEvidence?: string | null
  symbolSource?: string | null
  packageName?: string | null
  goUnstripSignature?: string | null
  goUnstripSourceFile?: string | null
  goUnstripSourceLine?: number | null
  goUnstripInterfaces?: Array<{
    interfaceName: string
    concreteType: string
    method: string
    itabAddress: string
    concreteFunctionAddress: string
    incomplete: boolean
  }>
  goUnstripInterfacesTruncated?: boolean
  unitType: string | null
  relativePath?: string | null
  bundlePath?: string | null
  artifactId: string | null
  artifactPath: string | null
  source: string
  codeArtifactId: string | null
  disassemblyArtifactId: string | null
  disassemblyLanguage: string | null
  classReferences?: string[]
  referencedStrings?: string[]
  referencedStringsTruncated?: boolean
  importedCalls?: string[]
  fieldReferences?: string[]
  fieldReferencesTruncated?: boolean
  sourceAddressMap?: Array<{ ghidraLineNumber: number; address: string }>
  sourceAddressMapTruncated?: boolean
  prototype?: string | null
  recoveredVariables?: Array<{ kind: 'parameter' | 'local'; name: string; dataType: string; sizeBytes?: number; parameterIndex?: number; storageStartAddress?: string; nameLocked?: boolean; typeLocked?: boolean }>
  recoveredVariablesTruncated?: boolean
  toCodeInputProvenance?: string | null
  toCodeClaimedInputPath?: string | null
  toCodeClaimedInputSha256?: string | null
  toCodeInputRelativePath?: string | null
  toCodeInputArtifactSha256?: string | null
  maintainedSource?: boolean
  draftSource?: boolean
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

function sourceAddressMapOf(value: unknown): Array<{ ghidraLineNumber: number; address: string }> {
  if (typeof value !== 'string' || value.length > 1_000_000) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 5000).flatMap((item) => {
      const mapping = attributesOf(item)
      return Number.isInteger(mapping.ghidraLineNumber) && Number(mapping.ghidraLineNumber) > 0
        && Number(mapping.ghidraLineNumber) <= 1_000_000
        && typeof mapping.address === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(mapping.address)
        ? [{ ghidraLineNumber: Number(mapping.ghidraLineNumber), address: mapping.address }]
        : []
    })
  } catch {
    return []
  }
}

function goUnstripInterfacesOf(value: unknown): NonNullable<CodeUnit['goUnstripInterfaces']> {
  if (typeof value !== 'string' || value.length > 64_000) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 32).flatMap((candidate) => {
      const item = attributesOf(candidate)
      if (typeof item.interfaceName !== 'string' || !item.interfaceName.trim() || item.interfaceName.length > 500
          || typeof item.concreteType !== 'string' || !item.concreteType.trim() || item.concreteType.length > 500
          || typeof item.method !== 'string' || !item.method.trim() || item.method.length > 256
          || typeof item.itabAddress !== 'string' || item.itabAddress.length > 128
          || typeof item.concreteFunctionAddress !== 'string' || item.concreteFunctionAddress.length > 128
          || typeof item.incomplete !== 'boolean') return []
      return [{
        interfaceName: item.interfaceName,
        concreteType: item.concreteType,
        method: item.method,
        itabAddress: item.itabAddress,
        concreteFunctionAddress: item.concreteFunctionAddress,
        incomplete: item.incomplete,
      }]
    })
  } catch {
    return []
  }
}

export function recoveredVariablesOf(value: unknown): { variables: NonNullable<CodeUnit['recoveredVariables']>; truncated: boolean } {
  if (typeof value !== 'string' || value.length > 100_000) return { variables: [], truncated: false }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return { variables: [], truncated: false }
    const variables = parsed.flatMap((item) => {
      const variable = attributesOf(item)
      if ((variable.kind !== 'parameter' && variable.kind !== 'local')
          || typeof variable.name !== 'string' || !variable.name.trim() || variable.name.length > 256
          || typeof variable.dataType !== 'string' || variable.dataType.length > 256
          || (variable.sizeBytes !== undefined && (!Number.isInteger(variable.sizeBytes) || Number(variable.sizeBytes) < 0 || Number(variable.sizeBytes) > 65536))) return []
      const kind = variable.kind as 'parameter' | 'local'
      const parameterIndex = variable.parameterIndex
      if (kind === 'parameter' && (!Number.isInteger(parameterIndex) || Number(parameterIndex) < 0 || Number(parameterIndex) >= 100)) return []
      if (kind === 'local' && parameterIndex !== undefined) return []
      const storageStartAddress = variable.storageStartAddress
      if (storageStartAddress !== undefined && (typeof storageStartAddress !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(storageStartAddress))) return []
      if ((variable.nameLocked !== undefined && typeof variable.nameLocked !== 'boolean')
          || (variable.typeLocked !== undefined && typeof variable.typeLocked !== 'boolean')) return []
      return [{
        kind,
        name: variable.name,
        dataType: variable.dataType,
        ...(Number.isInteger(variable.sizeBytes) ? { sizeBytes: Number(variable.sizeBytes) } : {}),
        ...(kind === 'parameter' ? { parameterIndex: Number(parameterIndex) } : {}),
        ...(typeof storageStartAddress === 'string' ? { storageStartAddress } : {}),
        ...(typeof variable.nameLocked === 'boolean' ? { nameLocked: variable.nameLocked } : {}),
        ...(typeof variable.typeLocked === 'boolean' ? { typeLocked: variable.typeLocked } : {}),
      }]
    })
    return { variables: variables.slice(0, 100), truncated: variables.length > 100 || variables.length !== parsed.length }
  } catch {
    return { variables: [], truncated: false }
  }
}

/** Read only provider schemas with known contracts; keep their evidence provisional. */
export function providerVariablesOf(
  value: unknown,
  provider: string,
): { variables: NonNullable<CodeUnit['recoveredVariables']>; truncated: boolean } {
  const attributes = attributesOf(value)
  const normalized = recoveredVariablesOf(attributes.recoveredVariables)
  if (normalized.variables.length || provider !== 'reamon-tocode-import') return normalized

  const variables: NonNullable<CodeUnit['recoveredVariables']> = []
  let truncated = attributes.symbolEvidenceTruncated === true
  const readRows = (json: unknown, kind: 'parameter' | 'local') => {
    if (typeof json !== 'string' || json.length > 4_000) return
    let parsed: unknown
    try { parsed = JSON.parse(json) } catch { return }
    if (!Array.isArray(parsed)) return
    if (parsed.length > 100) truncated = true
    for (const [index, row] of parsed.slice(0, 100).entries()) {
      const item = attributesOf(row)
      if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 256
          || (item.type !== undefined && (typeof item.type !== 'string' || item.type.length > 256))) continue
      variables.push({
        kind,
        name: item.name.trim(),
        dataType: typeof item.type === 'string' ? item.type : '',
        ...(kind === 'parameter' ? { parameterIndex: index } : {}),
      })
    }
  }
  readRows(attributes.parametersJson, 'parameter')
  readRows(attributes.localsJson, 'local')
  return { variables: variables.slice(0, 100), truncated: truncated || variables.length > 100 }
}

export function normalizeCodeUnit(row: CodeUnitObservationRow, options: { includeSourceAddressMap?: boolean } = {}): CodeUnit | null {
  const attributes = attributesOf(row.attributes)
  const sizeBytes = finiteNumber(attributes.sizeBytes)
  if (sizeBytes === null || sizeBytes <= 0 || sizeBytes > Number.MAX_SAFE_INTEGER) return null

  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt
  const artifactPath = row.artifact?.relativePath || row.artifact?.originalName || null
  const bundlePath = text(attributes.bundlePath, 1000)
  const selectedEvidence = options.includeSourceAddressMap ? providerVariablesOf(attributes, row.source) : null
  return {
    id: row.id,
    name: text(attributes.qualifiedName, 500) || text(attributes.name, 500) || text(row.label, 500) || text(row.stableKey, 500) || row.id,
    address: text(attributes.address ?? attributes.startAddress, 128),
    sizeBytes: Math.floor(sizeBytes),
    coveragePercent: coverageOf(attributes),
    language: text(attributes.language, 80),
    sourceLanguage: text(attributes.sourceLanguage, 80),
    representation: text(attributes.representation, 500),
    decompiler: text(attributes.decompiler, 80),
    decompilerVersion: text(attributes.decompilerVersion, 120),
    nameEvidence: text(attributes.nameEvidence, 80),
    symbolSource: text(attributes.symbolSource, 80),
    packageName: text(attributes.goPackage, 500),
    unitType: text(attributes.unitType, 80),
    relativePath: text(attributes.relativePath, 1000),
    ...(bundlePath ? { bundlePath } : {}),
    artifactId: row.artifactId,
    artifactPath,
    source: row.source.slice(0, 120),
    codeArtifactId: text(attributes.codeArtifactId, 2000),
    disassemblyArtifactId: text(attributes.disassemblyArtifactId, 2000),
    disassemblyLanguage: text(attributes.disassemblyLanguage, 80),
    classReferences: classReferencesOf(attributes.classReferences),
    referencedStrings: stringListOf(attributes.referencedStrings, 12, 512),
    referencedStringsTruncated: attributes.referencedStringsTruncated === true,
    importedCalls: stringListOf(attributes.importedCalls, 32, 256),
    fieldReferences: stringListOf(attributes.fieldReferences, 32, 512),
    fieldReferencesTruncated: attributes.fieldReferencesTruncated === true,
    ...(options.includeSourceAddressMap ? {
      sourceAddressMap: sourceAddressMapOf(attributes.sourceAddressMap),
      sourceAddressMapTruncated: attributes.sourceAddressMapTruncated === true,
      prototype: text(attributes.prototype, 2000),
      recoveredVariables: selectedEvidence?.variables || [],
      recoveredVariablesTruncated: Boolean(selectedEvidence?.truncated || attributes.recoveredVariablesTruncated === true),
      goUnstripSignature: text(attributes.goUnstripSignature, 1000),
      goUnstripSourceFile: text(attributes.goUnstripSourceFile, 500),
      goUnstripSourceLine: Number.isInteger(attributes.goUnstripSourceLine) && Number(attributes.goUnstripSourceLine) > 0
        ? Number(attributes.goUnstripSourceLine) : null,
      goUnstripInterfaces: goUnstripInterfacesOf(attributes.goUnstripInterfaces),
      goUnstripInterfacesTruncated: attributes.goUnstripInterfacesTruncated === true,
    } : {}),
    toCodeInputProvenance: text(attributes.toCodeInputProvenance, 80),
    toCodeClaimedInputPath: text(attributes.toCodeClaimedInputPath, 1000),
    toCodeClaimedInputSha256: text(attributes.toCodeClaimedInputSha256, 64),
    toCodeInputRelativePath: text(attributes.toCodeInputRelativePath, 1000),
    toCodeInputArtifactSha256: text(attributes.toCodeInputArtifactSha256, 64),
    maintainedSource: false,
    draftSource: false,
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
      const searchable = `${unit.name} ${unit.address || ''} ${unit.relativePath || ''} ${unit.bundlePath || ''} ${unit.artifactPath || ''} ${unit.language || ''} ${unit.sourceLanguage || ''} ${unit.symbolSource || ''} ${unit.packageName || ''} ${unit.referencedStrings?.join(' ') || ''}`.toLocaleLowerCase()
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

function classReferencesOf(value: unknown): string[] {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))].slice(0, 100)
}

function stringListOf(value: unknown, limit: number, maxLength: number): string[] {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().slice(0, maxLength)).filter(Boolean))].slice(0, limit)
}

export interface CodeUnitTreemapEntry {
  key: string
  name: string
  sizeBytes: number
  coveragePercent: number | null
  codeUnit?: CodeUnit
  folderPath?: string[]
  unitCount: number
  maintainedUnitCount: number
  draftedUnitCount: number
}

const GENERATED_CONTENT_ROOTS = new Set(['sources', 'functions', 'smali', 'resources'])

function codeUnitPath(unit: CodeUnit): string[] {
  const bundleParts = unit.bundlePath?.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.' && part !== '..')
  if (bundleParts?.length) return bundleParts.slice(0, -1)

  const relativeParts = unit.relativePath?.replace(/\\/g, '/').split('/').filter(Boolean)
  if (relativeParts?.length) {
    return GENERATED_CONTENT_ROOTS.has(relativeParts[0]) ? relativeParts.slice(1, -1) : relativeParts.slice(0, -1)
  }

  const artifactPath = unit.codeArtifactId?.replace(/\\/g, '/')
  if (artifactPath) {
    const parts = artifactPath.split('/').filter(Boolean)
    const storageRoot = Math.max(
      parts.lastIndexOf('sources'),
      parts.lastIndexOf('functions'),
      parts.lastIndexOf('smali'),
      parts.lastIndexOf('resources'),
    )
    if (storageRoot >= 0) return parts.slice(storageRoot + 1, -1)
  }

  if ((unit.language === 'Java' || unit.language === 'Smali') && unit.unitType === 'class') {
    const nameParts = unit.name.split('.')
    if (nameParts.length > 1) return nameParts.slice(0, -1)
  }
  return []
}

export function buildCodeUnitTreemapEntries(units: CodeUnit[], selectedPath: string[] = []): CodeUnitTreemapEntry[] {
  const groups = new Map<string, { sizeBytes: number; weightedCoverage: number; measuredBytes: number; unitCount: number; maintainedUnitCount: number; draftedUnitCount: number }>()
  const entries: CodeUnitTreemapEntry[] = []

  for (const unit of units) {
    const path = codeUnitPath(unit)
    if (selectedPath.some((part, index) => path[index] !== part)) continue
    if (path.length > selectedPath.length) {
      const segment = path[selectedPath.length]
      const group = groups.get(segment) || { sizeBytes: 0, weightedCoverage: 0, measuredBytes: 0, unitCount: 0, maintainedUnitCount: 0, draftedUnitCount: 0 }
      group.sizeBytes += unit.sizeBytes
      group.unitCount += 1
      if (unit.maintainedSource) group.maintainedUnitCount += 1
      if (unit.draftSource) group.draftedUnitCount += 1
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
      draftedUnitCount: unit.draftSource ? 1 : 0,
    })
  }

  for (const [segment, group] of groups) {
    const childPath = [...selectedPath, segment]
    entries.push({
      key: `folder:${JSON.stringify(childPath)}`,
      name: segment,
      sizeBytes: group.sizeBytes,
      coveragePercent: group.measuredBytes > 0 ? group.weightedCoverage / group.measuredBytes : null,
      folderPath: childPath,
      unitCount: group.unitCount,
      maintainedUnitCount: group.maintainedUnitCount,
      draftedUnitCount: group.draftedUnitCount,
    })
  }

  return entries.sort((left, right) => right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name))
}

export function filterCodeUnitsByFolder(units: CodeUnit[], selectedPath: string[]): CodeUnit[] {
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
