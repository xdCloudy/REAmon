import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { agentFetch } from '@/lib/agentFetch'
import { requireEffectiveUser, requireProjectAccessStrict } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { resolveArtifactStoragePath } from '@/lib/reamon/artifact-storage'
import { applySafeRenameBindings, listSafeRenameBindings, type SafeRenameBinding, type SafeRenameCatalog, type SafeRenameResult } from '@/lib/reamon/webcrack'
import { buildProjectSymbolContext } from '@/lib/reamon/maintenance-memory'
import {
  buildGoPackageRenameSnapshot,
  hashGoPackageSourceSet,
  GoPackageRenameSnapshotError,
  isSafeGoPackagePath,
  type GoPackageRenameFile,
} from '@/lib/reamon/go-package-rename'

interface RouteParams { params: Promise<{ id: string }> }

const MAX_SOURCE_BYTES = 512 * 1024
const MAX_GO_PROJECT_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_SUGGESTION_SOURCE_BYTES = 64 * 1024
const MAX_CANDIDATES = 200
const MAX_PROJECT_SYMBOL_SCAN = 4_096
const MAX_GO_PROJECT_INVENTORY_ENTRIES = 5_000
const MAX_GO_MODULE_MANIFEST_BYTES = 1024 * 1024

interface GoModuleInventoryContext {
  modulePath: string
  moduleRoot: string
  manifestSha256: string
  manifestText: string
  sumSha256: string
  sumText: string
}

interface GoModuleSourceSnapshot {
  context: GoModuleInventoryContext
  files: GoPackageRenameFile[]
}

interface GoDownstreamModuleCheck {
  module_path: string
  module_root: string
  go_mod: string
  go_mod_sha256: string
  go_sum: string
  go_sum_sha256: string
  files: Array<{ relative_path: string; source_code: string; expected_sha256: string }>
}

class GoModuleCompatibilityError extends Error {}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function hashGoProjectInventoryScope(files: GoPackageRenameFile[], module: GoModuleInventoryContext): string {
  return createHash('sha256')
    .update('reamon-go-project-inventory-v2\0')
    .update(hashGoPackageSourceSet(files)).update('\0')
    .update(module.moduleRoot).update('\0').update(module.modulePath).update('\0')
    .update(module.manifestSha256).update('\0').update(module.sumSha256)
    .digest('hex')
}

function goModuleRoot(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.toLowerCase() === 'go.mod') return ''
  return normalized.toLowerCase().endsWith('/go.mod') ? normalized.slice(0, -'/go.mod'.length) : ''
}

async function loadGoModuleInventoryContext(
  artifactWhere: Prisma.ArtifactWhereInput,
  sourcePaths: string[],
): Promise<GoModuleInventoryContext> {
  const candidates = await prisma.artifact.findMany({
    where: { ...artifactWhere, relativePath: { endsWith: 'go.mod', mode: 'insensitive' } },
    orderBy: [{ relativePath: 'asc' }, { id: 'asc' }],
    take: 128,
    select: { relativePath: true, storagePath: true, sizeBytes: true, sha256: true },
  })
  const matching = candidates.filter((artifact) => {
    const root = goModuleRoot(artifact.relativePath)
    return sourcePaths.every((sourcePath) => !root || sourcePath.startsWith(`${root}/`))
  }).sort((left, right) => goModuleRoot(right.relativePath).length - goModuleRoot(left.relativePath).length)
  if (!matching.length) return { modulePath: '', moduleRoot: '', manifestSha256: '', manifestText: '', sumSha256: '', sumText: '' }

  const manifest = matching[0]
  const moduleRoot = goModuleRoot(manifest.relativePath)
  if (manifest.sizeBytes > BigInt(MAX_GO_MODULE_MANIFEST_BYTES)) throw new Error('Go module manifest exceeds the 1 MiB inventory limit.')
  const bytes = await readFile(resolveArtifactStoragePath(manifest.storagePath))
  const manifestSha256 = digest(bytes)
  if (bytes.length !== Number(manifest.sizeBytes) || manifestSha256 !== manifest.sha256.toLowerCase()) {
    throw new Error('The imported go.mod changed or no longer matches the workspace; reimport it before inventory.')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('The imported go.mod is not valid UTF-8 text.')
  }
  const moduleDirective = text.match(/^\s*module\s+(?:"([^"\r\n]+)"|([^\s\r\n]+))\s*(?:\/\/[^\r\n]*)?\s*$/m)
  const modulePath = moduleDirective?.[1] || moduleDirective?.[2] || ''
  if (!modulePath || modulePath.includes('\\') || modulePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('The imported go.mod has no valid module path for Go project inventory.')
  }
  const sumPath = moduleRoot ? `${moduleRoot}/go.sum` : 'go.sum'
  const sumArtifact = await prisma.artifact.findFirst({
    where: { ...artifactWhere, relativePath: { equals: sumPath, mode: 'insensitive' } },
    select: { storagePath: true, sizeBytes: true, sha256: true },
  })
  let sumText = ''
  let sumSha256 = ''
  if (sumArtifact) {
    if (sumArtifact.sizeBytes > BigInt(MAX_GO_MODULE_MANIFEST_BYTES)) throw new Error('Go checksum manifest exceeds the 1 MiB inventory limit.')
    const sumBytes = await readFile(resolveArtifactStoragePath(sumArtifact.storagePath))
    sumSha256 = digest(sumBytes)
    if (sumBytes.length !== Number(sumArtifact.sizeBytes) || sumSha256 !== sumArtifact.sha256.toLowerCase()) {
      throw new Error('The imported go.sum changed or no longer matches the workspace; reimport it before inventory.')
    }
    try {
      sumText = new TextDecoder('utf-8', { fatal: true }).decode(sumBytes)
    } catch {
      throw new Error('The imported go.sum is not valid UTF-8 text.')
    }
  }
  return { modulePath, moduleRoot, manifestSha256, manifestText: text, sumSha256, sumText }
}

async function loadGoModuleSourceSnapshots(
  artifactWhere: Prisma.ArtifactWhereInput,
  files: GoPackageRenameFile[],
): Promise<{ modules: GoModuleSourceSnapshot[]; unassignedPaths: string[] }> {
  const manifests = await prisma.artifact.findMany({
    where: { ...artifactWhere, relativePath: { endsWith: 'go.mod', mode: 'insensitive' } },
    orderBy: [{ relativePath: 'asc' }, { id: 'asc' }], take: 128,
    select: { relativePath: true },
  })
  const roots = [...new Set(manifests.map((manifest) => goModuleRoot(manifest.relativePath)))].sort((left, right) => right.length - left.length)
  const grouped = new Map(roots.map((root) => [root, [] as GoPackageRenameFile[]]))
  const unassignedPaths: string[] = []
  for (const file of files) {
    const root = roots.find((candidate) => !candidate || file.relativePath.startsWith(`${candidate}/`))
    if (root === undefined) {
      unassignedPaths.push(file.relativePath)
      continue
    }
    grouped.get(root)?.push(file)
  }
  const modules: GoModuleSourceSnapshot[] = []
  for (const [root, moduleFiles] of grouped) {
    if (!moduleFiles.length) continue
    let context: GoModuleInventoryContext
    try {
      context = await loadGoModuleInventoryContext(artifactWhere, moduleFiles.map((file) => file.relativePath))
    } catch {
      unassignedPaths.push(...moduleFiles.map((file) => file.relativePath))
      continue
    }
    if (context.moduleRoot !== root || !context.modulePath || !context.manifestSha256) {
      unassignedPaths.push(...moduleFiles.map((file) => file.relativePath))
      continue
    }
    modules.push({ context, files: moduleFiles })
  }
  return { modules, unassignedPaths }
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function digest(source: Buffer): string {
  return createHash('sha256').update(source).digest('hex')
}

async function listPythonRenameBindings(sourceCode: string): Promise<SafeRenameCatalog> {
  const response = await agentFetch('/reamon/code/python/bindings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_code: sourceCode }),
  }, { timeoutMs: 30_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
  if (!response.ok || typeof payload?.source_sha256 !== 'string' || payload.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
      || bindings.length > 5_000 || typeof payload.truncated !== 'boolean'
      || !bindings.every((value) => {
        const binding = plainObject(value)
        return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
          && typeof binding.name === 'string' && binding.name.length > 0 && binding.name.length <= 256
          && typeof binding.kind === 'string' && binding.kind.length <= 80
          && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
          && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
          && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) >= 0
          && binding.exported === false
      })) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Python refactoring service returned an invalid binding catalog')
  }
  return {
    sourceSha256: payload.source_sha256,
    bindings: bindings as SafeRenameBinding[],
    truncated: payload.truncated,
  }
}

async function applyPythonRenameBindings(
  sourceCode: string,
  expectedSha256: string,
  renames: Array<{ bindingId: string; newName: string }>,
): Promise<SafeRenameResult> {
  const response = await agentFetch('/reamon/code/python/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_code: sourceCode,
      expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })),
    }),
  }, { timeoutMs: 30_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const sourceCodeResult = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamedBindings = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(sourceCodeResult, 'utf8')) !== outputSha256 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(parserVersion)
      || Buffer.byteLength(sourceCodeResult, 'utf8') > MAX_SOURCE_BYTES || renamedBindings.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Python refactoring service returned an invalid transformed source')
  }
  return {
    sourceCode: sourceCodeResult,
    sourceSha256: expectedSha256,
    outputSha256,
    parserVersion,
    renamedBindings: renamedBindings as SafeRenameResult['renamedBindings'],
  }
}

async function refactorPhpBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/php/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 120_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 200
        || payload?.parser_version !== '2026.10.07.0'
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[a-z_][A-Za-z0-9_]{0,127}$/.test(binding.name)
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Phpactor returned an invalid binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: Boolean(payload.truncated) }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || payload?.parser_version !== '2026.10.07.0'
      || payload?.validation_status !== 'PASSED' || typeof payload.validation_method !== 'string'
      || !/^php-\d+\.\d+(?:\.\d+)?-syntax-check$/.test(payload.validation_method)
      || typeof payload.validation_message !== 'string'
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Phpactor returned invalid transformed PHP source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion: String(payload.parser_version), renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorRubyBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/ruby/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 120_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 200
        || payload?.parser_version !== '0.60.4'
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.name)
            && ['variable', 'parameter'].includes(String(binding.kind))
            && binding.scopeType === 'local'
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Solargraph returned an invalid Ruby binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: payload.truncated }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || payload?.parser_version !== '0.60.4'
      || payload?.validation_status !== 'PASSED' || typeof payload.validation_method !== 'string'
      || !/^ruby-\d+\.\d+(?:\.\d+)?-syntax-check$/.test(payload.validation_method)
      || typeof payload.validation_message !== 'string'
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Solargraph returned invalid transformed Ruby source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion: '0.60.4', renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function listGoRenameBindings(sourceCode: string): Promise<SafeRenameCatalog> {
  const response = await agentFetch('/reamon/code/go/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'bindings', source_code: sourceCode }),
  }, { timeoutMs: 30_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
  if (!response.ok || typeof payload?.source_sha256 !== 'string' || payload.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
      || bindings.length > 5_000 || typeof payload.truncated !== 'boolean'
      || typeof payload.parser_version !== 'string' || !/^go\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(payload.parser_version)
      || !bindings.every((value) => {
        const binding = plainObject(value)
        return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
          && typeof binding.name === 'string' && binding.name.length > 0 && binding.name.length <= 256
          && typeof binding.kind === 'string' && binding.kind.length <= 80
          && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
          && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
          && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) >= 0
          && binding.exported === false
      })) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Go refactoring service returned an invalid binding catalog')
  }
  return { sourceSha256: payload.source_sha256, bindings: bindings as SafeRenameBinding[], truncated: payload.truncated }
}

