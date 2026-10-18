import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_OUTPUT_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 45_000

interface CrubyIseqResponse {
  status: 'completed'
  toolVersion: string
  runtimeVersion: string
  runtimeEngine: 'ruby'
  binarySignature: 'YARB'
  inputRelativePath: string
  inputSha256: string
  inputBytes: number
  outputRelativePath: string
  outputName: string
  outputSha256: string
  outputBytes: number
  instructionCount: number
  disassembly: string
  warnings: string
}

export const crubyIseqManifest: ToolPluginManifest = {
  id: 'reamon-cruby-iseq',
  name: 'CRuby YARV ISeq Inspector',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['cruby-iseq'],
  capabilities: ['inspect_bytecode'],
  produces: ['CodeUnit', 'BytecodeDisassembly'],
  requirements: [
    { key: 'service', value: 'Isolated CRuby 3.4.11 ISeq inspector' },
    { key: 'artifactPath' },
  ],
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isResponse(value: unknown): value is CrubyIseqResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return result.status === 'completed'
    && typeof result.toolVersion === 'string' && result.toolVersion.length <= 100
    && typeof result.runtimeVersion === 'string' && result.runtimeVersion.startsWith('ruby 3.4.11 ')
    && result.runtimeEngine === 'ruby'
    && result.binarySignature === 'YARB'
    && typeof result.inputRelativePath === 'string' && result.inputRelativePath.length > 0 && result.inputRelativePath.length <= 1_000
    && typeof result.inputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.inputSha256)
    && isSafeInteger(result.inputBytes, 8)
    && typeof result.outputRelativePath === 'string' && result.outputRelativePath.length > 0 && result.outputRelativePath.length <= 2_000
    && typeof result.outputName === 'string' && result.outputName.length > 0 && result.outputName.length <= 200
    && typeof result.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.outputSha256)
    && isSafeInteger(result.outputBytes, 1) && result.outputBytes <= MAX_OUTPUT_BYTES
    && isSafeInteger(result.instructionCount)
    && typeof result.disassembly === 'string' && Buffer.byteLength(result.disassembly, 'utf8') === result.outputBytes
    && typeof result.warnings === 'string' && result.warnings.length <= 1_000
}

export async function executeCrubyIseq(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: crubyIseqManifest.id,
    capabilities: crubyIseqManifest.capabilities,
    produced: crubyIseqManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken || !input.artifactRelativePath) {
    return { status: 'failed', ...base, data: {}, error: 'CRuby ISeq inspection requires a stored artifact and task context' }
  }

  const baseUrl = process.env.REAMON_CRUBY_ISEQ_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated CRuby ISeq inspector is not configured' }

  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetch(`${baseUrl}/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        projectId: input.projectId,
        artifactId: input.artifactId,
        taskId: input.taskId,
        runId: input.runToken,
        artifactPath: input.artifactPath,
        artifactRelativePath: input.artifactRelativePath,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1_000)
        : `CRuby ISeq inspector returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isResponse(payload)) throw new Error('CRuby ISeq inspector returned an invalid or unsupported result')

    const identity = `${input.artifactId}:${payload.inputRelativePath}`
    const key = `cruby-iseq:module:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`
    const observations: ToolObservation[] = [{
      kind: 'entity',
      type: 'code_unit',
      key,
      label: payload.outputName,
      attributes: {
        unitType: 'module',
        identity,
        name: payload.outputName,
        qualifiedName: payload.outputName,
        relativePath: payload.inputRelativePath,
        language: 'Ruby bytecode',
        sourceLanguage: 'Ruby',
        decompiler: 'CRuby ISeq inspector',
        decompilerVersion: payload.runtimeVersion,
        representation: 'YARV instruction disassembly',
        representationSemantics: 'Version-matched CRuby bytecode evidence. This listing is not recovered Ruby source; target instructions were not evaluated.',
        isExecutableSource: false,
        decompiled: false,
        codeArtifactId: payload.outputRelativePath,
        sizeBytes: payload.outputBytes,
        inputBytes: payload.inputBytes,
        inputSha256: payload.inputSha256,
        outputSha256: payload.outputSha256,
        codeArtifactSha256: payload.outputSha256,
        instructionCount: payload.instructionCount,
        runtimeVersion: payload.runtimeVersion,
        engineVersion: payload.toolVersion,
        binarySignature: payload.binarySignature,
        disassembly: payload.disassembly,
        evidenceWarning: payload.warnings,
      },
    }]

    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        inspectedModuleCount: 1,
        instructionCount: payload.instructionCount,
        inputSha256: payload.inputSha256,
        outputSha256: payload.outputSha256,
        runtimeVersion: payload.runtimeVersion,
        engineVersion: payload.toolVersion,
        warnings: payload.warnings,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) }
  }
}

export const crubyIseqPlugin: ToolPlugin = { manifest: crubyIseqManifest, analyze: executeCrubyIseq }
