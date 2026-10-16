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
  if (extension === '.java') return 'Java'
  if (extension === '.cs') return 'C#'
  if (['.cc', '.cpp', '.cxx', '.hpp', '.hh'].includes(extension)) return 'C++'
  return 'C'
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
  const params = Array.isArray(record.raw.params) ? JSON.stringify(record.raw.params).slice(0, 4000) : undefined
  const locals = Array.isArray(record.raw.locals) ? JSON.stringify(record.raw.locals).slice(0, 4000) : undefined
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
  if (params) attrs.parametersJson = params
  if (locals) attrs.localsJson = locals
  if (record.sourceFile) attrs.relativePath = record.sourceFile
  if (record.sourceLineStart !== null) attrs.sourceLineStart = record.sourceLineStart
  if (record.sourceLineEnd !== null) attrs.sourceLineEnd = record.sourceLineEnd
  if (record.assemblyFile) attrs.assemblyRelativePath = record.assemblyFile
  if (record.assemblyLineStart !== null) attrs.assemblyLineStart = record.assemblyLineStart
  if (record.assemblyLineEnd !== null) attrs.assemblyLineEnd = record.assemblyLineEnd
  if (record.sourceArtifact) attrs.sourceArtifactId = record.sourceArtifact.id
  if (record.sourceArtifact) attrs.sourceArtifactSha256 = record.sourceArtifact.sha256
  if (codeArtifactId) attrs.codeArtifactId = codeArtifactId
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
        }
        if (sourceFile) {
          const workspaceSourcePath = joinedExportPath(exportRoot, sourceFile)
          const sourceArtifact = workspaceSourcePath ? artifactsByPath.get(workspaceSourcePath) : undefined
          if (sourceArtifact && sourceArtifact.sizeBytes > 0 && sourceArtifact.sizeBytes <= MAX_SOURCE_FILE_BYTES) {
            let sourceEntry = sourceFiles.get(workspaceSourcePath!)
            if (!sourceEntry && sourceBytes + sourceArtifact.sizeBytes <= MAX_TOTAL_SOURCE_BYTES) {
              const sourceData = await readFile(resolveArtifactStoragePath(sourceArtifact.storagePath))
              const digest = createHash('sha256').update(sourceData).digest('hex')
              if (sourceData.byteLength === sourceArtifact.sizeBytes && digest === sourceArtifact.sha256.toLowerCase()) {
                const suffix = path.posix.extname(workspaceSourcePath!) || '.txt'
                const derivedRelative = `${projectId}/${anchor.id}/${taskId}/tocode/${shortHash(workspaceSourcePath!)}${suffix}`
                const destination = resolveDerivedArtifactPath(derivedRelative)
                await mkdir(path.dirname(destination), { recursive: true })
                await writeFile(destination, sourceData, { flag: 'wx' })
                sourceBytes += sourceData.byteLength
                sourceEntry = { artifact: sourceArtifact, derivedPath: derivedRelative }
                sourceFiles.set(workspaceSourcePath!, sourceEntry)
              }
            }
            if (sourceEntry) {
              record.sourceArtifact = sourceArtifact
              record.sourceRelativePath = workspaceSourcePath!
              record.codeArtifactId = sourceEntry.derivedPath
            } else {
              sourceFilesSkipped += 1
            }
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

    if (allFunctions.length === 0) throw new Error('No valid ToCode functions were found in this workspace import')

    for (const record of allFunctions) {
      const metadata = { version: exportVersion }
      observations.push(makeCodeUnit(record, metadata, record.codeArtifactId))
    }

    const seenCalls = new Set<string>()
    for (const record of allFunctions) {
      const callees = Array.isArray(record.raw.callees) ? record.raw.callees.slice(0, 256) : []
      for (const rawCallee of callees) {
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
    }

    const mappingsArtifact = artifactsByPath.get('mappings.json')
    let crossBinaryCalls = 0
    if (mappingsArtifact && mappingsArtifact.sizeBytes <= MAX_MAPPING_BYTES) {
      try {
        const mappings = await readJsonArtifact(mappingsArtifact, MAX_MAPPING_BYTES)
        const links = Array.isArray(mappings?.links) ? mappings.links.slice(0, 100_000) : []
        for (const rawLink of links) {
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
        }
      } catch {
        warnings.push('mappings.json could not be parsed; cross-binary call links were skipped.')
      }
    }
    if (candidates.length === MAX_EXPORTS) warnings.push(`Only the first ${MAX_EXPORTS} ToCode exports were indexed.`)
    if (inputFunctions > allFunctions.length + skippedFunctions) warnings.push('Some function rows were omitted by the indexer limits.')
    if (sourceFilesSkipped) warnings.push(`${sourceFilesSkipped} source-file links were omitted because files were missing, oversized, or exceeded the copy limit.`)

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
      copiedSourceFiles: sourceFiles.size,
      copiedSourceBytes: sourceBytes,
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
