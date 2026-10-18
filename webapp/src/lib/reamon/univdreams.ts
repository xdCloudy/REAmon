import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const VERSION = '0.4.0'
const REVISION = 'f02c749da48a4f379210dfa72e7cb2ccfeaf1fc9'
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_ROUNDTRIP_BYTES = 512 * 1024 * 1024

interface UnivdreamsResponse {
  status: 'completed'
  toolVersion: typeof VERSION
  providerRevision: typeof REVISION
  sourceSha256: string
  sourceBytes: number
  sourceOutputSha256: string
  codeArtifactId: string
  inputBytes: number
  roundTripAvailable: boolean
  roundTripByteIdentical: boolean | null
  roundTripArtifactId: string | null
  roundTripSha256: string | null
  roundTripBytes: number
  roundTripError: string | null
  elapsedMs: number
  semantics: string
}

export const univdreamsManifest: ToolPluginManifest = {
  id: 'reamon-univdreams',
  name: 'univdreams Editable Binary View',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho', 'wasm', 'ne', 'raw'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'EditableBinaryView', 'RoundTripEvidence'],
  requirements: [
    { key: 'service', value: 'univdreams isolated analyzer' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'univdreams analysis failed'
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function isResponse(value: unknown): value is UnivdreamsResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const digest = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/i.test(item)
  return row.status === 'completed' && row.toolVersion === VERSION && row.providerRevision === REVISION
    && digest(row.sourceSha256) && digest(row.sourceOutputSha256)
    && Number.isSafeInteger(row.sourceBytes) && Number(row.sourceBytes) > 0 && Number(row.sourceBytes) <= MAX_SOURCE_BYTES
    && Number.isSafeInteger(row.inputBytes) && Number(row.inputBytes) > 0
    && typeof row.codeArtifactId === 'string'
    && typeof row.roundTripAvailable === 'boolean'
    && (row.roundTripByteIdentical === null || typeof row.roundTripByteIdentical === 'boolean')
    && (row.roundTripArtifactId === null || typeof row.roundTripArtifactId === 'string')
    && (row.roundTripSha256 === null || digest(row.roundTripSha256))
    && Number.isSafeInteger(row.roundTripBytes) && Number(row.roundTripBytes) >= 0 && Number(row.roundTripBytes) <= MAX_ROUNDTRIP_BYTES
    && (row.roundTripError === null || (typeof row.roundTripError === 'string' && row.roundTripError.length <= 1200))
    && Number.isSafeInteger(row.elapsedMs) && Number(row.elapsedMs) >= 0
    && typeof row.semantics === 'string' && row.semantics.length <= 1000
}

export async function executeUnivdreams(input: ToolExecutionInput): Promise<ToolResult> {
  const base = { toolId: univdreamsManifest.id, capabilities: univdreamsManifest.capabilities, produced: univdreamsManifest.produces }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'univdreams requires a stored binary and task context' }
  }
  const baseUrl = process.env.REAMON_UNIVDREAMS_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated univdreams analyzer is not configured' }
  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_UNIVDREAMS_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1200)
        : `univdreams analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('univdreams analyzer returned invalid provenance')

    const prefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
    if (payload.codeArtifactId !== `${prefix}sources/module.ud`
      || (payload.roundTripArtifactId !== null && payload.roundTripArtifactId !== `${prefix}evidence/roundtrip.bin`)
      || payload.roundTripAvailable !== (payload.roundTripArtifactId !== null)
      || payload.roundTripAvailable !== (payload.roundTripSha256 !== null)
      || (payload.roundTripAvailable && payload.roundTripBytes <= 0)
      || (!payload.roundTripAvailable && (payload.roundTripByteIdentical !== null || payload.roundTripBytes !== 0))) {
      throw new Error('univdreams analyzer returned an artifact outside the active task run')
    }

    const identity = `${input.artifactId}:univdreams:module`
    const unitKey = `univdreams:module:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
    const label = input.artifactRelativePath?.split(/[\\/]/).filter(Boolean).pop() || input.artifactId
    const observation: ToolObservation = {
      kind: 'entity',
      type: 'code_unit',
      key: unitKey,
      label,
      attributes: {
        unitType: 'module',
        identity,
        name: label,
        language: 'Universal Dreams',
        sourceLanguage: 'unknown binary source language',
        representation: 'Editable .ud binary specification',
        representationSemantics: payload.semantics,
        relativePath: 'module.ud',
        sizeBytes: payload.sourceBytes,
        decompiled: true,
        codeArtifactId: payload.codeArtifactId,
        decompiler: 'univdreams',
        decompilerVersion: payload.toolVersion,
        providerRevision: payload.providerRevision,
        inputArtifactSha256: payload.sourceSha256.toLowerCase(),
        decompiledSourceSha256: payload.sourceOutputSha256.toLowerCase(),
        roundTripAvailable: payload.roundTripAvailable,
        ...(payload.roundTripByteIdentical !== null ? { roundTripByteIdentical: payload.roundTripByteIdentical } : {}),
        ...(payload.roundTripArtifactId ? { roundTripArtifactId: payload.roundTripArtifactId } : {}),
        ...(payload.roundTripSha256 ? { roundTripSha256: payload.roundTripSha256.toLowerCase() } : {}),
        roundTripBytes: payload.roundTripBytes,
        ...(payload.roundTripError ? { roundTripError: payload.roundTripError } : {}),
        experimentalBinaryView: true,
      },
    }
    return {
      status: 'completed',
      ...base,
      data: {
        observations: [observation],
        decompiledCodeUnitCount: 1,
        returnedCodeUnitCount: 1,
        sourceSha256: payload.sourceSha256.toLowerCase(),
        sourceOutputSha256: payload.sourceOutputSha256.toLowerCase(),
        roundTripAvailable: payload.roundTripAvailable,
        roundTripByteIdentical: payload.roundTripByteIdentical,
        roundTripBytes: payload.roundTripBytes,
        elapsedMs: payload.elapsedMs,
        semantics: payload.semantics,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const univdreamsPlugin: ToolPlugin = { manifest: univdreamsManifest, analyze: executeUnivdreams }
