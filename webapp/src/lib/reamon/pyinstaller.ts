import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'
import { executePycdc, pycdcManifest } from './pycdc'
import { resolveDerivedArtifactPath } from './derived-storage'
import prisma from '@/lib/prisma'

const MAX_MODULES_TO_DECOMPILE = 4
const MAX_REQUEST_TIMEOUT_MS = 22 * 60_000

interface ExtractedModule {
  archivePath: string
  sizeBytes: number
  sha256: string
  magicHex: string
  dataBase64: string
}

interface PyInstallerResponse {
  status: 'completed'
  extractorRevision: string
  moduleCount: number
  outputBytes: number
  truncated: boolean
  elapsedMs: number
  modules: ExtractedModule[]
}

export const pyinstallerManifest: ToolPluginManifest = {
  id: 'reamon-pyinstaller',
  name: 'PyInstaller Python Recovery (pyinstxtractor-go + pycdc)',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'pe-dotnet', 'macho'],
  acceptsMetadata: { containerFormat: 'pyinstaller' },
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'PythonModule', 'ExtractedBytecode'],
  requirements: [
    { key: 'service', value: 'Isolated PyInstaller extractor and pycdc analyzer' },
    { key: 'artifactPath' },
  ],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isCodeUnitObservation(value: unknown): value is ToolObservation {
  return isRecord(value) && value.kind === 'entity' && value.type === 'code_unit'
    && typeof value.key === 'string' && isRecord(value.attributes)
}

function isExtractedModule(value: unknown): value is ExtractedModule {
  if (!isRecord(value)) return false
  return typeof value.archivePath === 'string' && value.archivePath.length > 0 && value.archivePath.length <= 1000
    && Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) >= 16 && (value.sizeBytes as number) <= 4 * 1024 * 1024
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
    && typeof value.magicHex === 'string' && /^[a-f0-9]{8}$/.test(value.magicHex)
    && typeof value.dataBase64 === 'string' && value.dataBase64.length <= 6 * 1024 * 1024
}

function isResponse(value: unknown): value is PyInstallerResponse {
  if (!isRecord(value) || !Array.isArray(value.modules)) return false
  return value.status === 'completed'
    && typeof value.extractorRevision === 'string' && value.extractorRevision.length <= 100
    && Number.isSafeInteger(value.moduleCount) && (value.moduleCount as number) >= value.modules.length
    && Number.isSafeInteger(value.outputBytes) && (value.outputBytes as number) >= 0 && (value.outputBytes as number) <= 16 * 1024 * 1024
    && typeof value.truncated === 'boolean'
    && Number.isSafeInteger(value.elapsedMs) && (value.elapsedMs as number) >= 0
    && value.modules.length > 0 && value.modules.length <= 64 && value.modules.every(isExtractedModule)
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4_000) || 'PyInstaller analysis failed'
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function safeArchivePath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (normalized.startsWith('/') || parts.some((part) => part === '..' || part === '.' || part.includes('\0'))) return null
  return normalized.length <= 1000 ? normalized : null
}

function moduleSourcePath(artifactRelativePath: string | undefined, artifactId: string, archivePath: string, moduleIdentity: string): string {
  const sourceRoot = (artifactRelativePath || artifactId).replaceAll('\\', '/')
  const fullPath = `${sourceRoot}!/${archivePath}`
  if (fullPath.length <= 1_000) return fullPath
  return `${sourceRoot.slice(0, 700)}!/modules/${moduleIdentity.slice(0, 16)}-${path.posix.basename(archivePath).slice(0, 240)}`
}

function moduleCodeUnitKey(artifactId: string, relativePath: string): string {
  return `pycdc:module:${createHash('sha256').update(`${artifactId}:${relativePath}`).digest('hex').slice(0, 32)}`
}

