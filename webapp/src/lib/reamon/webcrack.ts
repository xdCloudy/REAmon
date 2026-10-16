import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_UNITS = 501

interface WebcrackUnit {
  name: string
  type: 'file' | 'module'
  bundlePath: string
  moduleId: string
  codeArtifactId: string
  sizeBytes: number
}

interface WebcrackResponse {
  status: 'completed'
  toolVersion: string
  input: { relativePath: string; sha256: string }
  bundleType: string | null
  units: WebcrackUnit[]
  codeBytes: number
  truncated: boolean
  warnings?: string
}

export const webcrackManifest: ToolPluginManifest = {
  id: 'reamon-webcrack',
  name: 'JavaScript Deobfuscator (webcrack)',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['javascript-source'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DeobfuscatedSource', 'JavaScriptModule'],
  requirements: [
    { key: 'service', value: 'Isolated webcrack analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4_000) || 'webcrack analysis failed'
}

function timeoutMs(): number {
  const value = Number(process.env.REAMON_WEBCRACK_REQUEST_TIMEOUT_MS)
  return Number.isFinite(value) ? Math.min(MAX_TIMEOUT_MS, Math.max(10_000, Math.floor(value))) : DEFAULT_TIMEOUT_MS
}

function isResponse(value: unknown): value is WebcrackResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  if (!response.input || typeof response.input !== 'object' || Array.isArray(response.input)) return false
  const input = response.input as Record<string, unknown>
  if (!Array.isArray(response.units) || response.units.length < 1 || response.units.length > MAX_UNITS) return false
  return response.status === 'completed'
    && typeof response.toolVersion === 'string'
    && typeof input.relativePath === 'string' && input.relativePath.length > 0 && input.relativePath.length <= 1_000
    && typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(input.sha256)
    && (response.bundleType === null || typeof response.bundleType === 'string')
    && Number.isSafeInteger(response.codeBytes) && (response.codeBytes as number) > 0
    && typeof response.truncated === 'boolean'
    && response.units.every((unit) => !!unit && typeof unit === 'object' && !Array.isArray(unit)
      && typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
      && (unit.type === 'file' || unit.type === 'module')
      && typeof unit.bundlePath === 'string' && unit.bundlePath.length <= 1_000
      && typeof unit.moduleId === 'string' && unit.moduleId.length <= 500
      && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId.length > 0 && unit.codeArtifactId.length <= 2_000
      && Number.isSafeInteger(unit.sizeBytes) && unit.sizeBytes > 0)
    && (response.warnings === undefined || typeof response.warnings === 'string')
}

export async function executeWebcrack(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: webcrackManifest.id,
    capabilities: webcrackManifest.capabilities,
    produced: webcrackManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'webcrack requires a stored JavaScript artifact and task context' }
  }

  const baseUrl = process.env.REAMON_WEBCRACK_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated webcrack analyzer is not configured' }

  const timeout = AbortSignal.timeout(timeoutMs())
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        projectId: input.projectId,
        artifactId: input.artifactId,
        taskId: input.taskId,
        runId: input.runToken,
        artifactPath: input.artifactPath,
        artifactRelativePath: input.artifactRelativePath,
        extension: input.targetProfile.extension,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1_000)
        : `webcrack analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('webcrack analyzer returned an invalid result')

    const observations: ToolObservation[] = payload.units.map((unit) => {
      const unitIdentity = unit.moduleId || unit.bundlePath || unit.name
      const identity = `${input.artifactId}:${payload.input.relativePath}:${unitIdentity}`
      const key = `webcrack:${unit.type}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
      return {
        kind: 'entity',
        type: 'code_unit',
        key,
        label: unit.name,
        attributes: {
          unitType: unit.type === 'module' ? 'module' : 'file',
          identity,
          name: unit.name,
          qualifiedName: unit.name,
          relativePath: payload.input.relativePath,
          bundlePath: unit.bundlePath,
          bundleModuleId: unit.moduleId,
          bundleType: payload.bundleType || '',
          sizeBytes: unit.sizeBytes,
          language: 'JavaScript',
          decompiled: true,
          deobfuscated: true,
          codeArtifactId: unit.codeArtifactId,
          inputSha256: payload.input.sha256,
          engineVersion: payload.toolVersion.slice(0, 80),
        },
      }
    })
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        decompiledModuleCount: payload.units.filter((unit) => unit.type === 'module').length,
        returnedModuleCount: payload.units.length,
        codeBytes: payload.codeBytes,
        truncated: payload.truncated,
        bundleType: payload.bundleType,
        inputSha256: payload.input.sha256,
        webcrackVersion: payload.toolVersion.slice(0, 80),
        warnings: (payload.warnings || '').slice(0, 4_000),
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const webcrackPlugin: ToolPlugin = { manifest: webcrackManifest, analyze: executeWebcrack }
