import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const RETDEC_COMMIT = '9450585772e6f1c18e5f0b2ad5518a18d6bce71e'
const DEFAULT_TIMEOUT_MS = 20 * 60_000

interface RetdecResponse {
  status: 'completed'
  toolVersion: `retdec@${string}`
  inputName: string
  artifactSha256: string
  sourceBytes: number
  sourceSha256: string
  tokenCount: number
  sourceAddressMap: Array<{ sourceLineNumber: number; address: string }>
  sourceAddressMapTruncated: boolean
  codeArtifactId: string
  disassemblyArtifactId: string | null
  disassemblySha256: string | null
  disassemblyBytes: number
  rawTokenArtifactId: string
  rawTokenSha256: string
  rawTokenBytes: number
  warnings: string
}

export const retdecManifest: ToolPluginManifest = {
  id: 'reamon-retdec',
  name: 'RetDec Native Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile', 'disassemble'],
  produces: ['CodeUnit', 'DecompiledSource', 'Disassembly', 'SourceAddressMapping'],
  requirements: [
    { key: 'service', value: 'RetDec isolated analyzer container' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'RetDec analysis failed'
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function isRetdecResponse(value: unknown): value is RetdecResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && record.toolVersion === `retdec@${RETDEC_COMMIT}`
    && typeof record.inputName === 'string' && record.inputName.length <= 1000
    && typeof record.artifactSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.artifactSha256)
    && Number.isSafeInteger(record.sourceBytes) && Number(record.sourceBytes) > 0 && Number(record.sourceBytes) <= 64 * 1024 * 1024
    && typeof record.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.sourceSha256)
    && Number.isSafeInteger(record.tokenCount) && Number(record.tokenCount) >= 1 && Number(record.tokenCount) <= 2_000_000
    && Array.isArray(record.sourceAddressMap) && record.sourceAddressMap.length <= 5000
    && record.sourceAddressMap.every((mapping) => mapping && typeof mapping === 'object'
      && Number.isInteger(mapping.sourceLineNumber) && mapping.sourceLineNumber > 0 && mapping.sourceLineNumber <= 1_000_000
      && typeof mapping.address === 'string' && /^0x[0-9a-f]{1,16}$/i.test(mapping.address))
    && typeof record.sourceAddressMapTruncated === 'boolean'
    && typeof record.codeArtifactId === 'string'
    && (record.disassemblyArtifactId === null || typeof record.disassemblyArtifactId === 'string')
    && (record.disassemblySha256 === null || (typeof record.disassemblySha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.disassemblySha256)))
    && Number.isSafeInteger(record.disassemblyBytes) && Number(record.disassemblyBytes) >= 0 && Number(record.disassemblyBytes) <= 256 * 1024 * 1024
    && typeof record.rawTokenArtifactId === 'string' && record.rawTokenArtifactId.length <= 2000
    && typeof record.rawTokenSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.rawTokenSha256)
    && Number.isSafeInteger(record.rawTokenBytes) && Number(record.rawTokenBytes) > 0 && Number(record.rawTokenBytes) <= 128 * 1024 * 1024
    && typeof record.warnings === 'string' && record.warnings.length <= 4000
}

export async function executeRetdec(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: retdecManifest.id,
    capabilities: retdecManifest.capabilities,
    produced: retdecManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'RetDec requires a stored native binary and task context' }
  }
  const baseUrl = process.env.REAMON_RETDEC_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated RetDec analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_RETDEC_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `RetDec analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isRetdecResponse(payload)) throw new Error('RetDec analyzer returned an invalid result')

    const prefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
    const sourcePath = `${prefix}sources/program.c`
    const evidencePath = `${prefix}evidence/`
    if (payload.codeArtifactId !== sourcePath
      || payload.rawTokenArtifactId !== `${evidencePath}retdec-tokens.json`
      || (payload.disassemblyArtifactId !== null && payload.disassemblyArtifactId !== `${evidencePath}program.dsm`)) {
      throw new Error('RetDec analyzer returned a code artifact outside the active task run')
    }
    const identity = `${input.artifactId}:retdec:module`
    const unitKey = `retdec:module:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
    const observation: ToolObservation = {
      kind: 'entity',
      type: 'code_unit',
      key: unitKey,
      label: input.artifactRelativePath?.split(/[\\/]/).filter(Boolean).pop() || payload.inputName,
      attributes: {
        unitType: 'module',
        identity,
        name: input.artifactRelativePath?.split(/[\\/]/).filter(Boolean).pop() || payload.inputName,
        language: 'C',
        sourceLanguage: 'unknown native source language',
        sizeBytes: payload.sourceBytes,
        languageFlavor: 'C-like pseudocode',
        relativePath: 'program.c',
        decompiled: true,
        codeArtifactId: payload.codeArtifactId,
        decompilationEngine: 'RetDec',
        decompilationEngineVersion: payload.toolVersion,
        inputArtifactSha256: payload.artifactSha256,
        decompiledSourceSha256: payload.sourceSha256,
        rawEvidenceArtifactId: payload.rawTokenArtifactId,
        rawEvidenceSha256: payload.rawTokenSha256,
        rawEvidenceSizeBytes: payload.rawTokenBytes,
        tokenCount: payload.tokenCount,
        sourceAddressMap: JSON.stringify(payload.sourceAddressMap),
        sourceAddressMapProvider: 'RetDec',
        sourceAddressMapTruncated: payload.sourceAddressMapTruncated,
        ...(payload.disassemblyArtifactId ? {
          disassemblyArtifactId: payload.disassemblyArtifactId,
          disassemblyLanguage: 'Assembly',
          disassemblySha256: payload.disassemblySha256 || '',
          disassemblyBytes: payload.disassemblyBytes,
        } : {}),
      },
    }
    return {
      status: 'completed',
      ...base,
      data: {
        observations: [observation],
        decompiledCodeUnitCount: 1,
        returnedCodeUnitCount: 1,
        tokenCount: payload.tokenCount,
        sourceBytes: payload.sourceBytes,
        sourceAddressMappingCount: payload.sourceAddressMap.length,
        sourceAddressMapTruncated: payload.sourceAddressMapTruncated,
        disassemblyBytes: payload.disassemblyBytes,
        retdecVersion: payload.toolVersion,
        warnings: payload.warnings,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const retdecPlugin: ToolPlugin = { manifest: retdecManifest, analyze: executeRetdec }
