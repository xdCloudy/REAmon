import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_OUTPUT_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 75_000

interface CrubyIseqStructuredEvidence {
  format: string
  runtimeVersion: string
  rootSequenceId: number | null
  sequenceCount: number
  instructionCount: number
  truncated: boolean
  sequences: Array<{
    id: number
    label: string
    type: string
    firstLine: number | null
    locals: string[]
    parameters: unknown
    catchTable: unknown[]
    instructions: Array<{ opcode?: string; event?: string; operands: unknown[] }>
    truncated: boolean
  }>
}

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
  structuredEvidenceSha256: string
  structuredEvidenceBytes: number
  structuredEvidenceJson: string
  disassembly: string
  warnings: string
  reconstructionStatus?: 'syntax_validated_candidate' | 'syntax_rejected' | 'unavailable'
  reconstructionRelativePath?: string
  reconstructionName?: string
  reconstructionSha256?: string
  reconstructionBytes?: number
  reconstructionUpstream?: string
  reconstructionUpstreamRevision?: string
  reconstructionScope?: string
  reconstructionIseqCount?: number
  reconstructionRootCount?: number
  reconstructionWarnings?: string
  reconstructionSyntaxMessage?: string
  reconstructionWarning?: string
}

export const crubyIseqManifest: ToolPluginManifest = {
  id: 'reamon-cruby-iseq',
  name: 'CRuby YARV ISeq Recovery',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['cruby-iseq'],
  capabilities: ['inspect_bytecode', 'decompile'],
  produces: ['CodeUnit', 'BytecodeDisassembly', 'DecompiledSource'],
  requirements: [
    { key: 'service', value: 'Isolated CRuby 3.4.11 ISeq inspector and experimental source recovery' },
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
    && typeof result.structuredEvidenceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.structuredEvidenceSha256)
    && isSafeInteger(result.structuredEvidenceBytes, 1) && result.structuredEvidenceBytes <= 192 * 1024
    && typeof result.structuredEvidenceJson === 'string'
    && Buffer.byteLength(result.structuredEvidenceJson, 'utf8') === result.structuredEvidenceBytes
    && createHash('sha256').update(result.structuredEvidenceJson).digest('hex') === result.structuredEvidenceSha256.toLowerCase()
    && typeof result.disassembly === 'string' && Buffer.byteLength(result.disassembly, 'utf8') === result.outputBytes
    && typeof result.warnings === 'string' && result.warnings.length <= 1_000
    && (result.reconstructionStatus === undefined || ['syntax_validated_candidate', 'syntax_rejected', 'unavailable'].includes(String(result.reconstructionStatus)))
    && (result.reconstructionStatus !== 'syntax_validated_candidate' || (
      typeof result.reconstructionRelativePath === 'string'
      && typeof result.reconstructionName === 'string'
      && result.reconstructionRelativePath === result.outputRelativePath.replace(/[^/]+$/, result.reconstructionName)
      && result.reconstructionName.endsWith('.reconstructed.rb')
      && typeof result.reconstructionName === 'string' && result.reconstructionName.length <= 200
      && typeof result.reconstructionSha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.reconstructionSha256)
      && isSafeInteger(result.reconstructionBytes, 1) && result.reconstructionBytes <= MAX_OUTPUT_BYTES
      && result.reconstructionUpstream === 'DECOMPILER-RUBY-FOR-SKETCHUP-RUBY-2.7'
      && result.reconstructionUpstreamRevision === '8296afafb099110f944135f32f59e789567dd1a4'
      && typeof result.reconstructionScope === 'string' && result.reconstructionScope.length <= 500
      && isSafeInteger(result.reconstructionIseqCount, 1) && result.reconstructionIseqCount <= 96
      && isSafeInteger(result.reconstructionRootCount, 1) && result.reconstructionRootCount <= 96
      && typeof result.reconstructionWarnings === 'string' && result.reconstructionWarnings.length <= 1_000
      && typeof result.reconstructionSyntaxMessage === 'string' && result.reconstructionSyntaxMessage.length <= 1_000
    ))
    && (result.reconstructionWarning === undefined || (typeof result.reconstructionWarning === 'string' && result.reconstructionWarning.length <= 1_000))
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
    const parsedEvidence: unknown = JSON.parse(payload.structuredEvidenceJson)
    if (!parsedEvidence || typeof parsedEvidence !== 'object' || Array.isArray(parsedEvidence)) {
      throw new Error('CRuby ISeq inspector returned malformed structured evidence')
    }
    const structuredEvidence = parsedEvidence as CrubyIseqStructuredEvidence
    if (structuredEvidence.format !== 'YARVInstructionSequence/SimpleDataFormat'
        || !isSafeInteger(structuredEvidence.instructionCount)
        || !isSafeInteger(structuredEvidence.sequenceCount)
        || !Array.isArray(structuredEvidence.sequences) || structuredEvidence.sequences.length > 96) {
      throw new Error('CRuby ISeq inspector returned unsupported structured evidence')
    }

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
        structuredBytecode: payload.structuredEvidenceJson,
        structuredBytecodeSha256: payload.structuredEvidenceSha256.toLowerCase(),
        runtimeVersion: payload.runtimeVersion,
        engineVersion: payload.toolVersion,
        binarySignature: payload.binarySignature,
        disassembly: payload.disassembly,
        evidenceWarning: payload.warnings,
      },
    }]

    if (payload.reconstructionStatus === 'syntax_validated_candidate') {
      const reconstructedIdentity = `${input.artifactId}:${payload.inputRelativePath}:ruby-sketchup-decompiler:${payload.reconstructionUpstreamRevision}`
      observations.push({
        kind: 'entity',
        type: 'code_unit',
        key: `cruby-iseq:reconstructed:${createHash('sha256').update(reconstructedIdentity).digest('hex').slice(0, 32)}`,
        label: payload.reconstructionName as string,
        attributes: {
          unitType: 'module',
          identity: reconstructedIdentity,
          name: payload.reconstructionName as string,
          qualifiedName: payload.reconstructionName as string,
          relativePath: payload.inputRelativePath,
          language: 'Ruby',
          sourceLanguage: 'Ruby',
          decompiler: payload.reconstructionUpstream as string,
          decompilerVersion: payload.reconstructionUpstreamRevision as string,
          providerRevision: `${payload.reconstructionUpstream}@${payload.reconstructionUpstreamRevision}`,
          representation: 'experimental reconstructed Ruby source',
          representationSemantics: 'Pattern-based source candidate adapted from a Ruby 2.7-focused decompiler and parsed by CRuby 3.4.11. Syntax acceptance does not establish semantic equivalence; unresolved or optimized behavior may be missing or approximated.',
          isExecutableSource: true,
          decompiled: true,
          codeArtifactId: payload.reconstructionRelativePath as string,
          decompiledSourceSha256: (payload.reconstructionSha256 as string).toLowerCase(),
          codeArtifactSha256: (payload.reconstructionSha256 as string).toLowerCase(),
          sizeBytes: payload.reconstructionBytes as number,
          inputBytes: payload.inputBytes,
          inputSha256: payload.inputSha256,
          outputSha256: (payload.reconstructionSha256 as string).toLowerCase(),
          runtimeVersion: payload.runtimeVersion,
          engineVersion: `${payload.reconstructionUpstream}@${payload.reconstructionUpstreamRevision}`,
          binarySignature: payload.binarySignature,
          syntaxValidationStatus: 'passed',
          syntaxValidationMethod: `CRuby ${payload.runtimeVersion} ruby -c (syntax only)`,
          syntaxValidationMessage: payload.reconstructionSyntaxMessage as string,
          reconstructionScope: payload.reconstructionScope as string,
          reconstructionIseqCount: payload.reconstructionIseqCount as number,
          reconstructionRootCount: payload.reconstructionRootCount as number,
          evidenceWarning: payload.reconstructionWarnings as string,
        },
      })
    }

    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        inspectedModuleCount: 1,
        instructionCount: payload.instructionCount,
        structuredInstructionCount: structuredEvidence.instructionCount,
        inputSha256: payload.inputSha256,
        outputSha256: payload.outputSha256,
        runtimeVersion: payload.runtimeVersion,
        engineVersion: payload.toolVersion,
        warnings: payload.warnings,
        reconstructionStatus: payload.reconstructionStatus ?? 'unavailable',
        ...(payload.reconstructionWarning ? { reconstructionWarning: payload.reconstructionWarning } : {}),
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) }
  }
}

export const crubyIseqPlugin: ToolPlugin = { manifest: crubyIseqManifest, analyze: executeCrubyIseq }