async function applyGoRenameBindings(
  sourceCode: string,
  expectedSha256: string,
  renames: Array<{ bindingId: string; newName: string }>,
): Promise<SafeRenameResult> {
  const response = await agentFetch('/reamon/code/go/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: 'rename', source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })),
    }),
  }, { timeoutMs: 30_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || !/^go\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(parserVersion)
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Go refactoring service returned an invalid transformed source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion, renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

interface GoProjectRenameResult extends SafeRenameResult {
  sourceSetSha256: string
  outputSourceSetSha256: string
  inventoryScopeSha256?: string
  outputInventoryScopeSha256?: string
  scope: 'project' | 'module'
  downstreamCompatibility?: {
    status: 'not_required' | 'not_supplied' | 'no_consumers' | 'incomplete' | 'partial' | 'checked'
    checkedModules: number
    buildGOOS?: string
    buildGOARCH?: string
    checkedBuildContexts?: Array<{ goos: string; goarch: string; buildTags: string[] }>
  }
  projectFiles: Array<{ relativePath: string; sourceCode: string; inputSha256: string; outputSha256: string; edits: Array<{ start: number; end: number; oldText: string; newText: string }> }>
}

interface GoProjectRenameCatalog {
  sourceSha256: string
  sourceSetSha256: string
  selectedPath: string
  bindings: SafeRenameBinding[]
  truncated: boolean
  inventory?: GoProjectInventory
  inventoryScopeSha256?: string
}

interface GoProjectRenameSelection {
  bindingId: string
  oldName: string
  newName: string
  kind: string
  referenceCount: number
  scopeType: string
}

interface GoProjectInventory {
  scope: 'reviewed-same-directory-go-package-source-snapshot' | 'verified-whole-project-go-source-snapshot'
  complete: boolean
  sourceFileCount: number
  packageCount: number
  privatePackageSymbolCount: number
  referencedPrivatePackageSymbols: number
  unreferencedPrivateSymbols: number
  exportedPackageSymbolCount: number
  unsupportedPackageSymbolCount: number
  fileScopeSymbolCount: number
  referencedFileScopeSymbols: number
  unreferencedFileScopeSymbols: number
  unsupportedFileScopeSymbolCount: number
  localSymbolCount: number
  referencedLocalSymbols: number
  unreferencedLocalSymbols: number
  unsupportedLocalSymbolCount: number
  memberSymbolCount: number
  unsupportedMemberSymbolCount: number
  renameBindingCatalogTruncated: boolean
  entryCount: number
  entriesTruncated: boolean
  entries: GoProjectInventoryEntry[]
}

interface GoProjectInventoryEntry {
  id: string
  name: string
  kind: string
  scope: 'package' | 'file' | 'local' | 'member'
  relativePath: string
  declarationStart: number
  referenceCount: number
  exported: boolean
  classification: 'eligible' | 'excluded' | 'unsupported'
  classificationReason: string
  nameAssessment: 'unassessed'
}

function isValidGoProjectInventoryEntry(entry: Record<string, unknown>, sourceByPath: Map<string, string>): boolean {
  const source = typeof entry.relativePath === 'string' ? sourceByPath.get(entry.relativePath) : undefined
  if (!/^[a-f0-9]{24}$/i.test(String(entry.id || ''))
      || typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.length > 256
      || typeof entry.kind !== 'string' || entry.kind.length === 0 || entry.kind.length > 80
      || source === undefined || !Number.isSafeInteger(entry.declarationStart) || Number(entry.declarationStart) < 0
      || Number(entry.declarationStart) > Buffer.byteLength(source, 'utf8')
      || !Number.isSafeInteger(entry.referenceCount) || Number(entry.referenceCount) < 0
      || typeof entry.exported !== 'boolean' || !['package', 'file', 'local', 'member'].includes(String(entry.scope))
      || !['eligible', 'excluded', 'unsupported'].includes(String(entry.classification))
      || typeof entry.classificationReason !== 'string' || entry.classificationReason.length === 0 || entry.classificationReason.length > 128
      || entry.nameAssessment !== 'unassessed') return false
  if (entry.scope === 'package') {
    if (entry.classification === 'eligible') {
      return !entry.exported && Number(entry.referenceCount) > 0
        && ['package function', 'package type', 'package variable', 'package constant'].includes(entry.kind)
        && entry.classificationReason === 'private-package-symbol-with-resolved-references'
    }
    if (entry.classification === 'excluded') {
      return entry.exported
        ? entry.classificationReason === 'exported-package-api'
        : Number(entry.referenceCount) === 0 && entry.classificationReason === 'unreferenced-package-symbol'
    }
    return ['program-entrypoint', 'unsupported-package-object-kind', 'special-initialization-function'].includes(entry.classificationReason)
  }
  if (entry.scope === 'file') {
    if (entry.exported) return false
    if (entry.kind === 'file import alias') {
      if (entry.classification === 'eligible') {
        return Number(entry.referenceCount) > 0 && entry.classificationReason === 'file-import-alias-with-resolved-references'
      }
      return entry.classification === 'excluded' && Number(entry.referenceCount) === 0
        && entry.classificationReason === 'unreferenced-file-import-alias'
    }
    return (entry.kind === 'dot import' && entry.classification === 'unsupported'
      && entry.classificationReason === 'dot-import-out-of-scope')
      || (entry.kind === 'unsupported file-scope object' && entry.classification === 'unsupported'
        && entry.classificationReason === 'unsupported-file-scope-object-kind')
  }
  if (entry.scope === 'member') {
    return entry.classification === 'unsupported'
      && ['struct field', 'method', 'interface method', 'type parameter'].includes(String(entry.kind))
      && entry.classificationReason === 'go-member-not-offered-by-project-inventory'
  }
  if (entry.exported) return false
  const supportedLocalKinds = ['local variable', 'local constant', 'local type', 'local type parameter', 'local function', 'local type-switch variable']
  if (entry.classification === 'eligible') {
    return supportedLocalKinds.includes(String(entry.kind)) && Number(entry.referenceCount) > 0
      && entry.classificationReason === 'local-symbol-with-resolved-references'
  }
  if (entry.classification === 'excluded') {
    return supportedLocalKinds.includes(String(entry.kind)) && Number(entry.referenceCount) === 0
      && entry.classificationReason === 'unreferenced-local-symbol'
  }
  return (entry.kind === 'local struct field' && entry.classificationReason === 'local-struct-field-out-of-scope')
    || (entry.kind === 'local interface method' && entry.classificationReason === 'local-interface-method-out-of-scope')
    || (entry.kind === 'local label' && entry.classificationReason === 'local-label-out-of-scope')
    || (entry.kind === 'unsupported local object' && entry.classificationReason === 'unsupported-local-object-kind')
}

async function listGoProjectRenameBindings(files: GoPackageRenameFile[], selectedPath: string, module: GoModuleInventoryContext): Promise<GoProjectRenameCatalog> {
  const selected = files.find((file) => file.relativePath === selectedPath)
  if (!selected) throw new Error('Selected Go source is missing from the verified package snapshot')
  const response = await agentFetch('/reamon/code/go/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: 'project_bindings', source_code: selected.sourceCode, selected_path: selectedPath,
      module_path: module.modulePath, module_root: module.moduleRoot,
      go_mod: module.manifestText, go_mod_sha256: module.manifestSha256,
      go_sum: module.sumText, go_sum_sha256: module.sumSha256,
      files: files.map((file) => ({ relative_path: file.relativePath, source_code: file.sourceCode, expected_sha256: file.sourceHash })),
    }),
  }, { timeoutMs: 60_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
  const rawInventory = plainObject(payload?.inventory)
  const rawEntries = Array.isArray(rawInventory.entries) ? rawInventory.entries.map(plainObject) : []
  const inventory = {
    scope: rawInventory.scope,
    complete: rawInventory.complete ?? true,
    sourceFileCount: rawInventory.source_file_count,
    packageCount: rawInventory.package_count ?? 1,
    privatePackageSymbolCount: rawInventory.private_package_symbol_count,
    referencedPrivatePackageSymbols: rawInventory.referenced_private_package_symbols,
    unreferencedPrivateSymbols: rawInventory.unreferenced_private_symbols,
    exportedPackageSymbolCount: rawInventory.exported_package_symbol_count,
    unsupportedPackageSymbolCount: rawInventory.unsupported_package_symbol_count,
    fileScopeSymbolCount: rawInventory.file_scope_symbol_count,
    referencedFileScopeSymbols: rawInventory.referenced_file_scope_symbols,
    unreferencedFileScopeSymbols: rawInventory.unreferenced_file_scope_symbols,
    unsupportedFileScopeSymbolCount: rawInventory.unsupported_file_scope_symbol_count,
    localSymbolCount: rawInventory.local_symbol_count,
    referencedLocalSymbols: rawInventory.referenced_local_symbols,
    unreferencedLocalSymbols: rawInventory.unreferenced_local_symbols,
    unsupportedLocalSymbolCount: rawInventory.unsupported_local_symbol_count,
    memberSymbolCount: rawInventory.member_symbol_count ?? 0,
    unsupportedMemberSymbolCount: rawInventory.unsupported_member_symbol_count ?? 0,
    renameBindingCatalogTruncated: rawInventory.rename_binding_catalog_truncated,
    entryCount: rawInventory.entry_count,
    entriesTruncated: rawInventory.entries_truncated,
    entries: rawEntries,
  }
  const listedFiles = Array.isArray(payload?.files) ? payload.files.map(plainObject) : []
  const expectedFiles = [...files].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
  const sourceByPath = new Map(files.map((file) => [file.relativePath, file.sourceCode]))
  const expectedSourceSetSha256 = hashGoPackageSourceSet(files)
  const inventoryRowCounts = {
    eligible: inventory.entries.filter((entry) => entry.classification === 'eligible').length,
    excluded: inventory.entries.filter((entry) => entry.classification === 'excluded').length,
    unsupported: inventory.entries.filter((entry) => entry.classification === 'unsupported').length,
  }
  const inventoryRowsMatchCounts = inventory.entriesTruncated
    ? inventoryRowCounts.eligible <= Number(inventory.referencedPrivatePackageSymbols) + Number(inventory.referencedFileScopeSymbols) + Number(inventory.referencedLocalSymbols)
      && inventoryRowCounts.excluded <= Number(inventory.unreferencedPrivateSymbols) + Number(inventory.exportedPackageSymbolCount) + Number(inventory.unreferencedFileScopeSymbols) + Number(inventory.unreferencedLocalSymbols)
      && inventoryRowCounts.unsupported <= Number(inventory.unsupportedPackageSymbolCount) + Number(inventory.unsupportedFileScopeSymbolCount) + Number(inventory.unsupportedLocalSymbolCount) + Number(inventory.unsupportedMemberSymbolCount)
    : inventoryRowCounts.eligible === Number(inventory.referencedPrivatePackageSymbols) + Number(inventory.referencedFileScopeSymbols) + Number(inventory.referencedLocalSymbols)
      && inventoryRowCounts.excluded === Number(inventory.unreferencedPrivateSymbols) + Number(inventory.exportedPackageSymbolCount) + Number(inventory.unreferencedFileScopeSymbols) + Number(inventory.unreferencedLocalSymbols)
      && inventoryRowCounts.unsupported === Number(inventory.unsupportedPackageSymbolCount) + Number(inventory.unsupportedFileScopeSymbolCount) + Number(inventory.unsupportedLocalSymbolCount) + Number(inventory.unsupportedMemberSymbolCount)
  if (!response.ok || payload?.source_sha256 !== selected.sourceHash
      || payload?.source_set_sha256 !== expectedSourceSetSha256
      || payload?.selected_path !== selectedPath || typeof payload?.truncated !== 'boolean'
      || inventory.scope !== 'reviewed-same-directory-go-package-source-snapshot'
      || inventory.complete !== true || inventory.packageCount !== 1
      || ![inventory.sourceFileCount, inventory.privatePackageSymbolCount, inventory.referencedPrivatePackageSymbols,
        inventory.unreferencedPrivateSymbols, inventory.exportedPackageSymbolCount, inventory.unsupportedPackageSymbolCount,
        inventory.fileScopeSymbolCount, inventory.referencedFileScopeSymbols, inventory.unreferencedFileScopeSymbols, inventory.unsupportedFileScopeSymbolCount,
        inventory.localSymbolCount, inventory.referencedLocalSymbols, inventory.unreferencedLocalSymbols, inventory.unsupportedLocalSymbolCount,
        inventory.memberSymbolCount, inventory.unsupportedMemberSymbolCount]
        .every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
      || inventory.sourceFileCount !== expectedFiles.length
      || inventory.privatePackageSymbolCount !== Number(inventory.referencedPrivatePackageSymbols) + Number(inventory.unreferencedPrivateSymbols)
      || inventory.fileScopeSymbolCount !== Number(inventory.referencedFileScopeSymbols) + Number(inventory.unreferencedFileScopeSymbols) + Number(inventory.unsupportedFileScopeSymbolCount)
      || inventory.localSymbolCount !== Number(inventory.referencedLocalSymbols) + Number(inventory.unreferencedLocalSymbols) + Number(inventory.unsupportedLocalSymbolCount)
      || inventory.memberSymbolCount !== Number(inventory.unsupportedMemberSymbolCount)
      || typeof inventory.renameBindingCatalogTruncated !== 'boolean'
      || inventory.renameBindingCatalogTruncated !== payload.truncated
      || !Number.isSafeInteger(inventory.entryCount) || Number(inventory.entryCount) < 0
      || Number(inventory.entryCount) !== Number(inventory.privatePackageSymbolCount) + Number(inventory.exportedPackageSymbolCount) + Number(inventory.unsupportedPackageSymbolCount) + Number(inventory.fileScopeSymbolCount) + Number(inventory.localSymbolCount) + Number(inventory.memberSymbolCount)
      || typeof inventory.entriesTruncated !== 'boolean'
      || inventory.entries.length !== Math.min(Number(inventory.entryCount), MAX_GO_PROJECT_INVENTORY_ENTRIES)
      || inventory.entriesTruncated !== (Number(inventory.entryCount) > inventory.entries.length)
      || !inventory.entries.every((entry) => isValidGoProjectInventoryEntry(entry, sourceByPath))
      || new Set(inventory.entries.map((entry) => entry.id)).size !== inventory.entries.length
      || !inventoryRowsMatchCounts
      || typeof payload?.parser_version !== 'string' || !/^go\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(payload.parser_version)
      || listedFiles.length !== expectedFiles.length || listedFiles.some((file, index) =>
        file.relative_path !== expectedFiles[index].relativePath || file.source_sha256 !== expectedFiles[index].sourceHash)
      || !bindings.every((value) => {
        const binding = plainObject(value)
        return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
          && typeof binding.name === 'string' && binding.name.length > 0 && binding.name.length <= 256
          && typeof binding.kind === 'string' && binding.kind.length <= 80
          && (binding.scopeType === 'package' || (binding.scopeType === 'member' && binding.kind === 'method')
            || (binding.scopeType === 'file' && binding.kind === 'file import alias'))
          && binding.relativePath === selectedPath
          && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
          && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
          && binding.exported === false
      })) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Go refactoring service returned an invalid project binding catalog')
  }
  return {
    sourceSha256: selected.sourceHash,
    sourceSetSha256: String(payload.source_set_sha256),
    selectedPath,
    bindings: bindings as SafeRenameBinding[],
    truncated: payload.truncated,
    inventory: inventory as unknown as GoProjectInventory,
  }
}

