import { createHash } from 'node:crypto'
import { runBoundedProcess } from './bounded-process'
import type { ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult, ToolObservation } from './types'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_DEPENDENCIES = 75
const MAX_SYMBOLS_PER_DIRECTION = 80

export const elfDependenciesManifest: ToolPluginManifest = {
  id: 'reamon-elf-dependencies',
  name: 'REAmon ELF Dependency Inspector',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf'],
  capabilities: ['extract_dependencies'],
  produces: ['BinaryDependency', 'BinarySymbol', 'Relationship'],
  requirements: [
    { key: 'executable', value: 'readelf' },
    { key: 'artifactPath' },
  ],
}

export interface ElfSymbol {
  name: string
  version: string | null
  direction: 'import' | 'export'
}

export interface ElfDependencies {
  needed: string[]
  soname: string | null
  rpath: string[]
  runpath: string[]
  importedSymbols: ElfSymbol[]
  exportedSymbols: ElfSymbol[]
  truncated: boolean
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'ELF dependency provider failed'
}

function values(output: string, tag: string): string[] {
  const result: string[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('(' + tag + ')')) continue
    const match = line.match(/\[([^\]]+)\]/)
    if (match?.[1]) result.push(match[1].trim().slice(0, 512))
  }
  return [...new Set(result)]
}

export function parseElfDependencies(dynamicOutput: string, symbolOutput: string): ElfDependencies {
  const needed = values(dynamicOutput, 'NEEDED')
  const soname = values(dynamicOutput, 'SONAME')[0] || null
  const rpath = values(dynamicOutput, 'RPATH')
  const runpath = values(dynamicOutput, 'RUNPATH')
  const importedSymbols: ElfSymbol[] = []
  const exportedSymbols: ElfSymbol[] = []
  const seen = new Set<string>()
  let truncated = false

  for (const line of symbolOutput.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+:\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(.+?)\s*$/)
    if (!match) continue
    const section = match[1]
    const rawName = match[2].replace(/\s+\(\d+\)$/, '').trim()
    if (!rawName || rawName === '0' || rawName.startsWith('<')) continue
    const direction = section === 'UND' ? 'import' : 'export'
    const [name, version = ''] = rawName.split(/@@?/, 2)
    if (!name || name.length > 512) continue
    const identity = direction + ':' + rawName
    if (seen.has(identity)) continue
    seen.add(identity)
    const target = direction === 'import' ? importedSymbols : exportedSymbols
    if (target.length >= MAX_SYMBOLS_PER_DIRECTION) {
      truncated = true
      continue
    }
    target.push({ name, version: version || null, direction })
  }

  return { needed, soname, rpath, runpath, importedSymbols, exportedSymbols, truncated }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function observationsFor(input: ToolExecutionInput, parsed: ElfDependencies): ToolObservation[] {
  const artifactId = input.artifactId || 'unknown'
  const binaryKey = 'artifact:' + artifactId + ':binary'
  const observations: ToolObservation[] = [{
    kind: 'entity',
    type: 'binary',
    key: binaryKey,
    label: input.targetProfile.format + ' binary',
    attributes: { identity: artifactId, format: 'elf', architecture: input.targetProfile.architecture },
  }]

  for (const libraryName of parsed.needed.slice(0, MAX_DEPENDENCIES)) {
    const libraryKey = 'artifact:' + artifactId + ':library:' + digest(libraryName)
    observations.push({
      kind: 'entity',
      type: 'binary_library',
      key: libraryKey,
      label: libraryName,
      attributes: { identity: libraryName, libraryName, linkage: 'dynamic' },
    })
    observations.push({
      kind: 'relationship',
      type: 'depends_on',
      relation: 'depends_on',
      key: 'artifact:' + artifactId + ':dependency:' + digest(libraryName),
      fromKey: binaryKey,
      toKey: libraryKey,
      label: libraryName,
      attributes: {},
    })
  }

  for (const symbol of [...parsed.importedSymbols, ...parsed.exportedSymbols]) {
    const qualifiedName = symbol.name + (symbol.version ? '@' + symbol.version : '')
    const symbolKey = 'artifact:' + artifactId + ':symbol:' + symbol.direction + ':' + digest(qualifiedName)
    observations.push({
      kind: 'entity',
      type: 'binary_symbol',
      key: symbolKey,
      label: qualifiedName,
      attributes: { identity: symbol.direction + ':' + qualifiedName, name: symbol.name, version: symbol.version, direction: symbol.direction },
    })
    observations.push({
      kind: 'relationship',
      type: symbol.direction === 'import' ? 'imports_symbol' : 'exports_symbol',
      relation: symbol.direction === 'import' ? 'imports_symbol' : 'exports_symbol',
      key: 'artifact:' + artifactId + ':' + symbol.direction + ':' + digest(qualifiedName),
      fromKey: binaryKey,
      toKey: symbolKey,
      label: qualifiedName,
      attributes: {},
    })
  }

  return observations
}

