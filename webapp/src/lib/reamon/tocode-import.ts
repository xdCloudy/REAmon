import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { resolveArtifactStoragePath } from './artifact-storage'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from './derived-storage'
import { normalizeRelativePath } from './paths'
import { ensureProviderRegistered } from './provider-registry'
import { ingestToolResult, MAX_CODE_UNITS_PER_RESULT } from './result-ingestion'
import type { ToolObservation, ToolPluginManifest } from './types'

const SOURCE = 'reamon-tocode-import'
const MAX_METADATA_BYTES = 32 * 1024 * 1024
const MAX_MAPPING_BYTES = 32 * 1024 * 1024
const MAX_EXPORTS = 200
const MAX_FUNCTIONS = 10_000
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_SOURCE_BYTES = 128 * 1024 * 1024
const MAX_REFERENCED_STRINGS_PER_FUNCTION = 12
const MAX_STRING_XREF_ROWS = 100_000
const MAX_FIELD_REFERENCE_EDGES = 1_000
const MAX_TYPE_DETAILS = 1_000
const MAX_TYPE_DETAILS_JSON_BYTES = 64_000

export const toCodeImportManifest: ToolPluginManifest = {
  id: SOURCE,
  name: 'ToCode Export Indexer',
  category: 'static_analysis',
  integration: 'native',
  acceptsTargetTypes: ['DIRECTORY'],
  acceptsFormats: ['tocode-export'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'FunctionAddress', 'CallGraph', 'Relationship'],
  requirements: [{ key: 'workspaceImport' }],
}

interface ImportArtifact {
  id: string
  targetId: string | null
  relativePath: string
  storagePath: string
  sha256: string
  sizeBytes: number
}