async function listGoModuleRenameBindings(
  files: GoPackageRenameFile[],
  selectedPath: string,
  module: GoModuleInventoryContext,
): Promise<GoProjectRenameCatalog> {
  const selected = files.find((file) => file.relativePath === selectedPath)
  if (!selected || !module.modulePath || !module.manifestSha256) {
    throw new Error('A complete verified Go module snapshot and go.mod receipt are required for module-wide rename')
  }
  const response = await agentFetch('/reamon/code/go/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: 'project_module_bindings', source_code: selected.sourceCode, selected_path: selectedPath,
      module_path: module.modulePath, module_root: module.moduleRoot,
      go_mod: module.manifestText, go_mod_sha256: module.manifestSha256,
      go_sum: module.sumText, go_sum_sha256: module.sumSha256,
      files: files.map((file) => ({ relative_path: file.relativePath, source_code: file.sourceCode, expected_sha256: file.sourceHash })),
    }),
  }, { timeoutMs: 60_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const bindings = Array.isArray(payload?.bindings) ? payload.bindings.map(plainObject) : []
  const listedFiles = Array.isArray(payload?.files) ? payload.files.map(plainObject) : []
  const expectedFiles = [...files].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
  const modulePaths = new Set(expectedFiles.map((file) => file.relativePath))
  const sourceSetSha256 = hashGoPackageSourceSet(files)
  const validBindings = bindings.every((binding) => /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
    && typeof binding.name === 'string' && binding.name.length > 0 && binding.name.length <= 256
    && ((binding.kind === 'method' && binding.scopeType === 'member')
      || (binding.kind === 'file import alias' && binding.scopeType === 'file' && binding.exported === false))
    && (binding.kind === 'method'
      ? binding.relativePath === selectedPath
      : typeof binding.relativePath === 'string' && modulePaths.has(binding.relativePath)
        && typeof binding.importPath === 'string' && binding.importPath.length > 0 && binding.importPath.length <= 512)
    && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
    && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
    && typeof binding.exported === 'boolean')
  if (!response.ok || payload?.scope !== 'verified-go-module-source-snapshot'
      || payload?.source_sha256 !== selected.sourceHash || payload?.source_set_sha256 !== sourceSetSha256
      || payload?.selected_path !== selectedPath || !/^[a-f0-9]{64}$/i.test(String(payload.inventory_scope_sha256 || ''))
      || typeof payload.truncated !== 'boolean'
      || typeof payload.parser_version !== 'string' || !/^go\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(payload.parser_version)
      || listedFiles.length !== expectedFiles.length || listedFiles.some((file, index) =>
        file.relative_path !== expectedFiles[index].relativePath || file.source_sha256 !== expectedFiles[index].sourceHash)
      || !validBindings || new Set(bindings.map((binding) => binding.id)).size !== bindings.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Go refactoring service returned an invalid module binding catalog')
  }
  return {
    sourceSha256: selected.sourceHash, sourceSetSha256, selectedPath,
    bindings: bindings as unknown as SafeRenameBinding[], truncated: payload.truncated,
    inventoryScopeSha256: String(payload.inventory_scope_sha256),
  }
}

async function listGoProjectInventory(
  files: GoPackageRenameFile[],
  selectedPath: string,
  module: GoModuleInventoryContext,
): Promise<GoProjectInventory> {
  const selected = files.find((file) => file.relativePath === selectedPath)
  if (!selected || files.length < 1 || files.length > 256) throw new Error('The complete Go project source snapshot is unavailable or exceeds its file limit')
  const response = await agentFetch('/reamon/code/go/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: 'project_inventory', source_code: selected.sourceCode, selected_path: selectedPath,
      module_path: module.modulePath, module_root: module.moduleRoot,
      go_mod: module.manifestText, go_mod_sha256: module.manifestSha256,
      go_sum: module.sumText, go_sum_sha256: module.sumSha256,
      files: files.map((file) => ({ relative_path: file.relativePath, source_code: file.sourceCode, expected_sha256: file.sourceHash })),
    }),
  }, { timeoutMs: 60_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const raw = plainObject(payload?.inventory)
  const entries = Array.isArray(raw.entries) ? raw.entries.map(plainObject) : []
  const listedFiles = Array.isArray(payload?.files) ? payload.files.map(plainObject) : []
  const packages = Array.isArray(payload?.packages) ? payload.packages.map(plainObject) : []
  const sourceByPath = new Map(files.map((file) => [file.relativePath, file.sourceCode]))
  const expectedHash = hashGoPackageSourceSet(files)
  const numericFields = [
    raw.source_file_count, raw.package_count, raw.private_package_symbol_count,
    raw.referenced_private_package_symbols, raw.unreferenced_private_symbols,
    raw.exported_package_symbol_count, raw.unsupported_package_symbol_count,
    raw.file_scope_symbol_count, raw.referenced_file_scope_symbols,
    raw.unreferenced_file_scope_symbols, raw.unsupported_file_scope_symbol_count,
    raw.local_symbol_count, raw.referenced_local_symbols, raw.unreferenced_local_symbols,
    raw.unsupported_local_symbol_count, raw.entry_count,
    raw.member_symbol_count ?? 0, raw.unsupported_member_symbol_count ?? 0,
  ]
  const classCounts = {
    eligible: entries.filter((entry) => entry.classification === 'eligible').length,
    excluded: entries.filter((entry) => entry.classification === 'excluded').length,
    unsupported: entries.filter((entry) => entry.classification === 'unsupported').length,
  }
  const rowsMatchCounts = raw.entries_truncated === true
    ? classCounts.eligible <= Number(raw.referenced_private_package_symbols) + Number(raw.referenced_file_scope_symbols) + Number(raw.referenced_local_symbols)
      && classCounts.excluded <= Number(raw.unreferenced_private_symbols) + Number(raw.exported_package_symbol_count) + Number(raw.unreferenced_file_scope_symbols) + Number(raw.unreferenced_local_symbols)
      && classCounts.unsupported <= Number(raw.unsupported_package_symbol_count) + Number(raw.unsupported_file_scope_symbol_count) + Number(raw.unsupported_local_symbol_count) + Number(raw.unsupported_member_symbol_count ?? 0)
    : classCounts.eligible === Number(raw.referenced_private_package_symbols) + Number(raw.referenced_file_scope_symbols) + Number(raw.referenced_local_symbols)
      && classCounts.excluded === Number(raw.unreferenced_private_symbols) + Number(raw.exported_package_symbol_count) + Number(raw.unreferenced_file_scope_symbols) + Number(raw.unreferenced_local_symbols)
      && classCounts.unsupported === Number(raw.unsupported_package_symbol_count) + Number(raw.unsupported_file_scope_symbol_count) + Number(raw.unsupported_local_symbol_count) + Number(raw.unsupported_member_symbol_count ?? 0)
  const packageCount = Number(raw.package_count)
  const packageFilesCount = packages.reduce((sum, item) => sum + (Number.isSafeInteger(item.source_file_count) ? Number(item.source_file_count) : 0), 0)
  const packageKeys = packages.map((item) => `${String(item.directory)}\0${String(item.package_name)}`)
  if (!response.ok || payload?.source_sha256 !== selected.sourceHash || payload?.source_set_sha256 !== expectedHash
      || payload?.module_path !== module.modulePath || payload?.module_root !== module.moduleRoot
      || payload?.go_mod_sha256 !== module.manifestSha256 || payload?.go_sum_sha256 !== module.sumSha256
      || payload?.selected_path !== selectedPath || raw.scope !== 'verified-whole-project-go-source-snapshot'
      || raw.complete !== true || !numericFields.every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
      || Number(raw.source_file_count) !== files.length || packageCount !== packages.length || packageCount < 1
      || packageFilesCount !== files.length || new Set(packageKeys).size !== packageKeys.length
      || raw.private_package_symbol_count !== Number(raw.referenced_private_package_symbols) + Number(raw.unreferenced_private_symbols)
      || raw.file_scope_symbol_count !== Number(raw.referenced_file_scope_symbols) + Number(raw.unreferenced_file_scope_symbols) + Number(raw.unsupported_file_scope_symbol_count)
      || raw.local_symbol_count !== Number(raw.referenced_local_symbols) + Number(raw.unreferenced_local_symbols) + Number(raw.unsupported_local_symbol_count)
      || Number(raw.member_symbol_count ?? 0) !== Number(raw.unsupported_member_symbol_count ?? 0)
      || raw.entry_count !== Number(raw.private_package_symbol_count) + Number(raw.exported_package_symbol_count) + Number(raw.unsupported_package_symbol_count) + Number(raw.file_scope_symbol_count) + Number(raw.local_symbol_count) + Number(raw.member_symbol_count ?? 0)
      || typeof raw.entries_truncated !== 'boolean' || entries.length !== Math.min(Number(raw.entry_count), MAX_GO_PROJECT_INVENTORY_ENTRIES)
      || raw.entries_truncated !== (Number(raw.entry_count) > entries.length)
      || !entries.every((entry) => isValidGoProjectInventoryEntry(entry, sourceByPath))
      || new Set(entries.map((entry) => entry.id)).size !== entries.length || !rowsMatchCounts
      || listedFiles.length !== files.length || listedFiles.some((file, index) =>
        file.relative_path !== files[index].relativePath || file.source_sha256 !== files[index].sourceHash)
      || !packages.every((item) => typeof item.directory === 'string' && typeof item.package_name === 'string'
        && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.package_name)
        && Number.isSafeInteger(item.source_file_count) && Number(item.source_file_count) > 0
        && /^[a-f0-9]{64}$/i.test(String(item.source_set_sha256)))
      || typeof payload?.parser_version !== 'string' || !/^go\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(payload.parser_version)) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Go refactoring service returned an invalid whole-project inventory')
  }
  return {
    scope: 'verified-whole-project-go-source-snapshot', complete: true,
    sourceFileCount: files.length, packageCount,
    privatePackageSymbolCount: Number(raw.private_package_symbol_count),
    referencedPrivatePackageSymbols: Number(raw.referenced_private_package_symbols),
    unreferencedPrivateSymbols: Number(raw.unreferenced_private_symbols),
    exportedPackageSymbolCount: Number(raw.exported_package_symbol_count),
    unsupportedPackageSymbolCount: Number(raw.unsupported_package_symbol_count),
    fileScopeSymbolCount: Number(raw.file_scope_symbol_count),
    referencedFileScopeSymbols: Number(raw.referenced_file_scope_symbols),
    unreferencedFileScopeSymbols: Number(raw.unreferenced_file_scope_symbols),
    unsupportedFileScopeSymbolCount: Number(raw.unsupported_file_scope_symbol_count),
    localSymbolCount: Number(raw.local_symbol_count),
    referencedLocalSymbols: Number(raw.referenced_local_symbols),
    unreferencedLocalSymbols: Number(raw.unreferenced_local_symbols),
    unsupportedLocalSymbolCount: Number(raw.unsupported_local_symbol_count),
    memberSymbolCount: Number(raw.member_symbol_count ?? 0),
    unsupportedMemberSymbolCount: Number(raw.unsupported_member_symbol_count ?? 0),
    renameBindingCatalogTruncated: false,
    entryCount: Number(raw.entry_count), entriesTruncated: Boolean(raw.entries_truncated),
    entries: entries as unknown as GoProjectInventoryEntry[],
  }
}