export async function executeElfDependencyInspection(input: ToolExecutionInput): Promise<ToolResult> {
  const baseResult = {
    toolId: elfDependenciesManifest.id,
    capabilities: elfDependenciesManifest.capabilities,
    produced: elfDependenciesManifest.produces,
  }
  if (!input.artifactPath) {
    return { status: 'failed', ...baseResult, data: {}, error: 'Controlled artifact path is required' }
  }

  const timeoutMs = boundedEnvNumber('REAMON_PROCESS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS)
  const configured = Number(input.options?.maxOutputBytes)
  const configuredOutput = Number.isFinite(configured) ? Math.min(MAX_OUTPUT_BYTES, Math.max(4 * 1024, Math.floor(configured))) : boundedEnvNumber('REAMON_MAX_PROCESS_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES, 4 * 1024, MAX_OUTPUT_BYTES)

  try {
    const [dynamic, symbols] = await Promise.all([
      runBoundedProcess({
        executable: 'readelf',
        args: ['-dW', '--', input.artifactPath],
        signal: input.signal,
        maxOutputBytes: configuredOutput,
        timeoutMs,
        timeoutError: (value) => 'readelf dependency inspection timed out after ' + Math.ceil(value / 1000) + ' seconds',
      }),
      runBoundedProcess({
        executable: 'readelf',
        args: ['--dyn-syms', '--wide', '--', input.artifactPath],
        signal: input.signal,
        maxOutputBytes: configuredOutput,
        timeoutMs,
        timeoutError: (value) => 'readelf symbol inspection timed out after ' + Math.ceil(value / 1000) + ' seconds',
      }),
    ])
    const parsed = parseElfDependencies(dynamic.stdout, symbols.stdout)
    if (!parsed.needed.length && !parsed.soname && !parsed.importedSymbols.length && !parsed.exportedSymbols.length) {
      return { status: 'failed', ...baseResult, data: {}, error: 'ELF has no dynamic dependency or symbol data to inspect' }
    }

    const observations = observationsFor(input, parsed)
    return {
      status: 'completed',
      ...baseResult,
      data: {
        neededLibraries: parsed.needed.slice(0, MAX_DEPENDENCIES),
        soname: parsed.soname,
        rpath: parsed.rpath,
        runpath: parsed.runpath,
        importedSymbols: parsed.importedSymbols,
        exportedSymbols: parsed.exportedSymbols,
        importedSymbolCount: parsed.importedSymbols.length,
        exportedSymbolCount: parsed.exportedSymbols.length,
        truncated: dynamic.truncated || symbols.truncated || parsed.truncated || parsed.needed.length > MAX_DEPENDENCIES,
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...baseResult, data: {}, error: boundedError(error) }
  }
}

export const elfDependenciesPlugin: ToolPlugin = {
  manifest: elfDependenciesManifest,
  analyze: executeElfDependencyInspection,
}
