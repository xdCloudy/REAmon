import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_UNITS = 20_000
const DEFAULT_TIMEOUT_MS = 20 * 60_000

interface ArlecchinoUnit {
  name: string
  relativePath: string
  codeArtifactId: string
  language: 'Java'
  sizeBytes: number
  outputSha256: string
}

interface EngineRank {
  engine: string
  classes: number
  errors: number
}

interface ArlecchinoResponse {
  status: 'completed'
  toolVersion: '1.0.0'
  providerRevision: string
  inputName: string
  artifactSha256: string
  sourceFileCount: number
  codeBytes: number
  truncated: boolean
  engineRanking: EngineRank[]
  bestBaseEngine: string | null
  mergedCompilerErrorCount: number | null
  memberRenamesApplied: boolean
  renameMapping: { codeArtifactId: string; sha256: string; sizeBytes: number } | null
  roundTrip: { present: number; totalOriginal: number; coveragePercent: number; missingClassCount: number; structuralMismatchCount: number } | null
  analysisArtifactId: string
  warnings?: string
  units: ArlecchinoUnit[]
}

export const arlecchinoManifest: ToolPluginManifest = {
  id: 'reamon-arlecchino',
  name: 'Arlecchino JVM Best-of Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['jar'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'ValidationEvidence'],
  requirements: [
    { key: 'service', value: 'Arlecchino isolated analyzer container' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Arlecchino analysis failed'
}

function isArlecchinoResponse(value: unknown): value is ArlecchinoResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && record.toolVersion === '1.0.0'
    && typeof record.providerRevision === 'string' && /^[a-f0-9]{40}$/i.test(record.providerRevision)
    && typeof record.inputName === 'string' && record.inputName.length <= 1000
    && typeof record.artifactSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.artifactSha256)
    && Number.isSafeInteger(record.sourceFileCount) && Number(record.sourceFileCount) >= 0
    && Number.isSafeInteger(record.codeBytes) && Number(record.codeBytes) >= 0
    && typeof record.truncated === 'boolean' && Array.isArray(record.engineRanking)
    && (record.bestBaseEngine === null || typeof record.bestBaseEngine === 'string')
    && (record.mergedCompilerErrorCount === null || (Number.isSafeInteger(record.mergedCompilerErrorCount) && Number(record.mergedCompilerErrorCount) >= 0))
    && typeof record.memberRenamesApplied === 'boolean'
    && (record.renameMapping === null || (typeof record.renameMapping === 'object' && !Array.isArray(record.renameMapping)))
    && (record.roundTrip === null || (typeof record.roundTrip === 'object' && !Array.isArray(record.roundTrip)))
    && typeof record.analysisArtifactId === 'string' && record.analysisArtifactId.length <= 2000
    && (record.warnings === undefined || typeof record.warnings === 'string')
    && Array.isArray(record.units)
}

function validUnit(value: unknown, expectedPrefix: string): value is ArlecchinoUnit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const unit = value as Record<string, unknown>
  return typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
    && typeof unit.relativePath === 'string' && /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]{1,1000}\.java$/i.test(unit.relativePath)
    && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId === `${expectedPrefix}merged/${unit.relativePath}`
    && unit.codeArtifactId.length <= 2000
    && unit.language === 'Java'
    && typeof unit.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(unit.outputSha256)
    && Number.isSafeInteger(unit.sizeBytes) && Number(unit.sizeBytes) > 0 && Number(unit.sizeBytes) <= 16 * 1024 * 1024
}