async function applyGoProjectRenameBindings(
  files: GoPackageRenameFile[],
  selectedPath: string,
  expectedSha256: string,
  expectedSourceSetSha256: string,
  module: GoModuleInventoryContext,
  renames: GoProjectRenameSelection[],
  renameScope: 'project' | 'module' = 'project',
  expectedInventoryScopeSha256?: string,
  downstreamModules: GoDownstreamModuleCheck[] = [],
  downstreamModulesComplete = false,
): Promise<GoProjectRenameResult> {
  const selected = files.find((file) => file.relativePath === selectedPath)
  if (!selected) throw new Error('Selected Go source is missing from the verified package snapshot')
  if (hashGoPackageSourceSet(files) !== expectedSourceSetSha256) {
    throw new Error('The Go package source-set hash does not match the verified snapshot')
  }
  const response = await agentFetch('/reamon/code/go/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: renameScope === 'module' ? 'project_module_rename' : 'project_rename',
      source_code: selected.sourceCode, expected_sha256: expectedSha256,
      source_set_sha256: expectedSourceSetSha256, selected_path: selectedPath,
      module_path: module.modulePath, module_root: module.moduleRoot,
      go_mod: module.manifestText, go_mod_sha256: module.manifestSha256,
      go_sum: module.sumText, go_sum_sha256: module.sumSha256,
      files: files.map((file) => ({ relative_path: file.relativePath, source_code: file.sourceCode, expected_sha256: file.sourceHash })),
      ...(renameScope === 'module' ? { downstream_modules: downstreamModules, downstream_modules_complete: downstreamModulesComplete } : {}),
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })),
    }),
  }, { timeoutMs: 60_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const projectFiles = Array.isArray(payload?.files) ? payload.files : []
  const payloadInventoryScopeSha256 = typeof payload?.inventory_scope_sha256 === 'string' ? payload.inventory_scope_sha256 : ''
  const outputInventoryScopeSha256 = typeof payload?.output_inventory_scope_sha256 === 'string' ? payload.output_inventory_scope_sha256 : ''
  const rawDownstreamCompatibility = plainObject(payload?.downstream_compatibility)
  const downstreamStatus = rawDownstreamCompatibility.status
  const downstreamCheckedModules = rawDownstreamCompatibility.checked_modules
  const checkedBuildContexts = (Array.isArray(rawDownstreamCompatibility.checked_build_contexts) ? rawDownstreamCompatibility.checked_build_contexts : [])
    .map(plainObject)
    .map((context) => ({
      goos: typeof context.goos === 'string' ? context.goos : '',
      goarch: typeof context.goarch === 'string' ? context.goarch : '',
      buildTags: Array.isArray(context.build_tags) ? context.build_tags.filter((tag): tag is string => typeof tag === 'string') : [],
      validTags: Array.isArray(context.build_tags) && context.build_tags.every((tag) => typeof tag === 'string'),
    }))
  const downstreamCompatibilityValid = ['not_required', 'not_supplied', 'no_consumers', 'incomplete', 'partial', 'checked'].includes(String(downstreamStatus))
    && Number.isSafeInteger(downstreamCheckedModules) && Number(downstreamCheckedModules) >= 0
    && checkedBuildContexts.every((context) => /^[a-z0-9]+$/.test(context.goos) && /^[a-z0-9]+$/.test(context.goarch) && context.validTags)
    && (!['checked', 'partial'].includes(String(downstreamStatus)) || checkedBuildContexts.length > 0)
  if (renameScope === 'module' && !response.ok && typeof payload?.error === 'string'
      && (payload.error.startsWith('Go rename breaks downstream module') || payload.error.startsWith('cannot verify downstream compatibility'))) {
    throw new GoModuleCompatibilityError(payload.error)
  }
  const expectedByPath = new Map(files.map((file) => [file.relativePath, file]))
  const seenPaths = new Set<string>()
  const renamePairs = new Set(renames.map((rename) => `${rename.oldName}\0${rename.newName}`))
  const validatedFiles = projectFiles.flatMap((value) => {
    const file = plainObject(value)
    const relativePath = typeof file.relative_path === 'string' ? file.relative_path : ''
    const sourceCode = typeof file.source_code === 'string' ? file.source_code : ''
    const inputSha256 = typeof file.input_sha256 === 'string' ? file.input_sha256 : ''
    const outputFileSha256 = typeof file.output_sha256 === 'string' ? file.output_sha256 : ''
    const original = expectedByPath.get(relativePath)
    const editValues = Array.isArray(file.edits) ? file.edits : []
    const originalBytes = original ? Buffer.from(original.sourceCode, 'utf8') : Buffer.alloc(0)
    if (!original || seenPaths.has(relativePath) || inputSha256 !== original.sourceHash || !/^[a-f0-9]{64}$/i.test(outputFileSha256)
        || digest(Buffer.from(sourceCode, 'utf8')) !== outputFileSha256
        || Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES
        || !editValues.length) return []
    const edits = editValues.map(plainObject).map((edit) => ({
      start: edit.start,
      end: edit.end,
      oldText: edit.old_text,
      newText: edit.new_text,
    }))
    if (!edits.every((edit) => Number.isSafeInteger(edit.start) && Number(edit.start) >= 0
        && Number.isSafeInteger(edit.end) && Number(edit.end) > Number(edit.start)
        && typeof edit.oldText === 'string' && edit.oldText.length > 0
        && typeof edit.newText === 'string' && edit.newText.length > 0
        && renamePairs.has(`${edit.oldText}\0${edit.newText}`))) return []
    const orderedEdits = edits.sort((left, right) => Number(left.start) - Number(right.start))
    const outputChunks: Buffer[] = []
    let previousEnd = 0
    for (const edit of orderedEdits) {
      const start = Number(edit.start)
      const end = Number(edit.end)
      const oldBytes = Buffer.from(String(edit.oldText), 'utf8')
      if (start < previousEnd || end > originalBytes.length || end - start !== oldBytes.length
          || !originalBytes.subarray(start, end).equals(oldBytes)) return []
      outputChunks.push(originalBytes.subarray(previousEnd, start), Buffer.from(String(edit.newText), 'utf8'))
      previousEnd = end
    }
    outputChunks.push(originalBytes.subarray(previousEnd))
    const reconstructedBytes = Buffer.concat(outputChunks)
    if (!reconstructedBytes.equals(Buffer.from(sourceCode, 'utf8'))) return []
    seenPaths.add(relativePath)
    return [{
      relativePath, sourceCode, inputSha256, outputSha256: outputFileSha256,
      edits: orderedEdits.map((edit) => ({
        start: Number(edit.start), end: Number(edit.end), oldText: String(edit.oldText), newText: String(edit.newText),
      })),
    }]
  })
  const selectedOutput = validatedFiles.find((file) => file.relativePath === selectedPath)?.sourceCode
    ?? expectedByPath.get(selectedPath)?.sourceCode
  const renamedById = new Map(renamed.flatMap((value) => {
    const item = plainObject(value)
    return typeof item.bindingId === 'string' ? [[item.bindingId, item] as const] : []
  }))
  const outputHashesByPath = new Map(validatedFiles.map((file) => [file.relativePath, file.outputSha256]))
  const computedOutputSourceSetSha256 = hashGoPackageSourceSet(files.map((file) => ({
    relativePath: file.relativePath,
    sourceHash: outputHashesByPath.get(file.relativePath) || file.sourceHash,
  })))
  if (!response.ok || payload?.scope !== renameScope || payload?.source_sha256 !== expectedSha256
      || payload?.source_set_sha256 !== expectedSourceSetSha256
      || payload?.output_source_set_sha256 !== computedOutputSourceSetSha256
      || (renameScope === 'module' && (payloadInventoryScopeSha256 !== expectedInventoryScopeSha256
        || !/^[a-f0-9]{64}$/i.test(outputInventoryScopeSha256) || !downstreamCompatibilityValid))
      || !/^[a-f0-9]{64}$/i.test(outputSha256) || digest(Buffer.from(output, 'utf8')) !== outputSha256
      || output !== selectedOutput || !/^go\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(parserVersion)
      || renamed.length !== renames.length || renamedById.size !== renamed.length || !renames.every((rename) => {
        const item = renamedById.get(rename.bindingId)
        return item?.oldName === rename.oldName && item.newName === rename.newName
          && item.kind === rename.kind && item.referenceCount === rename.referenceCount && item.scopeType === rename.scopeType
      }) || !validatedFiles.length || validatedFiles.length !== projectFiles.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Go refactoring service returned an invalid project edit manifest')
  }
  return {
    sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion,
    renamedBindings: renamed as SafeRenameResult['renamedBindings'],
    sourceSetSha256: expectedSourceSetSha256,
    outputSourceSetSha256: String(payload.output_source_set_sha256), scope: renameScope,
    ...(renameScope === 'module' ? { inventoryScopeSha256: payloadInventoryScopeSha256, outputInventoryScopeSha256 } : {}),
    ...(renameScope === 'module' ? { downstreamCompatibility: {
      status: downstreamStatus as NonNullable<GoProjectRenameResult['downstreamCompatibility']>['status'],
      checkedModules: Number(downstreamCheckedModules),
      ...(typeof rawDownstreamCompatibility.build_goos === 'string' ? { buildGOOS: rawDownstreamCompatibility.build_goos } : {}),
      ...(typeof rawDownstreamCompatibility.build_goarch === 'string' ? { buildGOARCH: rawDownstreamCompatibility.build_goarch } : {}),
      ...(checkedBuildContexts.length ? { checkedBuildContexts: checkedBuildContexts.map(({ goos, goarch, buildTags }) => ({ goos, goarch, buildTags })) } : {}),
    } } : {}),
    projectFiles: validatedFiles,
  }
}

async function loadVerifiedGoPackageSnapshot(input: {
  projectId: string
  artifactId: string
  taskId: string
  runKey: string
  selectedUnitId: string
  selectedPath: string
  selectedSource: string
  selectedArtifactSourceSha256: string
}): Promise<GoPackageRenameFile[]> {
  if (!isSafeGoPackagePath(input.selectedPath)) {
    throw new GoPackageRenameSnapshotError('Selected Go package path is invalid.')
  }
  const unitRows = await prisma.reamonObservation.findMany({
    where: { projectId: input.projectId, artifactId: input.artifactId, taskId: input.taskId, type: 'code_unit' },
    orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
    take: 5001,
    select: { id: true, label: true, attributes: true },
  })
  if (unitRows.length > 5000) throw new GoPackageRenameSnapshotError('This Go run exceeds the bounded package source inventory.', 413)
  const selectedDirectory = path.posix.dirname(input.selectedPath)
  const packageUnits = unitRows.flatMap((unit) => {
    const attributes = plainObject(unit.attributes)
    const language = typeof attributes.language === 'string' ? attributes.language.trim().toLowerCase() : ''
    const relativePath = typeof attributes.relativePath === 'string' ? attributes.relativePath : ''
    if (!['go', 'golang'].includes(language) || !isSafeGoPackagePath(relativePath)
        || path.posix.dirname(relativePath) !== selectedDirectory) return []
    const codeArtifactId = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
    if (codeArtifactId !== `${input.runKey}/sources/${relativePath}`) {
      throw new GoPackageRenameSnapshotError(`Go source path for ${relativePath} does not match this analysis run.`)
    }
    return [{
      unitId: unit.id,
      unitName: (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
        || (typeof attributes.name === 'string' && attributes.name) || unit.label || relativePath,
      relativePath,
      codeArtifactId,
    }]
  })
  const unitIds = packageUnits.map((unit) => unit.unitId)
  const acceptedRows = unitIds.length ? await prisma.reamonMaintainedSource.findMany({
    where: { projectId: input.projectId, artifactId: input.artifactId, codeUnitId: { in: unitIds }, acceptedReviewId: { not: null } },
    orderBy: [{ relativePath: 'asc' }, { codeUnitId: 'asc' }],
    take: 257,
    select: { codeUnitId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, relativePath: true },
  }) : []
  if (acceptedRows.length > 256) throw new GoPackageRenameSnapshotError('The Go package has too many accepted source files for safe rename.', 413)
  const reviewIds = acceptedRows.flatMap((source) => source.acceptedReviewId ? [source.acceptedReviewId] : [])
  const reviews = reviewIds.length ? await prisma.reamonCodeReview.findMany({
    where: { projectId: input.projectId, artifactId: input.artifactId, id: { in: reviewIds }, decision: 'ACCEPTED' },
    select: { id: true, codeUnitId: true, maintainedSourceHash: true, decision: true },
  }) : []
  const rootRealPath = await realpath(derivedArtifactRoot())
  const artifactHashes = new Map<string, string>()
  for (const unit of packageUnits) {
    const candidate = resolveDerivedArtifactPath(unit.codeArtifactId)
    const safePath = await realpath(candidate).catch(() => null)
    if (!safePath || !isInside(rootRealPath, safePath)) {
      throw new GoPackageRenameSnapshotError(`Linked Go source ${unit.relativePath} is unavailable or outside derived storage.`)
    }
    const info = await stat(safePath)
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) {
      throw new GoPackageRenameSnapshotError(`Linked Go source ${unit.relativePath} exceeds the package snapshot limit.`, 413)
    }
    const bytes = await readFile(safePath)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new GoPackageRenameSnapshotError(`Linked Go source ${unit.relativePath} is not UTF-8 text.`)
    }
    const sourceSha256 = digest(bytes)
    if (unit.unitId === input.selectedUnitId && sourceSha256 !== input.selectedArtifactSourceSha256) {
      throw new GoPackageRenameSnapshotError('The selected Go source changed while the package snapshot was loaded.')
    }
    artifactHashes.set(unit.unitId, sourceSha256)
  }
  const snapshot = buildGoPackageRenameSnapshot({
    selectedUnitId: input.selectedUnitId,
    selectedPath: input.selectedPath,
    selectedSource: input.selectedSource,
    units: packageUnits,
    acceptedSources: acceptedRows.map((source) => ({
      codeUnitId: source.codeUnitId,
      relativePath: source.relativePath,
      sourceCode: source.sourceCode,
      sourceHash: source.sourceHash,
      acceptedReviewId: source.acceptedReviewId,
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      codeUnitId: review.codeUnitId,
      maintainedSourceHash: review.maintainedSourceHash,
      decision: review.decision,
    })),
  })
  return snapshot.map((file) => ({ ...file, artifactSourceSha256: artifactHashes.get(file.codeUnitId) }))
}