interface FunctionRecord {
  address: string
  name: string
  sizeBytes: number
  sourceFile: string | null
  sourceLineStart: number | null
  sourceLineEnd: number | null
  assemblyFile: string | null
  assemblyLineStart: number | null
  assemblyLineEnd: number | null
  prototype: string | null
  raw: Record<string, unknown>
  exportRoot: string
  key: string
  sourceArtifact?: ImportArtifact
  sourceRelativePath?: string
  codeArtifactId?: string
  assemblyArtifact?: ImportArtifact
  assemblyCodeArtifactId?: string
  referencedStrings: string[]
  referencedStringsTruncated: boolean
  importedCalls: string[]
  fieldReferences: string[]
  fieldReferencesTruncated: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function safeText(value: unknown, max = 1000): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function positiveInteger(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function boundedVariableRows(value: unknown): { json?: string; truncated: boolean } {
  if (!Array.isArray(value)) return { truncated: false }
  const rows: Array<{ name: string; type?: string }> = []
  let truncated = value.length > 100
  for (const entry of value.slice(0, 100)) {
    const row = asRecord(entry)
    if (!row || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 256
        || (row.type !== undefined && row.type !== null && (typeof row.type !== 'string' || row.type.length > 256))) {
      truncated = true
      continue
    }
    const normalized = { name: row.name.trim(), ...(typeof row.type === 'string' ? { type: row.type } : {}) }
    if (JSON.stringify([...rows, normalized]).length > 4_000) {
      truncated = true
      break
    }
    rows.push(normalized)
  }
  return { ...(rows.length ? { json: JSON.stringify(rows) } : {}), truncated }
}

function boundedImportedCalls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = new Set<string>()
  for (const entry of value.slice(0, 64)) {
    const name = typeof entry === 'string'
      ? entry
      : safeText(asRecord(entry)?.name ?? asRecord(entry)?.symbol, 256)
    if (!name || /[\r\n\t]/.test(name)) continue
    names.add(name)
    if (names.size >= 32) break
  }
  return [...names]
}

function boundedFieldReferences(value: unknown): { items: string[]; truncated: boolean } {
  if (!Array.isArray(value)) return { items: [], truncated: value !== undefined && value !== null }
  const items: string[] = []
  let truncated = value.length > 32
  for (const entry of value.slice(0, 64)) {
    const reference = safeText(entry, 512)
    if (!reference || /[\r\n\t]/.test(reference)) {
      truncated = true
      continue
    }
    if (!items.includes(reference)) items.push(reference)
    if (items.length >= 32) {
      if (value.length > items.length) truncated = true
      break
    }
  }
  return { items, truncated }
}

function parseDexFieldSignature(value: string): { owner: string; name: string; fieldType: string } | null {
  const match = /^(L[^;\s]+;)->([^:\s]+):(\[*[ZBSCIJFD]|\[*L[^;\s]+;)$/.exec(value)
  return match ? { owner: match[1], name: match[2], fieldType: match[3] } : null
}

function toCodeTypeDeclaration(row: Record<string, unknown>): string {
  const namespace = safeText(row.namespace, 256)
  const assembly = safeText(row.assembly, 256)
  const baseType = safeText(row.base_type ?? row.superclass, 256)
  const interfaces = Array.isArray(row.interfaces)
    ? row.interfaces.flatMap((item) => safeText(item, 256) || []).slice(0, 16)
    : []
  const members = [
    ...(Array.isArray(row.fields) ? row.fields : []),
    ...(Array.isArray(row.members) ? row.members : []),
    ...(Array.isArray(row.properties) ? row.properties : []),
    ...(Array.isArray(row.events) ? row.events : []),
    ...(Array.isArray(row.methods) ? row.methods : []),
  ].slice(0, 32).flatMap((candidate) => {
    const member = asRecord(candidate)
    const name = safeText(member?.name, 128)
    if (!name) return []
    const prototype = safeText(member?.prototype, 256)
    if (prototype) return [prototype]
    const type = safeText(member?.type, 256)
    return [type ? `${type} ${name}` : name]
  })
  return [
    namespace ? `namespace ${namespace}` : '',
    assembly ? `assembly ${assembly}` : '',
    baseType ? `base ${baseType}` : '',
    interfaces.length ? `interfaces ${interfaces.join(', ')}` : '',
    members.length ? `members ${members.join('; ')}` : '',
  ].filter(Boolean).join(' | ').slice(0, 2048)
}

function boundedToCodeTypeDetails(value: unknown): { json: string; count: number; truncated: boolean } {
  const rows = Array.isArray(value) ? value : []
  const details: Array<{ name: string; kind: string; reconstructed: string }> = []
  let truncated = !Array.isArray(value) || rows.length > MAX_TYPE_DETAILS
  for (const entry of rows.slice(0, MAX_TYPE_DETAILS)) {
    const row = asRecord(entry)
    const name = safeText(row?.name, 256)
    const kind = safeText(row?.kind, 80)
    if (typeof row?.c_decl === 'string' && row.c_decl.length > 2048) truncated = true
    const reconstructed = safeText(row?.c_decl, 2048) || (row ? toCodeTypeDeclaration(row) : '')
    if (!name || !kind) {
      truncated = true
      continue
    }
    const detail = { name, kind, reconstructed }
    const serialized = JSON.stringify([...details, detail])
    if (Buffer.byteLength(serialized, 'utf8') > MAX_TYPE_DETAILS_JSON_BYTES) {
      truncated = true
      break
    }
    details.push(detail)
  }
  return { json: JSON.stringify(details), count: details.length, truncated }
}

function optionalLine(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function cleanExportPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) return null
  const normalized = value.trim().replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  try { return normalizeRelativePath(normalized) } catch { return null }
}

function exportRootOf(relativePath: string): string {
  const root = path.posix.dirname(relativePath)
  return root === '.' ? '' : root
}

function joinedExportPath(exportRoot: string, relativePath: unknown): string | null {
  const clean = cleanExportPath(relativePath)
  if (!clean) return null
  return cleanExportPath(exportRoot ? `${exportRoot}/${clean}` : clean)
}

function addressKey(value: unknown): string | null {
  const address = typeof value === 'number' && Number.isSafeInteger(value)
    ? `0x${value.toString(16)}`
    : safeText(value, 256)
  if (!address || /[\r\n\t]/.test(address)) return null
  return address.toLowerCase().replace(/^0x0*/, '0x')
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function languageFor(filePath: string): string {
  const extension = path.posix.extname(filePath).toLowerCase()
  const languages: Record<string, string> = {
    '.c': 'C', '.h': 'C', '.i': 'C',
    '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++', '.c++': 'C++', '.hh': 'C++', '.hpp': 'C++', '.hxx': 'C++',
    '.java': 'Java',
    '.kt': 'Kotlin', '.kts': 'Kotlin',
    '.cs': 'C#', '.csx': 'C#',
    '.vb': 'Visual Basic',
    '.fs': 'F#', '.fsi': 'F#', '.fsx': 'F#',
    '.go': 'Go',
    '.rs': 'Rust',
    '.py': 'Python', '.pyw': 'Python',
    '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
    '.swift': 'Swift',
    '.m': 'Objective-C', '.mm': 'Objective-C++',
    '.php': 'PHP',
    '.rb': 'Ruby',
    '.lua': 'Lua',
    '.pl': 'Perl', '.pm': 'Perl',
    '.scala': 'Scala', '.sc': 'Scala',
    '.groovy': 'Groovy', '.gvy': 'Groovy',
    '.dart': 'Dart',
    '.sol': 'Solidity',
    '.wat': 'WebAssembly Text', '.wasm': 'WebAssembly',
    '.il': '.NET IL',
    '.s': 'Assembly', '.asm': 'Assembly',
  }
  return languages[extension] || 'unknown'
}

async function readJsonArtifact(artifact: ImportArtifact, maximumBytes: number): Promise<Record<string, unknown> | null> {
  if (artifact.sizeBytes <= 0 || artifact.sizeBytes > maximumBytes) return null
  const bytes = await readFile(resolveArtifactStoragePath(artifact.storagePath))
  if (bytes.byteLength !== artifact.sizeBytes) return null
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== artifact.sha256.toLowerCase()) return null
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  return asRecord(parsed)
}

function exportLooksLikeToCode(relativePath: string, pathSet: Set<string>): boolean {
  return pathSet.has(path.posix.join(exportRootOf(relativePath), 'export-manifest.json'))
}

export function hasToCodeExport(paths: string[]): boolean {
  const set = new Set(paths.map((item) => item.replace(/\\/g, '/')))
  return paths.some((item) => path.posix.basename(item.replace(/\\/g, '/')) === 'functions.json'
    && exportLooksLikeToCode(item.replace(/\\/g, '/'), set))
}

function makeCodeUnit(record: FunctionRecord, metadata: Record<string, unknown>, codeArtifactId?: string): ToolObservation {
  const params = boundedVariableRows(record.raw.params)
  const locals = boundedVariableRows(record.raw.locals)
  const attrs: Record<string, string | number | boolean | null> = {
    unitType: 'function',
    identity: `${record.exportRoot}:${record.address}`,
    name: record.name,
    qualifiedName: record.name,
    address: record.address,
    sizeBytes: record.sizeBytes,
    language: record.sourceFile ? languageFor(record.sourceFile) : 'C',
    sourceLanguage: record.sourceFile ? languageFor(record.sourceFile) : 'C',
    representation: 'pseudocode',
    decompiler: 'ToCode',
    providerRevision: safeText(metadata.version, 128) || 'ToCode export (version not recorded)',
    exportPath: record.exportRoot || '.',
    recoveredTypeData: true,
    reachable: record.raw.dead_code === true ? false : true,
  }
  if (record.prototype) attrs.prototype = record.prototype
  if (params.json) attrs.parametersJson = params.json
  if (locals.json) attrs.localsJson = locals.json
  if (record.referencedStrings.length) attrs.referencedStrings = JSON.stringify(record.referencedStrings)
  if (record.referencedStringsTruncated) attrs.referencedStringsTruncated = true
  if (record.importedCalls.length) attrs.importedCalls = JSON.stringify(record.importedCalls)
  if (record.fieldReferences.length) attrs.fieldReferences = JSON.stringify(record.fieldReferences)
  if (record.fieldReferencesTruncated) attrs.fieldReferencesTruncated = true
  if (params.truncated || locals.truncated) attrs.symbolEvidenceTruncated = true
  if (record.sourceFile) attrs.relativePath = record.sourceFile
  if (record.sourceLineStart !== null) attrs.sourceLineStart = record.sourceLineStart
  if (record.sourceLineEnd !== null) attrs.sourceLineEnd = record.sourceLineEnd
  if (record.assemblyFile) attrs.assemblyRelativePath = record.assemblyFile
  if (record.assemblyLineStart !== null) attrs.assemblyLineStart = record.assemblyLineStart
  if (record.assemblyLineEnd !== null) attrs.assemblyLineEnd = record.assemblyLineEnd
  if (record.sourceArtifact) attrs.sourceArtifactId = record.sourceArtifact.id
  if (record.sourceArtifact) attrs.sourceArtifactSha256 = record.sourceArtifact.sha256
  if (codeArtifactId) attrs.codeArtifactId = codeArtifactId
  if (record.assemblyArtifact) attrs.assemblyArtifactId = record.assemblyArtifact.id
  if (record.assemblyArtifact) attrs.assemblyArtifactSha256 = record.assemblyArtifact.sha256
  if (record.assemblyCodeArtifactId) attrs.disassemblyArtifactId = record.assemblyCodeArtifactId
  if (record.assemblyCodeArtifactId) attrs.disassemblyLanguage = 'assembly'
  return {
    kind: 'entity',
    type: 'code_unit',
    key: record.key,
    label: record.name,
    attributes: attrs,
  }
}

function functionAtLocation(
  exportRoot: string,
  address: unknown,
  sourceFile: unknown,
  lineStart: unknown,
  recordsByAddress: Map<string, FunctionRecord>,
  allRecords: FunctionRecord[],
): FunctionRecord | undefined {
  const normalizedAddress = addressKey(address)
  if (normalizedAddress) {
    const direct = recordsByAddress.get(`${exportRoot}\u0000${normalizedAddress}`)
    if (direct) return direct
  }
  const file = cleanExportPath(sourceFile)
  const line = optionalLine(lineStart)
  if (!file || !line) return undefined
  const workspaceFile = exportRoot && (file === exportRoot || file.startsWith(`${exportRoot}/`))
    ? file
    : joinedExportPath(exportRoot, file)
  if (!workspaceFile) return undefined
  return allRecords.find((record) => record.exportRoot === exportRoot && record.sourceRelativePath === workspaceFile
    && record.sourceLineStart !== null && record.sourceLineEnd !== null
    && record.sourceLineStart <= line && record.sourceLineEnd >= line)
}

export async function indexToCodeWorkspaceImport(projectId: string, importId: string) {
  const workspaceImport = await prisma.workspaceImport.findFirst({
    where: { id: importId, projectId, status: 'COMPLETED' },
    select: {
      id: true,
      rootName: true,
      rootTargetId: true,
      artifacts: { select: { id: true, targetId: true, relativePath: true, storagePath: true, sha256: true, sizeBytes: true } },
    },
  })
  if (!workspaceImport) throw new Error('Completed workspace import not found')

  const artifacts: ImportArtifact[] = workspaceImport.artifacts.map((item) => ({
    ...item,
    relativePath: item.relativePath.replace(/\\/g, '/'),
  }))
  const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]))
  const pathSet = new Set(artifactsByPath.keys())
  const candidates = artifacts.filter((artifact) => path.posix.basename(artifact.relativePath) === 'functions.json'
    && exportLooksLikeToCode(artifact.relativePath, pathSet)).slice(0, MAX_EXPORTS)
  if (!candidates.length) throw new Error('This workspace import does not contain a ToCode export')

  const anchor = candidates[0]
  let exportVersion = 'ToCode export (version not recorded)'
  const projectMetadataArtifact = artifactsByPath.get('project.json')
  if (projectMetadataArtifact) {
    try {
      const projectMetadata = await readJsonArtifact(projectMetadataArtifact, MAX_METADATA_BYTES)
      exportVersion = safeText(projectMetadata?.tocode_version ?? projectMetadata?.version, 128) || exportVersion
    } catch { /* version is informational; keep the fallback */ }
  }
  const provider = await ensureProviderRegistered(toCodeImportManifest)
  const idempotencyKey = `tocode-index:${shortHash(`${projectId}:${importId}`)}`
  const existing = await prisma.task.findFirst({ where: { projectId, idempotencyKey }, select: { id: true, result: true } })
  if (existing) return { taskId: existing.id, ...(asRecord(existing.result) || {}), alreadyIndexed: true }

  const taskId = randomUUID()
  const outputRoot = resolveDerivedArtifactPath(`${projectId}/${anchor.id}/${taskId}/tocode`)
  const observations: ToolObservation[] = []
  const allFunctions: FunctionRecord[] = []
  const recordsByAddress = new Map<string, FunctionRecord>()
  const sourceFiles = new Map<string, { artifact: ImportArtifact; derivedPath: string }>()
  let inputFunctions = 0
  let skippedFunctions = 0
  let sourceBytes = 0
  let sourceFilesSkipped = 0
  let failedExports = 0
  const warnings: string[] = []

  async function copyImportedText(workspacePath: string) {
    const artifact = artifactsByPath.get(workspacePath)
    if (!artifact || artifact.sizeBytes <= 0 || artifact.sizeBytes > MAX_SOURCE_FILE_BYTES) return null
    let sourceEntry = sourceFiles.get(workspacePath)
    if (!sourceEntry && sourceBytes + artifact.sizeBytes <= MAX_TOTAL_SOURCE_BYTES) {
      const sourceData = await readFile(resolveArtifactStoragePath(artifact.storagePath))
      const digest = createHash('sha256').update(sourceData).digest('hex')
      if (sourceData.byteLength !== artifact.sizeBytes || digest !== artifact.sha256.toLowerCase()) return null
      const suffix = path.posix.extname(workspacePath) || '.txt'
      const derivedRelative = `${projectId}/${anchor.id}/${taskId}/tocode/${shortHash(workspacePath)}${suffix}`
      const destination = resolveDerivedArtifactPath(derivedRelative)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, sourceData, { flag: 'wx' })
      sourceBytes += sourceData.byteLength
      sourceEntry = { artifact, derivedPath: derivedRelative }
      sourceFiles.set(workspacePath, sourceEntry)
    }
    return sourceEntry ? { artifact: sourceEntry.artifact, derivedPath: sourceEntry.derivedPath } : null
  }

  try {
    await mkdir(outputRoot, { recursive: true })
    for (const metadataArtifact of candidates) {
      let metadata: Record<string, unknown> | null
      try { metadata = await readJsonArtifact(metadataArtifact, MAX_METADATA_BYTES) } catch { metadata = null }
      const rawFunctions = metadata?.functions
      if (!metadata || !Array.isArray(rawFunctions)) {
        failedExports += 1
        warnings.push(`${metadataArtifact.relativePath}: invalid ToCode function manifest`)
        continue
      }
      const exportRoot = exportRootOf(metadataArtifact.relativePath)
      let acceptedInExport = 0
      for (const raw of rawFunctions) {
        if (allFunctions.length >= MAX_FUNCTIONS || allFunctions.length >= MAX_CODE_UNITS_PER_RESULT) break
        const row = asRecord(raw)
        const address = addressKey(row?.address ?? row?.token)
        const name = safeText(row?.name ?? row?.c_name, 500)
        if (!row || !address || !name) continue
        const sourceFile = cleanExportPath(row.source_file)
        const sourceLineStart = optionalLine(row.source_line_start)
        const sourceLineEnd = optionalLine(row.source_line_end)
        const assemblyFile = cleanExportPath(row.asm_file)
        const fieldReferences = boundedFieldReferences(row.field_refs)
        const key = `tocode:function:${shortHash(`${importId}:${metadataArtifact.relativePath}:${address}`)}`
        const record: FunctionRecord = {
          address,
          name,
          sizeBytes: positiveInteger(row.size),
          sourceFile,
          sourceLineStart,
          sourceLineEnd,
          assemblyFile,
          assemblyLineStart: optionalLine(row.asm_line_start),
          assemblyLineEnd: optionalLine(row.asm_line_end),
          prototype: safeText(row.prototype, 4000),
          raw: row,
          exportRoot,
          key,
          referencedStrings: [],
          referencedStringsTruncated: false,
          importedCalls: boundedImportedCalls(row.callees_imports),
          fieldReferences: fieldReferences.items,
          fieldReferencesTruncated: fieldReferences.truncated,
        }
        if (sourceFile) {
          const workspaceSourcePath = joinedExportPath(exportRoot, sourceFile)
          const copiedSource = workspaceSourcePath ? await copyImportedText(workspaceSourcePath) : null
          if (copiedSource && workspaceSourcePath) {
            record.sourceArtifact = copiedSource.artifact
            record.sourceRelativePath = workspaceSourcePath
            record.codeArtifactId = copiedSource.derivedPath
          } else {
            sourceFilesSkipped += 1
          }
        }
        if (assemblyFile) {
          const workspaceAssemblyPath = joinedExportPath(exportRoot, assemblyFile)
          const copiedAssembly = workspaceAssemblyPath ? await copyImportedText(workspaceAssemblyPath) : null
          if (copiedAssembly) {
            record.assemblyArtifact = copiedAssembly.artifact
            record.assemblyCodeArtifactId = copiedAssembly.derivedPath
          } else {
            sourceFilesSkipped += 1
          }
        }
        allFunctions.push(record)
        recordsByAddress.set(`${exportRoot}\u0000${address}`, record)
        acceptedInExport += 1
      }
      inputFunctions += rawFunctions.length
      skippedFunctions += Math.max(0, rawFunctions.length - acceptedInExport)
    }

    let referencedStringRows = 0
    let stringXrefsTruncated = false
    for (const metadataArtifact of candidates) {
      if (stringXrefsTruncated) break
      const exportRoot = exportRootOf(metadataArtifact.relativePath)
      const stringsArtifact = artifactsByPath.get(exportRoot ? `${exportRoot}/strings.json` : 'strings.json')
      if (!stringsArtifact) continue
      let strings: Record<string, unknown> | null
      try { strings = await readJsonArtifact(stringsArtifact, MAX_METADATA_BYTES) } catch { strings = null }
      if (!Array.isArray(strings?.strings)) continue
      for (const rawString of strings.strings.slice(0, MAX_STRING_XREF_ROWS)) {
        const string = asRecord(rawString)
        const value = safeText(string?.value, 512)
        if (!value || !Array.isArray(string?.xrefs)) continue
        for (const rawXref of string.xrefs.slice(0, 64)) {
          referencedStringRows += 1
          if (referencedStringRows > MAX_STRING_XREF_ROWS) {
            stringXrefsTruncated = true
            break
          }
          const xref = asRecord(rawXref)
          const address = addressKey(xref?.address)
          const functionRecord = address ? recordsByAddress.get(`${exportRoot}\u0000${address}`) : undefined
          if (!functionRecord || functionRecord.referencedStrings.includes(value)) continue
          if (functionRecord.referencedStrings.length < MAX_REFERENCED_STRINGS_PER_FUNCTION) {
            functionRecord.referencedStrings.push(value)
          } else {
            functionRecord.referencedStringsTruncated = true
          }
        }
        if (stringXrefsTruncated) break
      }
    }

    let recoveredTypeCount = 0
    let truncatedTypeCatalogs = 0
    let skippedTypeCatalogs = 0
    for (const metadataArtifact of candidates) {
      const exportRoot = exportRootOf(metadataArtifact.relativePath)
      const typesPath = exportRoot ? `${exportRoot}/types.json` : 'types.json'
      const classesPath = exportRoot ? `${exportRoot}/classes.json` : 'classes.json'
      const typeArtifact = artifactsByPath.get(typesPath) || artifactsByPath.get(classesPath)
      if (!typeArtifact) continue
      let typeCatalog: Record<string, unknown> | null
      try { typeCatalog = await readJsonArtifact(typeArtifact, MAX_METADATA_BYTES) } catch { typeCatalog = null }
      const rawTypeRows = Array.isArray(typeCatalog?.types) ? typeCatalog.types : typeCatalog?.classes
      if (!Array.isArray(rawTypeRows)) {
        skippedTypeCatalogs += 1
        warnings.push(`${typeArtifact.relativePath}: type catalog was invalid or exceeded the import size limit.`)
        continue
      }
      const bounded = boundedToCodeTypeDetails(rawTypeRows)
      if (!bounded.count) {
        skippedTypeCatalogs += 1
        warnings.push(`${typeArtifact.relativePath}: no usable type declarations were found.`)
        continue
      }
      recoveredTypeCount += bounded.count
      if (bounded.truncated) truncatedTypeCatalogs += 1
      observations.push({
        kind: 'entity',
        type: 'language_metadata',
        key: `tocode:type-catalog:${shortHash(`${importId}:${exportRoot}`)}`,
        label: `ToCode type catalog · ${exportRoot || 'root export'}`.slice(0, 500),
        attributes: {
          language: 'ToCode',
          exportPath: exportRoot || '.',
          providerRevision: exportVersion,
          typeDetails: bounded.json,
          typeCount: bounded.count,
          typeDetailsTruncated: bounded.truncated,
          typeSourceArtifactId: typeArtifact.id,
          typeSourceArtifactSha256: typeArtifact.sha256,
          typeSourceArtifactPath: typeArtifact.relativePath,
        },
      })
    }

    if (allFunctions.length === 0) throw new Error('No valid ToCode functions were found in this workspace import')

    for (const record of allFunctions) {
      const metadata = { version: exportVersion }
      observations.push(makeCodeUnit(record, metadata, record.codeArtifactId))
    }

    const seenFieldSymbols = new Set<string>()
    const seenFieldEdges = new Set<string>()
    let fieldReferenceEdgesTruncated = false
    for (const record of allFunctions) {
      for (const signature of record.fieldReferences) {
        const parsed = parseDexFieldSignature(signature)
        if (!parsed) continue
        const edgeIdentity = `${record.key}\u0000${signature}`
        if (seenFieldEdges.has(edgeIdentity)) continue
        if (seenFieldEdges.size >= MAX_FIELD_REFERENCE_EDGES) {
          fieldReferenceEdgesTruncated = true
          break
        }
        const fieldIdentity = `${importId}:${record.exportRoot}:${signature}`
        const fieldKey = `tocode:field:${shortHash(fieldIdentity)}`
        if (!seenFieldSymbols.has(fieldKey)) {
          observations.push({
            kind: 'entity',
            type: 'symbol',
            key: fieldKey,
            label: signature,
            attributes: {
              unitType: 'field',
              symbolKind: 'field',
              identity: fieldIdentity,
              identityKey: `field:${record.exportRoot}:${signature}`,
              name: parsed.name,
              qualifiedName: signature,
              owner: parsed.owner,
              fieldType: parsed.fieldType,
              exportPath: record.exportRoot || '.',
              decompilationEngine: 'ToCode APK metadata',
            },
          })
          seenFieldSymbols.add(fieldKey)
        }
        observations.push({
          kind: 'relationship',
          type: 'references_field',
          relation: 'references_field',
          key: `tocode:field-reference:${shortHash(`${importId}:${edgeIdentity}`)}`,
          fromKey: record.key,
          toKey: fieldKey,
          label: `${record.name} references field ${signature}`.slice(0, 500),
          attributes: {
            fromSignature: record.name,
            fromAddress: record.address,
            targetName: parsed.name,
            targetSignature: signature,
            referenceKind: 'field_reference',
            accessDirection: 'unknown',
            referenceSemantics: 'ToCode field_refs does not distinguish reads from writes.',
            exportPath: record.exportRoot || '.',
          },
        })
        seenFieldEdges.add(edgeIdentity)
      }
      if (fieldReferenceEdgesTruncated) break
    }

    const seenCalls = new Set<string>()
    let callEdgesTruncated = false
    for (const record of allFunctions) {
      const callees = Array.isArray(record.raw.callees) ? record.raw.callees.slice(0, 256) : []
      for (const rawCallee of callees) {
        if (observations.length >= MAX_CODE_UNITS_PER_RESULT) {
          callEdgesTruncated = true
          break
        }
        const targetAddress = addressKey(rawCallee)
        const target = targetAddress ? recordsByAddress.get(`${record.exportRoot}\u0000${targetAddress}`) : undefined
        if (!target || target.key === record.key) continue
        const identity = `${record.key}->${target.key}`
        if (seenCalls.has(identity)) continue
        seenCalls.add(identity)
        observations.push({
          kind: 'relationship',
          type: 'calls',
          relation: 'calls',
          key: `tocode:call:${shortHash(`${importId}:${identity}`)}`,
          fromKey: record.key,
          toKey: target.key,
          label: `${record.name} calls ${target.name}`.slice(0, 500),
          attributes: { source: 'ToCode functions.json', exportPath: record.exportRoot || '.' },
        })
      }
      if (callEdgesTruncated) break
    }

    const mappingsArtifact = artifactsByPath.get('mappings.json')
    let crossBinaryCalls = 0
    if (mappingsArtifact && mappingsArtifact.sizeBytes <= MAX_MAPPING_BYTES) {
      try {
        const mappings = await readJsonArtifact(mappingsArtifact, MAX_MAPPING_BYTES)
        const links = Array.isArray(mappings?.links) ? mappings.links.slice(0, 100_000) : []
        for (const rawLink of links) {
          if (observations.length >= MAX_CODE_UNITS_PER_RESULT) {
            callEdgesTruncated = true
            break
          }
          const link = asRecord(rawLink)
          if (!link || link.status !== 'bound' || !safeText(link.target, 1000)) continue
          const importerRoot = cleanExportPath(link.importer)
          const targetRoot = cleanExportPath(link.target_export_dir ?? link.target)
          if (!importerRoot || !targetRoot) continue
          const targetFunction = asRecord(link.target_function)
          if (!targetFunction) continue
          const destination = functionAtLocation(targetRoot, targetFunction.address ?? targetFunction.token, targetFunction.source_file, targetFunction.line_start, recordsByAddress, allFunctions)
          if (!destination) continue
          const sites = Array.isArray(link.call_sites) ? link.call_sites.slice(0, 16) : []
          for (const rawSite of sites) {
            if (observations.length >= MAX_CODE_UNITS_PER_RESULT) {
              callEdgesTruncated = true
              break
            }
            const site = asRecord(rawSite)
            if (!site) continue
            const caller = functionAtLocation(importerRoot, site.address ?? site.token, site.source_file, site.line_start, recordsByAddress, allFunctions)
            if (!caller || caller.key === destination.key) continue
            const identity = `${caller.key}->${destination.key}`
            if (seenCalls.has(identity)) continue
            seenCalls.add(identity)
            observations.push({
              kind: 'relationship',
              type: 'calls',
              relation: 'calls',
              key: `tocode:call:${shortHash(`${importId}:${identity}`)}`,
              fromKey: caller.key,
              toKey: destination.key,
              label: `${caller.name} calls ${destination.name} · ${safeText(link.symbol, 256) || 'linked import'}`.slice(0, 500),
              attributes: {
                source: 'ToCode mappings.json',
                importSymbol: safeText(link.symbol, 256) || '',
                importer: importerRoot,
                target: targetRoot,
                resolution: safeText(link.resolution, 128) || '',
              },
            })
            crossBinaryCalls += 1
          }
          if (callEdgesTruncated) break
        }
      } catch {
        warnings.push('mappings.json could not be parsed; cross-binary call links were skipped.')
      }
    }
    if (fieldReferenceEdgesTruncated) warnings.push(`Field-reference relationships were capped at ${MAX_FIELD_REFERENCE_EDGES}; method-level field-reference signatures remain stored where their function rows were indexed.`)
    if (callEdgesTruncated) warnings.push('Call relationships were capped by the ToCode observation limit; indexed method rows remain available.')
    if (candidates.length === MAX_EXPORTS) warnings.push(`Only the first ${MAX_EXPORTS} ToCode exports were indexed.`)
    if (inputFunctions > allFunctions.length + skippedFunctions) warnings.push('Some function rows were omitted by the indexer limits.')
    if (sourceFilesSkipped) warnings.push(`${sourceFilesSkipped} source or assembly links were omitted because files were missing, oversized, or exceeded the copy limit.`)

    const summary = {
      provider: 'ToCode export importer',
      importId,
      exportCount: candidates.length,
      failedExportCount: failedExports,
      discoveredFunctions: inputFunctions,
      indexedFunctions: allFunctions.length,
      skippedFunctions,
      callEdges: seenCalls.size,
      crossBinaryCallEdges: crossBinaryCalls,
      fieldReferenceEdges: seenFieldEdges.size,
      fieldReferenceEdgesTruncated,
      functionsWithReferencedStrings: allFunctions.filter((record) => record.referencedStrings.length > 0).length,
      functionsWithImportedCalls: allFunctions.filter((record) => record.importedCalls.length > 0).length,
      functionsWithFieldReferences: allFunctions.filter((record) => record.fieldReferences.length > 0).length,
      referencedStringEvidenceTruncated: stringXrefsTruncated || allFunctions.some((record) => record.referencedStringsTruncated),
      recoveredTypeCount,
      truncatedTypeCatalogs,
      skippedTypeCatalogs,
      callEdgesTruncated,
      copiedSourceAndAssemblyFiles: sourceFiles.size,
      copiedSourceAndAssemblyBytes: sourceBytes,
      warnings: warnings.slice(0, 100),
    }

    await prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          id: taskId,
          projectId,
          targetId: workspaceImport.rootTargetId || anchor.targetId,
          artifactId: anchor.id,
          providerId: provider.id,
          capability: 'decompile',
          title: `Index ToCode export: ${workspaceImport.rootName}`,
          category: 'analysis',
          status: 'COMPLETED',
          progress: 100,
          progressMessage: 'ToCode export indexed',
          options: { importId, indexingMode: 'imported-export' } as Prisma.InputJsonValue,
          result: summary as unknown as Prisma.InputJsonValue,
          idempotencyKey,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      })
      await ingestToolResult(tx, {
        projectId,
        taskId: task.id,
        targetId: task.targetId,
        artifactId: anchor.id,
        source: SOURCE,
        data: { observations },
        maxObservations: MAX_CODE_UNITS_PER_RESULT,
      })
      await tx.evidence.create({
        data: {
          projectId,
          targetId: task.targetId,
          artifactId: anchor.id,
          kind: 'analysis',
          summary: `Indexed ${allFunctions.length.toLocaleString()} functions from a ToCode workspace export`,
          source: SOURCE,
          data: summary as unknown as Prisma.InputJsonValue,
        },
      })
      await tx.workspaceActivity.create({
        data: {
          projectId,
          actor: 'ToCode Export Indexer',
          eventType: 'analysis.task.completed',
          message: `Indexed ${allFunctions.length.toLocaleString()} ToCode functions and ${seenCalls.size.toLocaleString()} call relationships`,
          data: { taskId: task.id, artifactId: anchor.id, providerId: SOURCE, capability: 'decompile', ...summary },
        },
      })
      const currentImport = await tx.workspaceImport.findUnique({
        where: { id: importId },
        select: { metadata: true },
      })
      const importMetadata = asRecord(currentImport?.metadata) || {}
      await tx.workspaceImport.update({
        where: { id: importId },
        data: {
          metadata: {
            ...importMetadata,
            toCodeIndex: { status: 'COMPLETED', taskId, indexedFunctions: allFunctions.length, indexedAt: new Date().toISOString() },
          } as Prisma.InputJsonObject,
        },
      })
    }, { maxWait: 10_000, timeout: 120_000 })

    return { taskId, ...summary, alreadyIndexed: false }
  } catch (error) {
    const relativeOutputRoot = `${projectId}/${anchor.id}/${taskId}`
    await rm(resolveDerivedArtifactPath(relativeOutputRoot), { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