async function persistBytecode(relativePath: string, artifactPath: string, bytecode: Buffer, sha256: string): Promise<void> {
  await mkdir(path.dirname(artifactPath), { recursive: true })
  try {
    await writeFile(artifactPath, bytecode, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error
    const existing = await readFile(artifactPath)
    if (existing.length !== bytecode.length || createHash('sha256').update(existing).digest('hex') !== sha256) {
      throw new Error(`Derived bytecode path collision for ${relativePath}`)
    }
  }
}

function extractedModuleObservation(
  input: ToolExecutionInput,
  module: ExtractedModule,
  relativePath: string,
  bytecodeArtifactId: string,
  moduleIdentity: string,
  executableSha256: string,
  extractorRevision: string,
): ToolObservation {
  const moduleName = path.posix.basename(module.archivePath).replace(/\.pyc$/i, '').slice(0, 500) || 'module'
  const codeUnitKey = moduleCodeUnitKey(input.artifactId || '', relativePath)
  return {
    kind: 'entity',
    type: 'code_unit',
    key: codeUnitKey,
    label: moduleName,
    attributes: {
      unitType: 'module',
      identity: `${input.artifactId}:${relativePath}`,
      name: moduleName,
      qualifiedName: module.archivePath.replace(/\.pyc$/i, '').replaceAll('/', '.'),
      relativePath,
      sizeBytes: module.sizeBytes,
      language: 'Python',
      decompiler: 'pycdc',
      representation: 'extracted Python bytecode',
      representationSemantics: 'Bytecode recovered from a PyInstaller archive; source reconstruction has not yet completed.',
      decompiled: false,
      sourceExecutableArtifactId: input.artifactId || '',
      sourceExecutableSha256: executableSha256,
      pyinstallerExtractorRevision: extractorRevision,
      pyinstallerArchivePath: module.archivePath,
      extractedBytecodeArtifactId: bytecodeArtifactId,
      extractedBytecodeSha256: module.sha256,
      extractedBytecodeSizeBytes: module.sizeBytes,
      moduleIdentity,
    },
  }
}

function timeoutSignal(input: ToolExecutionInput): AbortSignal {
  const timeout = AbortSignal.timeout(MAX_REQUEST_TIMEOUT_MS)
  return input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
}

export async function executePyInstaller(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: pyinstallerManifest.id,
    capabilities: pyinstallerManifest.capabilities,
    produced: pyinstallerManifest.produces,
  }
  if (input.targetProfile.metadata.containerFormat !== 'pyinstaller') {
    return { status: 'failed', ...base, data: {}, error: 'Input is not profiled as a PyInstaller executable' }
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'PyInstaller recovery requires a stored executable and task context' }
  }
  const extractorUrl = process.env.REAMON_PYINSTALLER_URL?.trim().replace(/\/$/, '')
  if (!extractorUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated PyInstaller analyzer is not configured' }

  const signal = timeoutSignal(input)
  try {
    await input.reportProgress?.('Extracting bounded Python bytecode modules from the PyInstaller archive')
    const response = await fetch(`${extractorUrl}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        projectId: input.projectId,
        artifactId: input.artifactId,
        taskId: input.taskId,
        runId: input.runToken,
        artifactPath: input.artifactPath,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error.slice(0, 1_000)
        : `PyInstaller analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('PyInstaller analyzer returned an invalid bounded module list')

    const executableSha256 = await sha256File(input.artifactPath)
    const orderedModules = [...payload.modules].sort((left, right) => {
      const leftNested = left.archivePath.includes('/') ? 1 : 0
      const rightNested = right.archivePath.includes('/') ? 1 : 0
      return leftNested - rightNested || left.archivePath.localeCompare(right.archivePath)
    })
    const priorDecompiled = await prisma.reamonObservation.findMany({
      where: {
        projectId: input.projectId,
        artifactId: input.artifactId,
        source: pyinstallerManifest.id,
        type: 'code_unit',
        AND: [
          { attributes: { path: ['decompiled'], equals: true } },
          { attributes: { path: ['sourceExecutableSha256'], equals: executableSha256 } },
        ],
      },
      select: { stableKey: true },
      take: 10_000,
    })
    const decompiledKeys = new Set(priorDecompiled.map((row) => row.stableKey))
    const alreadyDecompiledCount = orderedModules.filter((module) => {
      const logicalPath = safeArchivePath(module.archivePath)
      if (!logicalPath) return false
      const moduleIdentity = createHash('sha256').update(`${logicalPath}\0${module.sha256}`).digest('hex')
      const relativePath = moduleSourcePath(input.artifactRelativePath, input.artifactId!, logicalPath, moduleIdentity)
      return decompiledKeys.has(moduleCodeUnitKey(input.artifactId!, relativePath))
    }).length
    const modulesNeedingSource = orderedModules.filter((module) => {
      const logicalPath = safeArchivePath(module.archivePath)
      if (!logicalPath) return true
      const moduleIdentity = createHash('sha256').update(`${logicalPath}\0${module.sha256}`).digest('hex')
      const relativePath = moduleSourcePath(input.artifactRelativePath, input.artifactId!, logicalPath, moduleIdentity)
      return !decompiledKeys.has(moduleCodeUnitKey(input.artifactId!, relativePath))
    })
    const selectedModules = modulesNeedingSource.slice(0, MAX_MODULES_TO_DECOMPILE)
    const observations: ToolObservation[] = []
    const warnings: string[] = []
    let codeBytes = 0
    let decompiledCount = 0
    await input.reportProgress?.(`Found ${payload.moduleCount} bounded bytecode modules; ${alreadyDecompiledCount} already have source and ${modulesNeedingSource.length} need decompilation`)

    const modulePaths = new Map<string, { relativePath: string; bytecodeArtifactId: string; moduleIdentity: string; bytecodePath: string }>()
    for (const module of orderedModules) {
      const logicalArchivePath = safeArchivePath(module.archivePath)
      if (!logicalArchivePath) {
        warnings.push(`${module.archivePath}: extractor returned an unsafe archive member path`)
        continue
      }
      const bytecode = Buffer.from(module.dataBase64, 'base64')
      if (bytecode.length !== module.sizeBytes || bytecode.subarray(0, 4).toString('hex') !== module.magicHex
          || createHash('sha256').update(bytecode).digest('hex') !== module.sha256) {
        warnings.push(`${logicalArchivePath}: extracted bytecode integrity check failed`)
        continue
      }
      const moduleIdentity = createHash('sha256').update(`${logicalArchivePath}\0${module.sha256}`).digest('hex')
      const relativeBytecodePath = path.posix.join(
        input.projectId, input.artifactId, input.taskId, input.runToken, 'pyinstaller', `${moduleIdentity}.pyc`,
      )
      const bytecodePath = resolveDerivedArtifactPath(relativeBytecodePath)
      const sourceRelativePath = moduleSourcePath(input.artifactRelativePath, input.artifactId, logicalArchivePath, moduleIdentity)
      try {
        await persistBytecode(relativeBytecodePath, bytecodePath, bytecode, module.sha256)
        modulePaths.set(moduleIdentity, { relativePath: sourceRelativePath, bytecodeArtifactId: relativeBytecodePath, moduleIdentity, bytecodePath })
        const alreadyDecompiled = decompiledKeys.has(moduleCodeUnitKey(input.artifactId!, sourceRelativePath))
        if (!selectedModules.includes(module) && !alreadyDecompiled) {
          observations.push(extractedModuleObservation(input, { ...module, archivePath: logicalArchivePath }, sourceRelativePath, relativeBytecodePath, moduleIdentity, executableSha256, payload.extractorRevision))
        }
      } catch (error) {
        warnings.push(`${logicalArchivePath}: ${errorText(error)}`)
      }
    }
    await input.reportProgress?.(`Persisted ${modulePaths.size} of ${payload.moduleCount} extracted bytecode modules; decompiling up to ${selectedModules.length} pending modules`)

    for (let offset = 0; offset < selectedModules.length; offset += 2) {
      const batch = selectedModules.slice(offset, offset + 2)
      const results = await Promise.allSettled(batch.map(async (module) => {
        const logicalArchivePath = safeArchivePath(module.archivePath)
        if (!logicalArchivePath) throw new Error('Extractor returned an unsafe archive member path')
        const moduleIdentity = createHash('sha256').update(`${logicalArchivePath}\0${module.sha256}`).digest('hex')
        const persisted = modulePaths.get(moduleIdentity)
        if (!persisted) throw new Error('Extracted bytecode was not safely persisted')
        const { relativePath: sourceRelativePath, bytecodeArtifactId, bytecodePath } = persisted
        const pycdcResult = await executePycdc({
          ...input,
          targetProfile: { ...input.targetProfile, format: 'python-bytecode', extension: 'pyc' },
          artifactPath: bytecodePath,
          artifactRelativePath: sourceRelativePath,
        })
        if (pycdcResult.status !== 'completed') {
          throw new Error(pycdcResult.error || `pycdc failed for ${logicalArchivePath}`)
        }
        const data = pycdcResult.data
        const moduleObservations = Array.isArray(data.observations)
          ? data.observations.filter(isCodeUnitObservation)
          : []
        if (!moduleObservations.length) {
          throw new Error(`pycdc returned no source unit for ${logicalArchivePath}`)
        }
        const enriched = moduleObservations.map((observation) => ({
          ...observation,
          label: path.posix.basename(logicalArchivePath).replace(/\.pyc$/i, '').slice(0, 500) || 'module',
          attributes: {
            ...observation.attributes,
            name: path.posix.basename(logicalArchivePath).replace(/\.pyc$/i, '').slice(0, 500) || 'module',
            qualifiedName: logicalArchivePath.replace(/\.pyc$/i, '').replaceAll('/', '.'),
            relativePath: sourceRelativePath,
            sourceExecutableArtifactId: input.artifactId!,
            sourceExecutableSha256: executableSha256,
            pyinstallerExtractorRevision: payload.extractorRevision,
            pyinstallerArchivePath: logicalArchivePath,
            extractedBytecodeArtifactId: bytecodeArtifactId,
            extractedBytecodeSha256: module.sha256,
          },
        }))
        return { observations: enriched, codeBytes: typeof data.codeBytes === 'number' ? data.codeBytes : 0, warnings: typeof data.warnings === 'string' ? data.warnings : '' }
      }))

      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]
        if (result.status === 'fulfilled') {
          observations.push(...result.value.observations)
          codeBytes += result.value.codeBytes
          decompiledCount += result.value.observations.length
          if (result.value.warnings) warnings.push(result.value.warnings)
        } else {
          const module = batch[index]
          warnings.push(`${module.archivePath}: ${errorText(result.reason)}`)
          const logicalArchivePath = safeArchivePath(module.archivePath)
          const moduleIdentity = logicalArchivePath
            ? createHash('sha256').update(`${logicalArchivePath}\0${module.sha256}`).digest('hex')
            : undefined
          const persisted = moduleIdentity ? modulePaths.get(moduleIdentity) : undefined
          if (logicalArchivePath && persisted) {
            const extracted = orderedModules.find((candidate) => candidate.archivePath === module.archivePath)
            if (extracted) observations.push(extractedModuleObservation(
              input,
              { ...extracted, archivePath: logicalArchivePath },
              persisted.relativePath,
              persisted.bytecodeArtifactId,
              persisted.moduleIdentity,
              executableSha256,
              payload.extractorRevision,
            ))
          }
        }
      }
      await input.reportProgress?.(`Decompiled ${decompiledCount} of ${selectedModules.length} selected pending modules; ${modulePaths.size} bytecode modules are stored`)
    }

    const truncated = payload.truncated || modulesNeedingSource.length > selectedModules.length
    if (truncated) warnings.unshift(`Decompiled up to ${selectedModules.length} new module(s) from ${payload.moduleCount} extracted module(s); previously decompiled modules were skipped and each run is capped.`)
    if (!observations.length && modulePaths.size === 0) throw new Error(warnings[0] || 'No extracted Python modules could be stored')
    if (!observations.length) warnings.unshift('All bounded extracted modules already have hash-matched recovered source in this project.')
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        extractedModuleCount: payload.moduleCount,
        storedBytecodeModuleCount: modulePaths.size,
        decompiledModuleCount: decompiledCount,
        returnedModuleCount: observations.length,
        codeBytes,
        truncated,
        extractorRevision: payload.extractorRevision,
        pycdcVersion: '0.6.0',
        executableSha256,
        warnings: warnings.join('\n').slice(0, 4_000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const pyinstallerPlugin: ToolPlugin = { manifest: pyinstallerManifest, analyze: executePyInstaller }