export async function executeArlecchino(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: arlecchinoManifest.id,
    capabilities: arlecchinoManifest.capabilities,
    produced: arlecchinoManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Arlecchino requires a stored JVM .jar artifact and task context' }
  }
  const baseUrl = process.env.REAMON_ARLECCHINO_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Arlecchino analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_ARLECCHINO_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `Arlecchino analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isArlecchinoResponse(payload)) throw new Error('Arlecchino analyzer returned an invalid result')

    const prefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
    if (payload.analysisArtifactId !== `${prefix}analysis.json`
        || payload.sourceFileCount > 50_000 || payload.codeBytes > 1024 * 1024 * 1024) {
      throw new Error('Arlecchino analyzer returned invalid result bounds or artifact identity')
    }
    const renameMapping = payload.renameMapping
    if (renameMapping !== null && (renameMapping.codeArtifactId !== `${prefix}mappings/member-renames.txt`
        || !/^[a-f0-9]{64}$/i.test(renameMapping.sha256)
        || !Number.isSafeInteger(renameMapping.sizeBytes) || renameMapping.sizeBytes < 0 || renameMapping.sizeBytes > 8 * 1024 * 1024)) {
      throw new Error('Arlecchino analyzer returned invalid canonical-name mapping provenance')
    }
    if (payload.memberRenamesApplied !== (renameMapping !== null)) {
      throw new Error('Arlecchino rename status did not match its canonical-name mapping')
    }
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, prefix))
    if (!units.length) throw new Error('Arlecchino did not produce viewable Java source')
    const ranking = payload.engineRanking.slice(0, 16).flatMap((value) => {
      if (!value || typeof value.engine !== 'string' || value.engine.length > 80
          || !Number.isSafeInteger(value.classes) || !Number.isSafeInteger(value.errors)
          || value.classes < 0 || value.errors < 0) return []
      return [{ engine: value.engine, classes: value.classes, errors: value.errors }]
    })
    const roundTrip = payload.roundTrip
      && Number.isSafeInteger(payload.roundTrip.present) && Number.isSafeInteger(payload.roundTrip.totalOriginal)
      && payload.roundTrip.present >= 0 && payload.roundTrip.totalOriginal >= payload.roundTrip.present
      && Number.isFinite(payload.roundTrip.coveragePercent) && payload.roundTrip.coveragePercent >= 0 && payload.roundTrip.coveragePercent <= 100
      ? payload.roundTrip
      : null
    const observations: ToolObservation[] = units.map((unit) => {
      const identity = `${input.artifactId}:${unit.relativePath}`
      return {
        kind: 'entity',
        type: 'code_unit',
        key: `arlecchino:class:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
        label: unit.name,
        attributes: {
          unitType: 'class',
          identity,
          name: unit.name,
          qualifiedName: unit.name,
          sizeBytes: unit.sizeBytes,
          language: unit.language,
          relativePath: unit.relativePath,
          decompiled: true,
          codeArtifactId: unit.codeArtifactId,
          decompilationEngine: 'Arlecchino (Vineflower/CFR/JADX best-of)',
          decompilationEngineVersion: payload.toolVersion,
          decompilationProviderRevision: payload.providerRevision,
          decompilationBasis: 'isolated per-class compiler-error ranking',
          canonicalMemberRenamesApplied: payload.memberRenamesApplied,
          generatedMemberNamesAreOriginal: false,
          mergedCompilerErrorCount: payload.mergedCompilerErrorCount,
          roundTripCoveragePercent: roundTrip?.coveragePercent ?? null,
          alternateDecompiler: true,
          inputArtifactSha256: payload.artifactSha256,
          decompiledSourceSha256: unit.outputSha256,
        },
      }
    })
    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        inputName: payload.inputName,
        decompiledCodeUnitCount: payload.sourceFileCount,
        returnedCodeUnitCount: units.length,
        codeBytes: payload.codeBytes,
        truncated: payload.truncated || payload.sourceFileCount > units.length,
        engineRanking: ranking,
        bestBaseEngine: payload.bestBaseEngine,
        mergedCompilerErrorCount: payload.mergedCompilerErrorCount,
        memberRenamesApplied: payload.memberRenamesApplied,
        renameMapping,
        roundTrip,
        analysisArtifactId: payload.analysisArtifactId,
        semanticsWarning: payload.warnings?.slice(0, 2000) || '',
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const arlecchinoPlugin: ToolPlugin = { manifest: arlecchinoManifest, analyze: executeArlecchino }