async function loadVerifiedGoProjectSnapshot(input: {
  projectId: string
  artifactId: string
  taskId: string
  runKey: string
  selectedUnitId: string
  selectedPath: string
  selectedSource: string
  selectedArtifactSourceSha256: string
}): Promise<GoPackageRenameFile[]> {
  const unitRows = await prisma.reamonObservation.findMany({
    where: { projectId: input.projectId, artifactId: input.artifactId, taskId: input.taskId, type: 'code_unit' },
    orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
    take: 5001,
    select: { id: true, label: true, attributes: true },
  })
  if (unitRows.length > 5000) throw new GoPackageRenameSnapshotError('This Go run exceeds the bounded whole-project source inventory.', 413)
  const units = unitRows.flatMap((unit) => {
    const attributes = plainObject(unit.attributes)
    const language = typeof attributes.language === 'string' ? attributes.language.trim().toLowerCase() : ''
    if (!['go', 'golang'].includes(language)) return []
    const relativePath = typeof attributes.relativePath === 'string' ? attributes.relativePath : ''
    if (!isSafeGoPackagePath(relativePath)) {
      throw new GoPackageRenameSnapshotError('A Go source in this analysis run has an invalid relative path.')
    }
    const codeArtifactId = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
    if (codeArtifactId !== `${input.runKey}/sources/${relativePath}`) {
      throw new GoPackageRenameSnapshotError(`Go source path for ${relativePath} does not match this analysis run.`)
    }
    return [{
      unitId: unit.id,
      unitName: (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
        || (typeof attributes.name === 'string' && attributes.name) || unit.label || relativePath,
      relativePath,
      codeArtifactId,
    }]
  })
  if (!units.some((unit) => unit.unitId === input.selectedUnitId && unit.relativePath === input.selectedPath)) {
    throw new GoPackageRenameSnapshotError('Selected Go source is not part of the complete analysis run.')
  }
  if (units.length > 256) throw new GoPackageRenameSnapshotError('Whole-project Go inventory is limited to 256 source files.', 413)
  const pathCounts = new Set<string>()
  for (const unit of units) {
    const pathKey = unit.relativePath.toLowerCase()
    if (pathCounts.has(pathKey)) throw new GoPackageRenameSnapshotError(`Go project contains duplicate source path ${unit.relativePath}.`)
    pathCounts.add(pathKey)
  }
  const acceptedRows = units.length ? await prisma.reamonMaintainedSource.findMany({
    where: { projectId: input.projectId, artifactId: input.artifactId, codeUnitId: { in: units.map((unit) => unit.unitId) }, acceptedReviewId: { not: null } },
    orderBy: [{ relativePath: 'asc' }, { codeUnitId: 'asc' }],
    take: 257,
    select: { codeUnitId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, relativePath: true },
  }) : []
  if (acceptedRows.length > 256) throw new GoPackageRenameSnapshotError('Whole-project Go inventory is limited to 256 accepted source files.', 413)
  const reviewIds = acceptedRows.flatMap((source) => source.acceptedReviewId ? [source.acceptedReviewId] : [])
  const reviews = reviewIds.length ? await prisma.reamonCodeReview.findMany({
    where: { projectId: input.projectId, artifactId: input.artifactId, id: { in: reviewIds }, decision: 'ACCEPTED' },
    select: { id: true, codeUnitId: true, maintainedSourceHash: true, decision: true },
  }) : []
  const acceptedByUnit = new Map(acceptedRows.map((source) => [source.codeUnitId, source]))
  const reviewsById = new Map(reviews.map((review) => [review.id, review]))
  const rootRealPath = await realpath(derivedArtifactRoot())
  const files: GoPackageRenameFile[] = []
  let totalBytes = 0
  for (const unit of units) {
    const candidate = resolveDerivedArtifactPath(unit.codeArtifactId)
    const safePath = await realpath(candidate).catch(() => null)
    if (!safePath || !isInside(rootRealPath, safePath)) {
      throw new GoPackageRenameSnapshotError(`Linked Go source ${unit.relativePath} is unavailable or outside derived storage.`)
    }
    const info = await stat(safePath)
    if (!info.isFile() || info.size > MAX_GO_PROJECT_SOURCE_BYTES) {
      throw new GoPackageRenameSnapshotError(`${unit.relativePath} exceeds the 2 MiB whole-project source limit.`, 413)
    }
    const artifactBytes = await readFile(safePath)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(artifactBytes)
    } catch {
      throw new GoPackageRenameSnapshotError(`Linked Go source ${unit.relativePath} is not UTF-8 text.`)
    }
    const artifactHash = digest(artifactBytes)
    if (unit.unitId === input.selectedUnitId && artifactHash !== input.selectedArtifactSourceSha256) {
      throw new GoPackageRenameSnapshotError('The selected Go source changed while the project snapshot was loaded.')
    }
    const accepted = acceptedByUnit.get(unit.unitId)
    let sourceCode: string
    let acceptedReviewId: string | null = null
    if (unit.unitId === input.selectedUnitId) {
      sourceCode = input.selectedSource
    } else {
      const review = accepted?.acceptedReviewId ? reviewsById.get(accepted.acceptedReviewId) : undefined
      const acceptedHash = accepted ? digest(Buffer.from(accepted.sourceCode, 'utf8')) : ''
      if (!accepted || accepted.relativePath !== unit.relativePath || !accepted.sourceHash
          || accepted.sourceHash.toLowerCase() !== acceptedHash || !review
          || review.decision !== 'ACCEPTED' || review.codeUnitId !== unit.unitId
          || review.maintainedSourceHash.toLowerCase() !== acceptedHash) {
        throw new GoPackageRenameSnapshotError(`Go source ${unit.relativePath} is missing a current accepted review receipt.`)
      }
      sourceCode = accepted.sourceCode
      acceptedReviewId = review.id
    }
    const sourceBytes = Buffer.byteLength(sourceCode, 'utf8')
    totalBytes += sourceBytes
    if (sourceBytes > MAX_GO_PROJECT_SOURCE_BYTES || totalBytes > 8 * 1024 * 1024) {
      throw new GoPackageRenameSnapshotError('Whole-project Go source exceeds the 8 MiB inventory limit.', 413)
    }
    files.push({
      codeUnitId: unit.unitId, unitName: unit.unitName, relativePath: unit.relativePath,
      sourceCode, sourceHash: digest(Buffer.from(sourceCode, 'utf8')), acceptedReviewId,
      artifactSourceSha256: artifactHash,
    })
  }
  return files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
}

