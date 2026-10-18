import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_METHODS = 50_000
const MAX_LIBRARY_PATHS = 4
const MAX_TIMEOUT_MS = 20 * 60_000

interface Il2CppDumperMethod {
  libraryPath: string
  librarySha256: string
  rva: string
  name: string
  signature: string
  typeSignature: string
}

interface Il2CppDumperLibrary {
  memberPath: string
  sha256: string
  sizeBytes: number
  methodCount: number
}

interface Il2CppDumperResponse {
  status: 'completed'
  providerRevision: string
  apkSha256: string
  metadata: { memberPath: string; sha256: string; sizeBytes: number }
  libraries: Il2CppDumperLibrary[]
  methods: Il2CppDumperMethod[]
  methodCount: number
  returnedMethodCount: number
  truncated: boolean
  elapsedMs: number
}

export const il2CppDumperManifest: ToolPluginManifest = {
  id: 'reamon-il2cppdumper',
  name: 'Il2CppDumper Unity Metadata Mapper',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['apk'],
  acceptsMetadata: { containerFormat: 'unity-il2cpp' },
  capabilities: ['recover_metadata'],
  produces: ['Il2CppMethodMetadata', 'NativeMethodAddress'],
  requirements: [
    { key: 'service', value: 'Isolated Il2CppDumper analyzer' },
    { key: 'artifactPath' },
    { key: 'unityIl2CppMetadataPath' },
    { key: 'unityIl2CppLibraryPaths' },
  ],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function isMethod(value: unknown): value is Il2CppDumperMethod {
  if (!isRecord(value)) return false
  return typeof value.rva === 'string' && /^0x[0-9a-f]{1,16}$/i.test(value.rva)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 1000
    && typeof value.signature === 'string' && value.signature.length <= 2000
    && typeof value.typeSignature === 'string' && value.typeSignature.length <= 1000
}

function isResponse(value: unknown): value is Il2CppDumperResponse {
  if (!isRecord(value) || !Array.isArray(value.libraries) || !isRecord(value.metadata)) return false
  return value.status === 'completed'
    && typeof value.providerRevision === 'string' && value.providerRevision.length <= 64
    && isSha256(value.apkSha256)
    && typeof value.metadata.memberPath === 'string' && value.metadata.memberPath.length <= 1000
    && isSha256(value.metadata.sha256)
    && Number.isSafeInteger(value.metadata.sizeBytes) && Number(value.metadata.sizeBytes) > 0
    && value.libraries.length > 0 && value.libraries.length <= MAX_LIBRARY_PATHS
    && value.libraries.every((library) => isRecord(library)
      && typeof library.memberPath === 'string' && library.memberPath.length <= 1000
      && isSha256(library.sha256)
      && Number.isSafeInteger(library.sizeBytes) && Number(library.sizeBytes) > 0
      && Number.isSafeInteger(library.methodCount) && Number(library.methodCount) >= 0)
    && Array.isArray(value.methods) && value.methods.length <= MAX_METHODS
    && value.methods.every((method) => isMethod(method) && typeof method.libraryPath === 'string'
      && method.libraryPath.length <= 1000 && isSha256(method.librarySha256))
    && Number.isSafeInteger(value.methodCount) && Number(value.methodCount) >= 0
    && Number.isSafeInteger(value.returnedMethodCount) && Number(value.returnedMethodCount) >= 0
    && typeof value.truncated === 'boolean'
    && Number.isSafeInteger(value.elapsedMs) && Number(value.elapsedMs) >= 0
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function methodKey(artifactId: string, librarySha256: string, rva: string, name: string, signature: string): string {
  return `il2cpp-method:${createHash('sha256').update(`${artifactId}:${librarySha256}:${rva}:${name}:${signature}`).digest('hex').slice(0, 40)}`
}

export async function executeIl2CppDumper(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: il2CppDumperManifest.id,
    capabilities: il2CppDumperManifest.capabilities,
    produced: il2CppDumperManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Il2CppDumper requires a stored APK and task context' }
  }
  if (input.targetProfile.metadata.containerFormat !== 'unity-il2cpp') {
    return { status: 'failed', ...base, data: {}, error: 'Input is not profiled as a Unity IL2CPP APK' }
  }

  const metadataPath = input.targetProfile.metadata.unityIl2CppMetadataPath
  const libraryPathsValue = input.targetProfile.metadata.unityIl2CppLibraryPaths
  if (typeof metadataPath !== 'string' || !/(?:^|\/)global-metadata\.dat$/i.test(metadataPath)
      || typeof libraryPathsValue !== 'string') {
    return { status: 'failed', ...base, data: {}, error: 'The profiled APK is missing exact IL2CPP member paths' }
  }
  const profiledLibraryPaths = [...new Set(libraryPathsValue.split('\n').filter((memberPath) => /^lib\/[^/]+\/libil2cpp\.so$/i.test(memberPath)))]
  const libraryPaths = profiledLibraryPaths.slice(0, MAX_LIBRARY_PATHS)
  if (!libraryPaths.length) return { status: 'failed', ...base, data: {}, error: 'The profiled APK contains no supported libil2cpp.so path' }

  const analyzerUrl = process.env.REAMON_IL2CPP_URL?.trim().replace(/\/$/, '')
  if (!analyzerUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Il2CppDumper analyzer is not configured' }
  const timeout = AbortSignal.timeout(MAX_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    await input.reportProgress?.(`Extracting IL2CPP metadata and analyzing ${libraryPaths.length} native library member${libraryPaths.length === 1 ? '' : 's'}`)
    const response = await fetch(`${analyzerUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        projectId: input.projectId,
        artifactId: input.artifactId,
        taskId: input.taskId,
        runId: input.runToken,
        artifactPath: input.artifactPath,
        metadataPath,
        libraryPaths,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error.slice(0, 1000)
        : `Il2CppDumper analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('Il2CppDumper analyzer returned an invalid metadata result')
    const inputSha256 = await sha256File(input.artifactPath)
    if (payload.apkSha256.toLowerCase() !== inputSha256) throw new Error('Il2CppDumper analyzed a different APK version')
    if (payload.metadata.memberPath !== metadataPath) throw new Error('Il2CppDumper analyzed a different global-metadata.dat member')
    if (payload.libraries.some((library) => !libraryPaths.includes(library.memberPath))) {
      throw new Error('Il2CppDumper returned an unrequested native library member')
    }
    const libraryByPath = new Map(payload.libraries.map((library) => [library.memberPath, library]))
    if (payload.methods.some((method) => {
      const library = libraryByPath.get(method.libraryPath)
      return !library || library.sha256.toLowerCase() !== method.librarySha256.toLowerCase()
    })) throw new Error('Il2CppDumper returned a method mapped to an unverified native library')

    const observations: ToolObservation[] = payload.methods.map((method) => {
      const library = libraryByPath.get(method.libraryPath)!
      return {
        kind: 'entity',
        type: 'il2cpp_method_metadata',
        key: methodKey(input.artifactId!, library.sha256, method.rva, method.name, method.signature),
        label: method.name,
        attributes: {
          name: method.name,
          signature: method.signature,
          typeSignature: method.typeSignature,
          address: method.rva,
          addressKind: 'Il2CppDumper RVA; native identity not yet verified against Ghidra address space',
          nativeLibraryMemberPath: library.memberPath,
          nativeLibrarySha256: library.sha256.toLowerCase(),
          nativeLibrarySizeBytes: library.sizeBytes,
          metadataMemberPath: payload.metadata.memberPath,
          metadataSha256: payload.metadata.sha256.toLowerCase(),
          inputArtifactSha256: inputSha256,
          provider: 'Il2CppDumper',
          providerRevision: payload.providerRevision,
          representation: 'metadata mapping; method body not recovered',
        },
      }
    })
    if (!observations.length) throw new Error('Il2CppDumper found no method address mappings')
    await input.reportProgress?.(`Stored ${observations.length.toLocaleString()} of ${payload.methodCount.toLocaleString()} method metadata mappings`)

    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        metadataOnly: true,
        sourceRecovery: false,
        providerRevision: payload.providerRevision,
        inputArtifactSha256: inputSha256,
        metadataMemberPath: payload.metadata.memberPath,
        metadataSha256: payload.metadata.sha256,
        discoveredMethodCount: payload.methodCount,
        returnedMethodCount: observations.length,
        analyzedLibraryCount: payload.libraries.length,
        librariesTruncated: payload.truncated || profiledLibraryPaths.length > libraryPaths.length
          || input.targetProfile.metadata.unityIl2CppLibraryPathsTruncated === true,
        elapsedMs: payload.elapsedMs,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: error instanceof Error ? error.message.slice(0, 4000) : 'Il2CppDumper analysis failed' }
  }
}

export const il2CppDumperPlugin: ToolPlugin = {
  manifest: il2CppDumperManifest,
  analyze: executeIl2CppDumper,
}