async function refactorRustBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/rust/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 120_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 5_000
        || payload?.parser_version !== '2026-10-12'
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && binding.name.length > 0 && binding.name.length <= 256
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'rust-analyzer returned an invalid binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: Boolean(payload.truncated) }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || payload?.parser_version !== '2026-10-12'
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'rust-analyzer returned an invalid transformed source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion: '2026-10-12', renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorCppBindings(
  sourceCode: string,
  language: 'c' | 'cpp',
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/cpp/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, language, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 120_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 2_000
        || !/^clangd-\d+\.\d+\.\d+$/.test(String(payload?.parser_version || ''))
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.name)
            && ['parameter', 'local variable'].includes(String(binding.kind))
            && binding.scopeType === 'clangd same-file semantic binding'
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'clangd returned an invalid C/C++ binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: Boolean(payload.truncated) }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || !/^clangd-\d+\.\d+\.\d+$/.test(parserVersion)
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length)
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'clangd returned invalid transformed C/C++ source')
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion, renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorLuaBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  runtime: string,
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/lua/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation,
      runtime,
      source_code: sourceCode,
      expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })),
    }),
  }, { timeoutMs: 120_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || typeof payload?.source_sha256 !== 'string' || payload.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || bindings.length > 200 || typeof payload.truncated !== 'boolean'
        || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(payload.parser_version || ''))
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.name)
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) {
      throw new Error(typeof payload?.error === 'string' ? payload.error : 'LuaLS returned an invalid binding catalog')
    }
    return { sourceSha256: payload.source_sha256, bindings: bindings as SafeRenameBinding[], truncated: payload.truncated }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parserVersion)
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'LuaLS returned an invalid transformed source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion, renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorCSharpBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/csharp/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 40_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 5_000
        || !/^\d+\.\d+\.\d+$/.test(String(payload?.parser_version || ''))
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.name)
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Roslyn returned an invalid binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: Boolean(payload.truncated) }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || !/^\d+\.\d+\.\d+$/.test(parserVersion)
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length)
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Roslyn returned an invalid transformed source')
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion, renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorJavaBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/java/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 40_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 5_000
        || !/^\d+\.\d+\.\d+$/.test(String(payload?.parser_version || ''))
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(binding.name)
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'javac returned an invalid binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: Boolean(payload.truncated) }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || !/^\d+\.\d+\.\d+$/.test(parserVersion)
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length)
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'javac returned an invalid transformed source')
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion, renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccessStrict(user, projectId)
    if (access instanceof NextResponse) return access

    let rawBody: unknown
    try { rawBody = await request.json() } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    const body = plainObject(rawBody)
    const operation = body.operation
    const unitId = typeof body.unitId === 'string' ? body.unitId.trim() : ''
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
    if (!unitId || unitId.length > 128 || !['suggest', 'apply'].includes(String(operation))) {
      return NextResponse.json({ error: 'A code unit and safe-rename operation are required' }, { status: 400 })
    }

    const observation = await prisma.reamonObservation.findFirst({
      where: { id: unitId, projectId, type: 'code_unit' },
      select: { id: true, artifactId: true, taskId: true, label: true, attributes: true },
    })
    if (!observation?.artifactId) return NextResponse.json({ error: 'Code unit not found' }, { status: 404 })
    const attributes = plainObject(observation.attributes)
    const language = typeof attributes.language === 'string' ? attributes.language.trim() : ''
    const normalizedLanguage = language.toLowerCase()
    const isPython = ['python', 'python 3', 'python3'].includes(normalizedLanguage)
    const isPhp = ['php', 'php source'].includes(normalizedLanguage)
    const isRuby = ['ruby', 'ruby source', 'rb'].includes(normalizedLanguage)
    const isRust = ['rust', 'rust source', 'rustlang'].includes(normalizedLanguage)
    const isCpp = ['c', 'c source', 'c++', 'c++ source', 'cpp', 'c/c++'].includes(normalizedLanguage)
    const cppLanguage: 'c' | 'cpp' = normalizedLanguage === 'c' || normalizedLanguage === 'c source' ? 'c' : 'cpp'
    const isJava = ['java', 'java source'].includes(normalizedLanguage)
    const isCSharp = ['c#', 'csharp', 'cs'].includes(normalizedLanguage)
    const isGo = ['go', 'golang'].includes(normalizedLanguage)
    const dialect = typeof attributes.dialect === 'string' ? attributes.dialect.toLowerCase().replace(/\s+/g, '') : ''
    const isLuau = ['luau', 'luau source'].includes(normalizedLanguage) || dialect === 'luau'
    const isLua = ['lua', 'lua source'].includes(normalizedLanguage) || /^lua(?: source)?\s+5\.[1-5]$/.test(normalizedLanguage)
    const luaRuntime = isLuau ? 'Luau' : dialect === 'luajit' ? 'LuaJIT' : /^lua5\.[1-5]$/.test(dialect) ? `Lua ${dialect.slice(3)}`
      : (normalizedLanguage.match(/5\.[1-5]/)?.[0] ? `Lua ${normalizedLanguage.match(/5\.[1-5]/)?.[0]}` : 'Lua 5.5')
    if (isLua && !isLuau && dialect && dialect !== 'luajit' && !/^lua5\.[1-5]$/.test(dialect)) {
      return NextResponse.json({ error: 'LuaLS scope-safe renaming supports Lua 5.1–5.5 and LuaJIT; this source dialect is not supported' }, { status: 415 })
    }
    if (!['javascript', 'typescript', 'jsx', 'tsx', 'python', 'python 3', 'python3', 'php', 'php source', 'ruby', 'ruby source', 'rb', 'go', 'golang', 'lua', 'lua source'].includes(normalizedLanguage)
        && !isLua && !isLuau && !isCSharp && !isJava && !isRust && !isCpp) {
      return NextResponse.json({ error: 'Scope-safe renaming currently supports JavaScript, TypeScript, Python, PHP, Ruby, Go, Lua, Luau, Java, C#, Rust, C, and C++ source' }, { status: 415 })
    }
    const codeArtifactId = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
    const selection = await getActiveWorkspaceImportSelection(projectId)
    const artifact = await prisma.artifact.findFirst({
      where: { AND: [{ id: observation.artifactId, projectId }, selection.artifactWhere] },
      select: { id: true, sha256: true },
    })
    if (!artifact) return NextResponse.json({ error: 'Code unit is not part of the active workspace' }, { status: 404 })
    const prefix = `${projectId}/${artifact.id}/`
    const segments = codeArtifactId.split('/')
    if (!codeArtifactId.startsWith(prefix) || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
      return NextResponse.json({ error: 'Code unit has no valid linked source artifact' }, { status: 404 })
    }
    const root = derivedArtifactRoot()
    const candidatePath = resolveDerivedArtifactPath(codeArtifactId)
    const [rootRealPath, sourceRealPath] = await Promise.all([realpath(root), realpath(candidatePath).catch(() => null)])
    if (!sourceRealPath || !isInside(rootRealPath, sourceRealPath)) return NextResponse.json({ error: 'Linked source path is invalid' }, { status: 404 })
    const info = await stat(sourceRealPath)
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return NextResponse.json({ error: `Linked ${isJava ? 'Java' : isCSharp ? 'C#' : isGo ? 'Go' : isPython ? 'Python' : isPhp ? 'PHP' : isRuby ? 'Ruby' : isRust ? 'Rust' : isLua ? 'Lua' : 'JavaScript'} source exceeds the safe-rename limit` }, { status: 413 })
    const sourceBytes = await readFile(sourceRealPath)
    const sourceCode = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
    const artifactSourceSha256 = digest(sourceBytes)
    const workingSource = typeof body.sourceCode === 'string' ? body.sourceCode : sourceCode
    const workingBytes = Buffer.from(workingSource, 'utf8')
    if (workingBytes.byteLength > MAX_SOURCE_BYTES) return NextResponse.json({ error: `Editable ${isJava ? 'Java' : isCSharp ? 'C#' : isGo ? 'Go' : isPython ? 'Python' : isPhp ? 'PHP' : isRuby ? 'Ruby' : isRust ? 'Rust' : isLua ? 'Lua' : 'JavaScript'} source exceeds the safe-rename limit` }, { status: 413 })
    const workingSourceSha256 = digest(workingBytes)
    const runKey = segments.slice(0, 4).join('/')
    const crossFileGo = body.crossFileGo === true
    const moduleGo = body.moduleGo === true
    const projectGoRename = crossFileGo || moduleGo
    if (crossFileGo && moduleGo) return NextResponse.json({ error: 'Choose either same-package or whole-module Go rename scope.' }, { status: 400 })
    const unitName = (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
      || (typeof attributes.name === 'string' && attributes.name)
      || `Selected ${isJava ? 'Java' : isCSharp ? 'C#' : isGo ? 'Go' : isPython ? 'Python' : isPhp ? 'PHP' : isRuby ? 'Ruby' : isRust ? 'Rust' : isLua ? 'Lua' : 'JavaScript'} unit`
    let goPackageFiles: GoPackageRenameFile[] | null = null
    let goProjectSourceFiles: GoPackageRenameFile[] | null = null
    let goProjectCatalog: GoProjectRenameCatalog | null = null
    let goProjectInventoryError: string | null = null
    let goProjectInventorySourceSetSha256: string | null = null
    let goDownstreamModules: GoDownstreamModuleCheck[] = []
    let goDownstreamModulesComplete = false
    let goProjectModuleContext: GoModuleInventoryContext = { modulePath: '', moduleRoot: '', manifestSha256: '', manifestText: '', sumSha256: '', sumText: '' }
    if (projectGoRename) {
      if (!isGo) return NextResponse.json({ error: 'Cross-file and module-wide renaming are currently supported only for Go.' }, { status: 415 })
      const relativePath = typeof attributes.relativePath === 'string' ? attributes.relativePath : ''
      try {
        if (!moduleGo) {
          goPackageFiles = await loadVerifiedGoPackageSnapshot({
            projectId, artifactId: artifact.id, taskId: observation.taskId || '', runKey,
            selectedUnitId: observation.id, selectedPath: relativePath, selectedSource: workingSource,
            selectedArtifactSourceSha256: artifactSourceSha256,
          })
        }
        try {
          goProjectSourceFiles = await loadVerifiedGoProjectSnapshot({
            projectId, artifactId: artifact.id, taskId: observation.taskId || '', runKey,
            selectedUnitId: observation.id, selectedPath: relativePath, selectedSource: workingSource,
            selectedArtifactSourceSha256: artifactSourceSha256,
          })
          if (moduleGo) {
            const snapshots = await loadGoModuleSourceSnapshots(selection.artifactWhere, goProjectSourceFiles)
            const target = snapshots.modules.find((module) => module.files.some((file) => file.relativePath === relativePath))
            if (!target) throw new GoPackageRenameSnapshotError('The selected Go source is not covered by a verified module manifest.')
            goProjectModuleContext = target.context
            goDownstreamModules = snapshots.modules.filter((module) => module !== target).map(({ context, files }) => ({
              module_path: context.modulePath,
              module_root: context.moduleRoot,
              go_mod: context.manifestText,
              go_mod_sha256: context.manifestSha256,
              go_sum: context.sumText,
              go_sum_sha256: context.sumSha256,
              files: files.map((file) => ({ relative_path: file.relativePath, source_code: file.sourceCode, expected_sha256: file.sourceHash })),
            }))
            const assignedPaths = new Set(snapshots.modules.flatMap((module) => module.files.map((file) => file.relativePath)))
            goDownstreamModulesComplete = snapshots.unassignedPaths.length === 0
              && goProjectSourceFiles.every((file) => assignedPaths.has(file.relativePath))
            goProjectSourceFiles = target.files
          } else {
            goProjectModuleContext = await loadGoModuleInventoryContext(
              selection.artifactWhere, goProjectSourceFiles.map((file) => file.relativePath),
            )
          }
        } catch (inventoryError) {
          if (moduleGo) {
            const status = inventoryError instanceof GoPackageRenameSnapshotError ? inventoryError.status : 409
            return NextResponse.json({ error: inventoryError instanceof Error ? inventoryError.message : 'A complete verified Go module snapshot is required.' }, { status })
          }
          goProjectInventoryError = inventoryError instanceof Error ? inventoryError.message : 'Whole-project Go inventory is unavailable.'
        }
        if (moduleGo && (!goProjectSourceFiles?.length || !goProjectModuleContext.modulePath || !goProjectModuleContext.manifestSha256)) {
          return NextResponse.json({ error: 'Whole-module Go rename requires a complete accepted source snapshot and verified go.mod/go.sum receipts.' }, { status: 409 })
        }
      } catch (error) {
        if (error instanceof GoPackageRenameSnapshotError) return NextResponse.json({ error: error.message }, { status: error.status })
        throw error
      }
    }

    if (operation === 'suggest') {
      if (!providerId || providerId.length > 128) return NextResponse.json({ error: 'Choose a saved AI provider' }, { status: 400 })
      if (workingBytes.byteLength > MAX_SUGGESTION_SOURCE_BYTES) return NextResponse.json({ error: 'This source is too large for AI rename suggestions' }, { status: 413 })
      const provider = await prisma.userLlmProvider.findFirst({
        where: { id: providerId, userId: user.userId, providerType: 'openai_compatible' },
        select: { id: true, modelIdentifier: true },
      })
      if (!provider) return NextResponse.json({ error: 'Saved OpenAI-compatible provider not found' }, { status: 404 })

      goProjectCatalog = moduleGo && goProjectSourceFiles
        ? await listGoModuleRenameBindings(goProjectSourceFiles, typeof attributes.relativePath === 'string' ? attributes.relativePath : '', goProjectModuleContext)
        : crossFileGo && goPackageFiles
          ? await listGoProjectRenameBindings(goPackageFiles, typeof attributes.relativePath === 'string' ? attributes.relativePath : '', goProjectModuleContext)
        : null
      if (goProjectCatalog && goProjectSourceFiles) {
        try {
          goProjectCatalog.inventory = await listGoProjectInventory(
            goProjectSourceFiles, typeof attributes.relativePath === 'string' ? attributes.relativePath : '', goProjectModuleContext,
          )
          goProjectInventorySourceSetSha256 = hashGoProjectInventoryScope(goProjectSourceFiles, goProjectModuleContext)
          goProjectInventoryError = null
        } catch (inventoryError) {
          if (moduleGo) return NextResponse.json({ error: inventoryError instanceof Error ? inventoryError.message : 'A complete Go module inventory is required for module-wide rename.' }, { status: 409 })
          goProjectInventoryError = inventoryError instanceof Error ? inventoryError.message : 'Whole-project Go inventory is unavailable.'
        }
      }
      const catalog = goProjectCatalog ?? (isJava
        ? await refactorJavaBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isCSharp
        ? await refactorCSharpBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isGo
        ? await listGoRenameBindings(workingSource)
        : isPhp ? await refactorPhpBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isRuby ? await refactorRubyBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isRust ? await refactorRustBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isCpp ? await refactorCppBindings(workingSource, cppLanguage, 'bindings') as SafeRenameCatalog
        : isPython ? await listPythonRenameBindings(workingSource)
        : isLuau ? await refactorLuaBindings(workingSource, 'bindings', luaRuntime) as SafeRenameCatalog
          : isLua ? await refactorLuaBindings(workingSource, 'bindings', luaRuntime) as SafeRenameCatalog
            : await listSafeRenameBindings(workingSource))
      const candidates = catalog.bindings
        .filter((binding) => (!binding.exported || moduleGo) && binding.kind !== 'module' && binding.referenceCount > 0
          && (binding.name.length <= 3 || /^_?(?:0x[\da-f]{4,}|[\da-f]{6,})$/i.test(binding.name)))
        .slice(0, MAX_CANDIDATES)
      if (!candidates.length) {
        const projectSymbolContextSha256 = digest(Buffer.alloc(0))
        const savedAttempt = await prisma.reamonCodeAttempt.create({
          data: {
            projectId, ownerUserId: user.userId, artifactId: artifact.id, runKey, codeUnitId: observation.id,
            unitName: unitName.slice(0, 500), language, sourceHash: artifactSourceSha256,
            providerName: 'REAmon scope-safe rename suggestions', modelIdentifier: provider.modelIdentifier.slice(0, 128),
            question: (typeof body.question === 'string' ? body.question : '').slice(0, 1000),
            scope: 'rename-suggestions', status: 'SUCCEEDED',
            requestPayload: { operation: 'scope-safe-rename-suggestions', providerId: provider.id, modelIdentifier: provider.modelIdentifier, inputSha256: workingSourceSha256, artifactSourceSha256, inputSource: workingSource, goProjectScope: projectGoRename, goModuleScope: moduleGo, goSourceSetSha256: goProjectCatalog?.sourceSetSha256 ?? null, goSelectedPath: goProjectCatalog?.selectedPath ?? null, goModuleInventoryScopeSha256: goProjectCatalog?.inventoryScopeSha256 ?? null, goProjectInventorySourceSetSha256, goProjectModulePath: goProjectModuleContext.modulePath, goProjectModuleRoot: goProjectModuleContext.moduleRoot, goProjectModuleManifestSha256: goProjectModuleContext.manifestSha256, goProjectModuleSumSha256: goProjectModuleContext.sumSha256, goProjectInventoryError, goProjectInventory: goProjectCatalog?.inventory ? JSON.parse(JSON.stringify(goProjectCatalog.inventory)) : null, renames: [] },
            syntaxValidated: false, validationStatus: 'UNAVAILABLE', validationMethod: 'proposal-only',
            validationMessage: 'No eligible obfuscated local bindings were found; no rename proposal was generated.', completedAt: new Date(),
          },
          select: { id: true },
        })
        return NextResponse.json({ sourceSha256: workingSourceSha256, providerId: provider.id, providerName: 'REAmon scope-safe renames', model: provider.modelIdentifier, attemptId: savedAttempt.id, projectSymbolContextSha256, scope: moduleGo ? 'module' : crossFileGo ? 'project' : 'file', sourceSetSha256: goProjectCatalog?.sourceSetSha256 ?? null, projectInventorySourceSetSha256: goProjectInventorySourceSetSha256, projectInventoryError: goProjectInventoryError, projectInventory: goProjectCatalog?.inventory ?? null, candidates: 0, renames: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
      }

      const priorAttempts = await prisma.reamonCodeAttempt.findMany({
        where: {
          projectId,
          artifactId: artifact.id,
          runKey,
          codeUnitId: observation.id,
          sourceHash: artifactSourceSha256,
          scope: 'rename-suggestions',
          status: 'SUCCEEDED',
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, createdAt: true, requestPayload: true },
      })
      const priorSuggestionContext = priorAttempts.flatMap((attempt) => {
        const payload = plainObject(attempt.requestPayload)
        if (payload.operation !== 'scope-safe-rename-suggestions' || payload.inputSha256 !== workingSourceSha256
            || !Array.isArray(payload.renames)) return []
        const proposals = payload.renames.flatMap((value) => {
          const rename = plainObject(value)
          if (typeof rename.bindingId !== 'string' || typeof rename.oldName !== 'string' || typeof rename.newName !== 'string'
              || typeof rename.kind !== 'string' || typeof rename.rationale !== 'string') return []
          return [{ bindingId: rename.bindingId.slice(0, 128), oldName: rename.oldName.slice(0, 256), newName: rename.newName.slice(0, 128), kind: rename.kind.slice(0, 80), rationale: rename.rationale.slice(0, 400) }]
        }).slice(0, 80)
        return proposals.length ? [{ id: attempt.id, createdAt: attempt.createdAt.toISOString(), proposals }] : []
      })
      const priorSuggestionText = priorSuggestionContext.length
        ? JSON.stringify({ notice: 'These are unreviewed prior proposals, not accepted names or evidence. Use only as weak consistency hints and independently verify every suggestion in the current source.', attempts: priorSuggestionContext })
        : ''
      let boundedPriorSuggestionText = priorSuggestionText
      while (Buffer.byteLength(boundedPriorSuggestionText, 'utf8') > 8 * 1024 && priorSuggestionContext.length) {
        const latest = priorSuggestionContext[priorSuggestionContext.length - 1]
        latest.proposals.pop()
        if (!latest.proposals.length) priorSuggestionContext.pop()
        boundedPriorSuggestionText = priorSuggestionContext.length
          ? JSON.stringify({ notice: 'These are unreviewed prior proposals, not accepted names or evidence. Use only as weak consistency hints and independently verify every suggestion in the current source.', attempts: priorSuggestionContext })
          : ''
      }

      const [currentArtifactSymbolRows, otherProjectSymbolRows] = await Promise.all([
        prisma.reamonMaintainedSource.findMany({
          where: { projectId, artifactId: artifact.id },
          select: { codeUnitId: true, artifactId: true, unitName: true, language: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: MAX_PROJECT_SYMBOL_SCAN + 1,
        }),
        prisma.reamonMaintainedSource.findMany({
          where: { projectId, artifactId: { not: artifact.id } },
          select: { codeUnitId: true, artifactId: true, unitName: true, language: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: MAX_PROJECT_SYMBOL_SCAN + 1,
        }),
      ])
      const projectSymbolScanTruncated = currentArtifactSymbolRows.length > MAX_PROJECT_SYMBOL_SCAN
        || otherProjectSymbolRows.length > MAX_PROJECT_SYMBOL_SCAN
      const symbolRows = [...currentArtifactSymbolRows.slice(0, MAX_PROJECT_SYMBOL_SCAN), ...otherProjectSymbolRows.slice(0, MAX_PROJECT_SYMBOL_SCAN)]
      const reviewIds = [...new Set(symbolRows.flatMap((row) => row.acceptedReviewId ? [row.acceptedReviewId] : []))]
      const reviews = reviewIds.length ? await prisma.reamonCodeReview.findMany({
        where: { projectId, id: { in: reviewIds }, decision: 'ACCEPTED' },
        select: { id: true, artifactId: true, codeUnitId: true, maintainedSourceHash: true, validationStatus: true, validationMethod: true },
      }) : []
      const reviewById = new Map(reviews.map((review) => [review.id, review]))
      const trustedRows = symbolRows.filter((row) => {
        if (!row.acceptedReviewId || !row.sourceHash) return false
        const receipt = reviewById.get(row.acceptedReviewId)
        return receipt?.artifactId === row.artifactId
          && receipt.codeUnitId === row.codeUnitId
          && receipt.maintainedSourceHash === row.sourceHash
      })
      const artifactIds = [...new Set(trustedRows.map((row) => row.artifactId))]
      const artifacts = artifactIds.length ? await prisma.artifact.findMany({
        where: { projectId, id: { in: artifactIds } },
        select: { id: true, originalName: true, sha256: true },
      }) : []
      const artifactById = new Map(artifacts.map((row) => [row.id, row]))
      const projectSymbolContext = buildProjectSymbolContext(trustedRows.map((row) => {
        const receipt = row.acceptedReviewId ? reviewById.get(row.acceptedReviewId) : undefined
        return {
          ...row,
          artifactName: artifactById.get(row.artifactId)?.originalName,
          artifactHash: artifactById.get(row.artifactId)?.sha256,
          validationStatus: receipt?.validationStatus,
          validationMethod: receipt?.validationMethod,
        }
      }), new Set(), 6_000, artifact.sha256 || undefined, undefined, projectSymbolScanTruncated,
      candidates.map(({ name, kind }) => ({ language, name, kind })))
      const response = await agentFetch('/reamon/code/suggest-renames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `custom/${provider.id}`,
          user_id: user.userId,
          unit_name: unitName,
          language: isJava ? 'Java' : isCSharp ? 'C#' : isGo ? 'Go' : isPython ? 'Python' : isPhp ? 'PHP' : isRust ? 'Rust' : isLua ? 'Lua' : language,
          source_code: workingSource,
          bindings: candidates,
          allow_exported_go_methods: moduleGo,
          project_symbol_context: projectSymbolContext,
          prior_suggestion_context: boundedPriorSuggestionText,
          question: typeof body.question === 'string' ? body.question.slice(0, 1000) : '',
        }),
      }, { timeoutMs: 120_000 })
      const result = await response.json().catch(() => null) as { renames?: unknown; error?: string } | null
      if (!response.ok || !result || !Array.isArray(result.renames)) {
        return NextResponse.json({ error: result?.error || 'Could not generate rename suggestions' }, { status: response.status || 502 })
      }
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
      const renames = result.renames.flatMap((value) => {
        const rename = plainObject(value)
        const binding = typeof rename.bindingId === 'string' ? candidateById.get(rename.bindingId) : undefined
        if (!binding || rename.oldName !== binding.name || typeof rename.newName !== 'string' || rename.newName.length > 128
            || typeof rename.rationale !== 'string'
            || (moduleGo && binding.exported && !/^\p{Lu}/u.test(rename.newName))) return []
        return [{
          bindingId: binding.id,
          oldName: binding.name,
          newName: rename.newName,
          kind: binding.kind,
          referenceCount: binding.referenceCount,
          ...(binding.relativePath ? { relativePath: binding.relativePath } : {}),
          rationale: rename.rationale.slice(0, 400),
        }]
      }).slice(0, 80)
      const projectSymbolContextSha256 = digest(Buffer.from(projectSymbolContext, 'utf8'))
      const savedAttempt = await prisma.reamonCodeAttempt.create({
        data: {
          projectId,
          ownerUserId: user.userId,
          artifactId: artifact.id,
          runKey,
          codeUnitId: observation.id,
          unitName: unitName.slice(0, 500),
          language,
          sourceHash: artifactSourceSha256,
          providerName: 'REAmon scope-safe rename suggestions',
          modelIdentifier: provider.modelIdentifier.slice(0, 128),
          question: (typeof body.question === 'string' ? body.question : '').slice(0, 1000),
          scope: 'rename-suggestions',
          status: 'SUCCEEDED',
          requestPayload: {
            operation: 'scope-safe-rename-suggestions',
            providerId: provider.id,
            modelIdentifier: provider.modelIdentifier,
            engine: 'AI rename proposals grounded in immutable source and accepted project-symbol memory',
            inputSha256: workingSourceSha256,
            artifactSourceSha256,
            inputSource: workingSource,
            goProjectScope: projectGoRename,
            goModuleScope: moduleGo,
            goSourceSetSha256: goProjectCatalog?.sourceSetSha256 ?? null,
            goSelectedPath: goProjectCatalog?.selectedPath ?? null,
            goModuleInventoryScopeSha256: goProjectCatalog?.inventoryScopeSha256 ?? null,
            goProjectInventorySourceSetSha256,
            goProjectModulePath: goProjectModuleContext.modulePath,
            goProjectModuleRoot: goProjectModuleContext.moduleRoot,
            goProjectModuleManifestSha256: goProjectModuleContext.manifestSha256,
            goProjectModuleSumSha256: goProjectModuleContext.sumSha256,
            goProjectInventoryError,
            goProjectInventory: goProjectCatalog ? JSON.parse(JSON.stringify(goProjectCatalog.inventory)) : null,
            bindings: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, kind: candidate.kind, scopeType: candidate.scopeType, relativePath: candidate.relativePath, importPath: candidate.importPath, referenceCount: candidate.referenceCount, exported: candidate.exported })),
            projectSymbolContext,
            projectSymbolContextSha256,
            projectSymbolScanTruncated,
            priorSuggestionContext: boundedPriorSuggestionText,
            renames,
          },
          syntaxValidated: false,
          validationStatus: 'UNAVAILABLE',
          validationMethod: 'proposal-only',
          validationMessage: 'Suggestions are saved as unreviewed proposals. Syntax and binding validation runs only after selected names are applied.',
          completedAt: new Date(),
        },
        select: { id: true },
      })
      return NextResponse.json({
        sourceSha256: workingSourceSha256,
        providerId: provider.id,
        providerName: 'REAmon scope-safe renames',
        model: provider.modelIdentifier,
        attemptId: savedAttempt.id,
        projectSymbolContextSha256,
        projectSymbolScanTruncated,
        scope: moduleGo ? 'module' : crossFileGo ? 'project' : 'file',
        sourceSetSha256: goProjectCatalog?.sourceSetSha256 ?? null,
        projectInventorySourceSetSha256: goProjectInventorySourceSetSha256,
        projectInventoryError: goProjectInventoryError,
        projectInventory: goProjectCatalog?.inventory ?? null,
        candidates: candidates.length,
        renames,
      }, { headers: { 'Cache-Control': 'private, no-store' } })
    }

    const expectedSha256 = typeof body.expectedSha256 === 'string' ? body.expectedSha256.toLowerCase() : ''
    if (expectedSha256 !== workingSourceSha256) return NextResponse.json({ error: 'The source changed after rename suggestions were generated. Reload and retry.' }, { status: 409 })
    if (!providerId || providerId.length > 128) return NextResponse.json({ error: 'Choose the saved provider used for rename suggestions' }, { status: 400 })
    const provider = await prisma.userLlmProvider.findFirst({
      where: { id: providerId, userId: user.userId, providerType: 'openai_compatible' },
      select: { id: true, name: true, modelIdentifier: true },
    })
    if (!provider) return NextResponse.json({ error: 'Saved OpenAI-compatible provider not found' }, { status: 404 })
    const suggestionAttemptId = typeof body.suggestionAttemptId === 'string' ? body.suggestionAttemptId : ''
    if (!suggestionAttemptId || suggestionAttemptId.length > 128) return NextResponse.json({ error: 'The saved rename proposal is missing; generate suggestions again' }, { status: 400 })
    const suggestionAttempt = await prisma.reamonCodeAttempt.findFirst({
      where: {
        id: suggestionAttemptId,
        projectId,
        artifactId: artifact.id,
        runKey,
        codeUnitId: observation.id,
        sourceHash: artifactSourceSha256,
        scope: 'rename-suggestions',
        status: 'SUCCEEDED',
        providerName: 'REAmon scope-safe rename suggestions',
      },
      select: { id: true, requestPayload: true },
    })
    const proposalPayload = plainObject(suggestionAttempt?.requestPayload)
    const savedRenames = Array.isArray(proposalPayload.renames) ? proposalPayload.renames : []
    if (projectGoRename && (proposalPayload.goProjectModulePath !== goProjectModuleContext.modulePath
        || proposalPayload.goProjectModuleRoot !== goProjectModuleContext.moduleRoot
        || proposalPayload.goProjectModuleManifestSha256 !== goProjectModuleContext.manifestSha256
        || proposalPayload.goProjectModuleSumSha256 !== goProjectModuleContext.sumSha256)) {
      return NextResponse.json({ error: 'The Go module manifest changed after rename suggestions were generated; generate suggestions again' }, { status: 409 })
    }
    goProjectCatalog = moduleGo && goProjectSourceFiles
      ? await listGoModuleRenameBindings(goProjectSourceFiles, typeof attributes.relativePath === 'string' ? attributes.relativePath : '', goProjectModuleContext)
      : crossFileGo && goPackageFiles
        ? await listGoProjectRenameBindings(goPackageFiles, typeof attributes.relativePath === 'string' ? attributes.relativePath : '', goProjectModuleContext)
      : null
    if (goProjectCatalog && goProjectSourceFiles) {
      try {
        goProjectCatalog.inventory = await listGoProjectInventory(
          goProjectSourceFiles, typeof attributes.relativePath === 'string' ? attributes.relativePath : '', goProjectModuleContext,
        )
        goProjectInventorySourceSetSha256 = hashGoProjectInventoryScope(goProjectSourceFiles, goProjectModuleContext)
        goProjectInventoryError = null
      } catch (inventoryError) {
          if (moduleGo) return NextResponse.json({ error: inventoryError instanceof Error ? inventoryError.message : 'A complete Go module inventory is required for module-wide rename.' }, { status: 409 })
        goProjectInventoryError = inventoryError instanceof Error ? inventoryError.message : 'Whole-project Go inventory is unavailable.'
      }
    }
    if (moduleGo && (!goProjectCatalog || !goProjectCatalog.inventory || !goProjectCatalog.inventoryScopeSha256)) {
      return NextResponse.json({ error: 'The Go module binding catalog or complete inventory is unavailable; generate suggestions again.' }, { status: 409 })
    }
    if (!suggestionAttempt || proposalPayload.operation !== 'scope-safe-rename-suggestions' || proposalPayload.providerId !== provider.id
        || proposalPayload.modelIdentifier !== provider.modelIdentifier || proposalPayload.inputSha256 !== workingSourceSha256
        || proposalPayload.goProjectScope !== projectGoRename
        || (proposalPayload.goModuleScope ?? false) !== moduleGo
        || (projectGoRename && (proposalPayload.goSourceSetSha256 !== goProjectCatalog?.sourceSetSha256
          || proposalPayload.goSelectedPath !== goProjectCatalog?.selectedPath
          || (proposalPayload.goProjectInventorySourceSetSha256 ?? null) !== goProjectInventorySourceSetSha256
          || (moduleGo && proposalPayload.goModuleInventoryScopeSha256 !== goProjectCatalog?.inventoryScopeSha256)))
        || typeof proposalPayload.projectSymbolContext !== 'string' || typeof proposalPayload.projectSymbolContextSha256 !== 'string'
        || proposalPayload.projectSymbolContextSha256 !== digest(Buffer.from(proposalPayload.projectSymbolContext, 'utf8'))) {
      return NextResponse.json({ error: 'The saved rename proposal does not match this source and project context; generate suggestions again' }, { status: 409 })
    }

    const requests = Array.isArray(body.renames) ? body.renames : []
    if (requests.length < 1 || requests.length > 80) return NextResponse.json({ error: 'Select between 1 and 80 rename suggestions' }, { status: 400 })
    const catalog = goProjectCatalog ?? (isJava
      ? await refactorJavaBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isCSharp
      ? await refactorCSharpBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isGo
      ? await listGoRenameBindings(workingSource)
      : isPhp ? await refactorPhpBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isRuby ? await refactorRubyBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isRust ? await refactorRustBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isCpp ? await refactorCppBindings(workingSource, cppLanguage, 'bindings') as SafeRenameCatalog
      : isPython ? await listPythonRenameBindings(workingSource)
        : isLua ? await refactorLuaBindings(workingSource, 'bindings', luaRuntime) as SafeRenameCatalog
          : await listSafeRenameBindings(workingSource))
    const available = new Map(catalog.bindings.map((binding) => [binding.id, binding]))
    for (const rename of requests) {
      const item = plainObject(rename)
      const binding = typeof item.bindingId === 'string' ? available.get(item.bindingId) : undefined
      const saved = savedRenames.map(plainObject).find((proposal) => proposal.bindingId === item.bindingId)
      if (!binding || (binding.exported && !moduleGo) || typeof item.newName !== 'string' || item.oldName !== binding.name
          || typeof item.rationale !== 'string' || item.rationale.length > 400
          || !saved || (saved.relativePath !== undefined && saved.relativePath !== binding.relativePath)
          || saved.oldName !== item.oldName || saved.newName !== item.newName || saved.kind !== binding.kind || saved.rationale !== item.rationale) {
        return NextResponse.json({ error: 'A selected rename no longer matches the current source bindings' }, { status: 409 })
      }
    }
    const selectedRenames = requests.map((rename) => {
      const item = plainObject(rename)
      return { bindingId: String(item.bindingId), newName: String(item.newName) }
    })
    const selectedProjectRenames = requests.map((rename) => {
      const item = plainObject(rename)
      const binding = available.get(String(item.bindingId))
      if (!binding) throw new Error('A selected Go package binding disappeared after validation')
      return {
        bindingId: binding.id, oldName: binding.name, newName: String(item.newName),
        kind: binding.kind, referenceCount: binding.referenceCount, scopeType: binding.scopeType,
      }
    })
    const goRenameFiles = moduleGo ? goProjectSourceFiles : goPackageFiles
    const transformed = projectGoRename && goRenameFiles && goProjectCatalog
      ? await applyGoProjectRenameBindings(
        goRenameFiles, goProjectCatalog.selectedPath, workingSourceSha256, goProjectCatalog.sourceSetSha256,
        goProjectModuleContext, selectedProjectRenames, moduleGo ? 'module' : 'project', goProjectCatalog.inventoryScopeSha256,
        goDownstreamModules, goDownstreamModulesComplete,
      )
      : isJava
      ? await refactorJavaBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isCSharp
      ? await refactorCSharpBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isGo
      ? await applyGoRenameBindings(workingSource, workingSourceSha256, selectedRenames)
      : isPhp ? await refactorPhpBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isRuby ? await refactorRubyBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isRust ? await refactorRustBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isCpp ? await refactorCppBindings(workingSource, cppLanguage, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isPython ? await applyPythonRenameBindings(workingSource, workingSourceSha256, selectedRenames)
        : isLuau ? await refactorLuaBindings(workingSource, 'rename', luaRuntime, workingSourceSha256, selectedRenames) as SafeRenameResult
        : isLua ? await refactorLuaBindings(workingSource, 'rename', luaRuntime, workingSourceSha256, selectedRenames) as SafeRenameResult
          : await applySafeRenameBindings(workingSource, workingSourceSha256, selectedRenames)
    const validationMethod = isPhp
      ? `phpactor-${transformed.parserVersion}+php-scope-safe-rename`
      : isRuby
      ? `solargraph-${transformed.parserVersion}+ruby-scope-safe-rename`
      : isJava
      ? `javac-${transformed.parserVersion}-release17+java-scope-safe-rename`
      : isCSharp
      ? `roslyn-${transformed.parserVersion}+csharp-scope-safe-rename`
      : isGo
      ? `${transformed.parserVersion}+go-ast-types-scope-safe-rename`
      : isCpp ? `${transformed.parserVersion}+c-cpp-lsp-semantic-local-rename`
      : isRust ? `rust-analyzer-${transformed.parserVersion}+lsp-semantic-local-rename`
      : isPython ? `libcst-${transformed.parserVersion}+scope-safe-rename`
        : isLuau ? `luau-lsp-${transformed.parserVersion}+scope-safe-rename`
        : isLua ? `luals-${transformed.parserVersion}+tree-sitter-lua-scope-safe-rename`
          : `babel-parser-${transformed.parserVersion}+scope-safe-rename`
    const validationMessage = isPhp
      ? `Phpactor ${transformed.parserVersion} resolved selected local PHP bindings and PHP lint parsed the rewritten source without executing it. This does not verify project dependencies, dynamic lookups, or behavior.`
      : isRuby
      ? `Solargraph ${transformed.parserVersion} resolved same-file local and parameter bindings, Ripper constrained every edit to local identifier tokens, and Ruby syntax validation passed without executing the source. Keyword labels, cross-file references, project dependencies, and behavior are not validated.`
      : isJava
      ? `javac ${transformed.parserVersion} resolved selected Java bindings and the output was reparsed with selected references checked against their declarations. This is syntax and binding evidence only; it does not validate project dependencies or runtime equivalence.`
      : isCSharp
      ? `Roslyn ${transformed.parserVersion} resolved selected C# local bindings and parsed the renamed output. This confirms syntax only; it does not validate project references, compilation, or runtime equivalence.`
      : isGo
      ? `Go ${transformed.parserVersion} parsed the output after object-identity-based local binding renames. This confirms syntax only; missing package dependencies, build behavior, and runtime equivalence are not validated.`
      : isCpp
      ? `${transformed.parserVersion} resolved local C/C++ bindings and returned the complete same-file reference set. Macros, conditional compilation, templates, project dependencies, builds, and runtime equivalence are not validated.`
      : isRust
      ? `rust-analyzer ${transformed.parserVersion} resolved the selected local binding and returned the complete same-file reference set; Tree-sitter parsed the output. This does not validate project dependencies, build behavior, or runtime equivalence.`
      : isPython
        ? `LibCST ${transformed.parserVersion} applied scope-aware local-binding renames and parsed the output. This confirms structure only, not module-level references or behavior equivalence.`
        : isLuau
          ? `Luau LSP ${transformed.parserVersion} resolved the selected Luau binding and applied its single-source rename edits; syntax was checked without executing the source. This does not verify project API definitions or runtime behavior.`
        : isLua
          ? `LuaLS ${transformed.parserVersion} resolved the selected local binding and applied its single-source rename edits; Tree-sitter parsed the output. LuaLS references and parsing do not prove behavior equivalence.`
          : `Babel ${transformed.parserVersion} parsed the output after scope-aware renaming and rejected binding collisions. This confirms syntax only, not behavior equivalence.`
    if (projectGoRename && 'scope' in transformed && (transformed.scope === 'project' || transformed.scope === 'module') && goRenameFiles) {
      const projectTransform = transformed as GoProjectRenameResult
      const inputByPath = new Map(goRenameFiles.map((file) => [file.relativePath, file]))
      const rootRealPath = await realpath(derivedArtifactRoot())
      for (const outputFile of projectTransform.projectFiles) {
        const inputFile = inputByPath.get(outputFile.relativePath)
        if (!inputFile?.artifactSourceSha256) return NextResponse.json({ error: 'A changed Go file is missing its source-artifact receipt.' }, { status: 409 })
        const sourcePath = resolveDerivedArtifactPath(`${runKey}/sources/${outputFile.relativePath}`)
        const safePath = await realpath(sourcePath).catch(() => null)
        if (!safePath || !isInside(rootRealPath, safePath)) return NextResponse.json({ error: `Changed Go source ${outputFile.relativePath} is no longer linked to this run.` }, { status: 409 })
        const sourceInfo = await stat(safePath)
        if (!sourceInfo.isFile() || sourceInfo.size > MAX_SOURCE_BYTES
            || digest(await readFile(safePath)) !== inputFile.artifactSourceSha256) {
          return NextResponse.json({ error: `Changed Go source ${outputFile.relativePath} changed after the rename proposal.` }, { status: 409 })
        }
      }
      const renameMetadata = projectTransform.renamedBindings.map((binding) => ({
        ...binding,
        rationale: String(plainObject(requests.find((rename) => plainObject(rename).bindingId === binding.bindingId)).rationale || '').slice(0, 400),
      }))
      const validationMethod = `${projectTransform.parserVersion}+go-types-${moduleGo ? 'module' : 'package'}-binding-identity`
      const downstreamCompatibility = projectTransform.downstreamCompatibility
      const checkedBuildContexts = downstreamCompatibility?.checkedBuildContexts ?? []
      const checkedContextSummary = checkedBuildContexts.length
        ? checkedBuildContexts.map((context) => `${context.goos}/${context.goarch}${context.buildTags.length ? ` tags=${context.buildTags.join(',')}` : ''}`).join(', ')
        : `${downstreamCompatibility?.buildGOOS}/${downstreamCompatibility?.buildGOARCH}`
      const downstreamMessage = !moduleGo ? ''
        : downstreamCompatibility?.status === 'checked'
          ? ` Go type-checked ${downstreamCompatibility.checkedModules} discovered downstream module(s) against the original and renamed API for ${checkedContextSummary}; all passed.`
          : downstreamCompatibility?.status === 'no_consumers'
            ? ' The complete supplied Go source inventory contains no downstream module importing this module.'
            : downstreamCompatibility?.status === 'partial'
              ? ` Go type-checked ${downstreamCompatibility.checkedModules} discovered downstream module(s), but some Go source files could not be assigned to a verified module.`
              : downstreamCompatibility?.status === 'incomplete'
                ? ' Downstream compatibility is incomplete because some Go source files could not be assigned to a verified module.'
                : downstreamCompatibility?.status === 'not_required'
                  ? ' No exported method was renamed, so downstream compatibility checking was not required.'
                  : ' No downstream source snapshot was available for compatibility checking.'
      const validationMessage = moduleGo
        ? `Go ${projectTransform.parserVersion} type-checked the complete supplied module snapshot before and after renaming and verified every edited reference still resolves to the renamed method.${downstreamMessage} Source outside this workspace, builds, and runtime behavior were not checked. All changed files are unaccepted review drafts.`
        : `Go ${projectTransform.parserVersion} type-checked the complete same-package snapshot before and after renaming and verified every edited reference still resolves to the original package object. Sources were saved as separate unaccepted drafts; compilation dependencies and runtime behavior were not checked.`
      const projectChanges = await prisma.$transaction(async (tx) => {
        const saved: Array<{ unitId: string; relativePath: string; unitName: string; attemptId: string; draftId: string; updatedAt: string; outputSha256: string; editCount: number }> = []
        for (const outputFile of projectTransform.projectFiles) {
          const inputFile = inputByPath.get(outputFile.relativePath)
          if (!inputFile?.artifactSourceSha256) throw new Error(`Missing source-artifact receipt for ${outputFile.relativePath}`)
          const unitAttempt = await tx.reamonCodeAttempt.create({
            data: {
              projectId, ownerUserId: user.userId, artifactId: artifact.id, runKey,
              codeUnitId: inputFile.codeUnitId, unitName: inputFile.unitName.slice(0, 500), language: 'Go',
              sourceHash: inputFile.artifactSourceSha256, providerName: 'REAmon scope-safe renames',
              modelIdentifier: provider.modelIdentifier.slice(0, 128),
              question: 'Apply accepted evidence-backed Go package rename proposals',
              scope: 'file', status: 'SUCCEEDED',
              requestPayload: {
                operation: 'go-types-scope-safe-renames',
                engine: `Go ${transformed.parserVersion} ${moduleGo ? 'module' : 'package'}-wide go/types object identity`,
                projectScope: true, moduleScope: moduleGo, selectedPath: goProjectCatalog?.selectedPath,
                inputSha256: outputFile.inputSha256, artifactSourceSha256: inputFile.artifactSourceSha256,
                outputSha256: outputFile.outputSha256, sourceSetSha256: projectTransform.sourceSetSha256,
                outputSourceSetSha256: projectTransform.outputSourceSetSha256, suggestionAttemptId: suggestionAttempt.id,
                renames: renameMetadata, edits: outputFile.edits,
                downstreamCompatibility: projectTransform.downstreamCompatibility ?? null,
              },
              resultSource: outputFile.sourceCode, syntaxValidated: true,
              validationStatus: 'PASSED', validationMethod, validationMessage,
              completedAt: new Date(),
            },
            select: { id: true },
          })
          const draft = await tx.reamonCodeDraft.create({
            data: {
              projectId, artifactId: artifact.id, runKey, codeUnitId: inputFile.codeUnitId,
              sourceAttemptId: unitAttempt.id, unitName: inputFile.unitName.slice(0, 500), language: 'Go',
              sourceHash: inputFile.artifactSourceSha256, draftHash: outputFile.outputSha256,
              sourceCode: outputFile.sourceCode, providerName: 'REAmon scope-safe renames',
              modelIdentifier: provider.modelIdentifier.slice(0, 128), question: 'Apply accepted evidence-backed Go package rename proposals',
              scope: 'file', syntaxValidated: true, validationStatus: 'PASSED', validationMethod, validationMessage,
            },
            select: { id: true, updatedAt: true },
          })
          saved.push({
            unitId: inputFile.codeUnitId, relativePath: outputFile.relativePath,
            unitName: inputFile.unitName, attemptId: unitAttempt.id, draftId: draft.id, updatedAt: draft.updatedAt.toISOString(),
            outputSha256: outputFile.outputSha256, editCount: outputFile.edits.length,
          })
        }
        return saved
      })
      const selectedDraft = projectChanges.find((file) => file.unitId === observation.id)
      if (!selectedDraft) return NextResponse.json({ error: 'The Go project rename did not create a draft for the selected source.' }, { status: 503 })
      return NextResponse.json({
        sourceCode: transformed.sourceCode,
        sourceSha256: workingSourceSha256,
        outputSha256: transformed.outputSha256,
        renamedBindings: transformed.renamedBindings,
        attemptId: selectedDraft.attemptId,
        providerName: 'REAmon scope-safe renames',
        model: provider.modelIdentifier,
        syntaxValidated: true,
        validationStatus: 'PASSED',
        validationMethod,
        validationMessage,
        draftId: selectedDraft.draftId,
        draftUpdatedAt: selectedDraft.updatedAt,
        projectChanges,
        sourceSetSha256: projectTransform.sourceSetSha256,
        outputSourceSetSha256: projectTransform.outputSourceSetSha256,
        downstreamCompatibility: projectTransform.downstreamCompatibility ?? null,
      }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    const attempt = await prisma.reamonCodeAttempt.create({
      data: {
        projectId,
        ownerUserId: user.userId,
        artifactId: artifact.id,
        runKey,
        codeUnitId: observation.id,
        unitName: unitName.slice(0, 500),
        language,
        sourceHash: artifactSourceSha256,
        providerName: 'REAmon scope-safe renames',
        modelIdentifier: provider.modelIdentifier.slice(0, 128),
        question: 'Apply accepted evidence-backed identifier rename proposals',
        scope: 'file',
        status: 'SUCCEEDED',
        requestPayload: {
          operation: isCpp ? 'clangd-c-cpp-lsp-semantic-local-renames' : isPhp ? 'phpactor-php-lsp-scope-safe-renames' : isRuby ? 'solargraph-ruby-semantic-local-renames' : isJava ? 'javac-java-scope-safe-renames' : isCSharp ? 'roslyn-csharp-scope-safe-renames' : isGo ? 'go-types-scope-safe-renames' : isRust ? 'rust-analyzer-rust-lsp-semantic-local-renames' : isPython ? 'libcst-scope-safe-renames' : isLuau ? 'luau-lsp-scope-safe-renames' : isLua ? 'luals-scope-safe-renames' : 'humanify-style-scope-safe-renames',
          engine: isCpp ? `clangd ${transformed.parserVersion} LSP semantic references and rename` : isPhp ? `Phpactor ${transformed.parserVersion} LSP semantic rename; PHP lint` : isRuby ? `Solargraph ${transformed.parserVersion} references resolved by binding path; Ripper token allowlist; ruby -c` : isJava ? `JDK javac ${transformed.parserVersion} --release 17 Trees/Element symbol identity` : isCSharp ? `Roslyn ${transformed.parserVersion} semantic model and symbol identity` : isGo ? `Go ${transformed.parserVersion} AST and go/types object identity` : isRust ? `rust-analyzer ${transformed.parserVersion} LSP references + rename` : isPython ? `LibCST ${transformed.parserVersion} ScopeProvider/RenameCommand` : isLuau ? `Luau LSP ${transformed.parserVersion} semantic rename + Luau compiler parse` : isLua ? `LuaLS ${transformed.parserVersion} LSP rename + Tree-sitter Lua parse` : `Babel ${transformed.parserVersion} scope.rename (Humanify two-stage design)`,
          inputSha256: workingSourceSha256,
          artifactSourceSha256,
          inputSource: workingSource,
          suggestionAttemptId: suggestionAttempt.id,
          projectSymbolContextSha256: proposalPayload.projectSymbolContextSha256,
          outputSha256: transformed.outputSha256,
          renames: transformed.renamedBindings.map((binding) => ({
            ...binding,
            rationale: String(plainObject(requests.find((rename) => plainObject(rename).bindingId === binding.bindingId)).rationale || '').slice(0, 400),
          })),
        },
        resultSource: transformed.sourceCode,
        syntaxValidated: true,
        validationStatus: 'PASSED',
        validationMethod,
        validationMessage,
        completedAt: new Date(),
      },
      select: { id: true },
    })
    return NextResponse.json({
      sourceCode: transformed.sourceCode,
      sourceSha256: workingSourceSha256,
      outputSha256: transformed.outputSha256,
      renamedBindings: transformed.renamedBindings,
      attemptId: attempt.id,
      providerName: 'REAmon scope-safe renames',
      model: provider.modelIdentifier,
      syntaxValidated: true,
      validationStatus: 'PASSED',
      validationMethod,
      validationMessage,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof GoModuleCompatibilityError) {
      return NextResponse.json({ error: error.message }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    console.error('Failed to apply REAmon safe renames:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Could not process safe rename request' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
