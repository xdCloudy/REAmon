import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_UNITS = 20_000
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const JAVA_DEOBFUSCATOR_REVISION = 'bdde461b5aaf762f3b35d410ac76d850da5dd7a1'

interface VineflowerUnit {
  name: string
  relativePath: string
  sourceRoot: 'sources' | 'sources-allatori-flow'
  sourceVariant: 'baseline' | 'allatori-flow'
  codeArtifactId: string
  language: 'Java' | 'Kotlin'
  sizeBytes: number
  outputSha256: string
  preprocessor?: string
  preprocessorRevision?: string
  preprocessorArtifactId?: string
  preprocessorSha256?: string
  preprocessorFixedInstructionCount?: number
  preprocessorSemantics?: string
}

interface StaticFlowCleanup {
  status: 'applied' | 'not_applied'
  transformer: 'allatori.FlowObfuscationTransformer'
  upstream: 'opastorello/deobfuscator'
  upstreamRevision: string
  upstreamSha256: string
  artifactId: string | null
  outputSha256: string | null
  outputBytes: number | null
  fixedInstructionCount: number
  warning: string
  targetCodeExecuted: false
}

interface VineflowerResponse {
  status: 'completed'
  toolVersion: string
  inputName: string
  artifactSha256: string
  sourceFileCount: number
  codeBytes: number
  truncated: boolean
  units: VineflowerUnit[]
  warnings?: string
  staticFlowCleanup: StaticFlowCleanup
}

export const vineflowerManifest: ToolPluginManifest = {
  id: 'reamon-vineflower',
  name: 'Vineflower Java and Kotlin Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['jar', 'class'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'TransformationEvidence'],
  requirements: [
    { key: 'service', value: 'Vineflower isolated analyzer container' },
    { key: 'artifactPath' },
  ],
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Vineflower analysis failed'
}

function isVineflowerResponse(value: unknown): value is VineflowerResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && record.toolVersion === '1.12.0'
    && typeof record.inputName === 'string' && record.inputName.length <= 1000
    && typeof record.artifactSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.artifactSha256)
    && Number.isSafeInteger(record.sourceFileCount) && Number.isSafeInteger(record.codeBytes)
    && typeof record.truncated === 'boolean' && Array.isArray(record.units)
    && (record.warnings === undefined || typeof record.warnings === 'string')
    && isStaticFlowCleanup(record.staticFlowCleanup)
}

function isStaticFlowCleanup(value: unknown): value is StaticFlowCleanup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if ((record.status !== 'applied' && record.status !== 'not_applied')
      || record.transformer !== 'allatori.FlowObfuscationTransformer'
      || record.upstream !== 'opastorello/deobfuscator'
      || record.upstreamRevision !== JAVA_DEOBFUSCATOR_REVISION
      || record.upstreamSha256 !== '23ba5d13ee632bc941c68f4dff24d7313881ae8754a10270a3d0c1dfde2be283'
      || !Number.isSafeInteger(record.fixedInstructionCount) || Number(record.fixedInstructionCount) < 0
      || typeof record.warning !== 'string' || record.warning.length > 2_000
      || record.targetCodeExecuted !== false) return false
  if (record.status === 'not_applied') return record.artifactId === null && record.outputSha256 === null && record.outputBytes === null
  return Number(record.fixedInstructionCount) > 0
    && typeof record.artifactId === 'string' && record.artifactId.length <= 2_000
    && typeof record.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(record.outputSha256)
    && Number.isSafeInteger(record.outputBytes) && Number(record.outputBytes) > 0 && Number(record.outputBytes) <= 256 * 1024 * 1024
}

function validUnit(value: unknown, expectedRunPrefix: string): value is VineflowerUnit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const unit = value as Record<string, unknown>
  const isBaseline = unit.sourceVariant === 'baseline' && unit.sourceRoot === 'sources'
  const isFlowAlternate = unit.sourceVariant === 'allatori-flow' && unit.sourceRoot === 'sources-allatori-flow'
  return typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
    && typeof unit.relativePath === 'string' && /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]{1,1000}\.(?:java|kt)$/i.test(unit.relativePath)
    && (isBaseline || isFlowAlternate)
    && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId === `${expectedRunPrefix}${unit.sourceRoot}/${unit.relativePath}`
    && unit.codeArtifactId.length <= 2000
    && (unit.language === 'Java' || unit.language === 'Kotlin')
    && (unit.relativePath.toLowerCase().endsWith('.kt') === (unit.language === 'Kotlin'))
    && typeof unit.outputSha256 === 'string' && /^[a-f0-9]{64}$/i.test(unit.outputSha256)
    && Number.isSafeInteger(unit.sizeBytes) && Number(unit.sizeBytes) > 0 && Number(unit.sizeBytes) <= 16 * 1024 * 1024
    && (!isFlowAlternate || (
      unit.preprocessor === 'Java Deobfuscator Allatori FlowObfuscationTransformer'
      && unit.preprocessorRevision === JAVA_DEOBFUSCATOR_REVISION
      && unit.preprocessorArtifactId === `${expectedRunPrefix}transforms/java-deobfuscator/allatori-flow.jar`
      && typeof unit.preprocessorSha256 === 'string' && /^[a-f0-9]{64}$/i.test(unit.preprocessorSha256)
      && Number.isSafeInteger(unit.preprocessorFixedInstructionCount) && Number(unit.preprocessorFixedInstructionCount) > 0
      && unit.preprocessorSemantics === 'Static bytecode-pattern cleanup; target application code was not executed.'
    ))
}

export async function executeVineflower(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: vineflowerManifest.id,
    capabilities: vineflowerManifest.capabilities,
    produced: vineflowerManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Vineflower requires a stored JVM .class or .jar artifact and task context' }
  }
  const baseUrl = process.env.REAMON_VINEFLOWER_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Vineflower analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_VINEFLOWER_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
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
        : `Vineflower analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isVineflowerResponse(payload)) throw new Error('Vineflower analyzer returned an invalid result')

    const runPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
    if (payload.staticFlowCleanup.status === 'applied'
        && payload.staticFlowCleanup.artifactId !== `${runPrefix}transforms/java-deobfuscator/allatori-flow.jar`) {
      throw new Error('Vineflower analyzer returned an invalid transformed JAR path')
    }
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, runPrefix))
    if (!units.length) throw new Error('Vineflower did not produce viewable Java or Kotlin source')
    const observations: ToolObservation[] = units.map((unit) => {
      const identity = `${input.artifactId}:${unit.relativePath}`
      const alternate = unit.sourceVariant === 'allatori-flow'
      return {
        kind: 'entity',
        type: 'code_unit',
        key: `vineflower:${alternate ? 'allatori-flow' : 'class'}:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
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
          decompiler: alternate ? 'Vineflower + Java Deobfuscator' : 'Vineflower',
          decompilerVersion: alternate ? `${payload.toolVersion}; ${JAVA_DEOBFUSCATOR_REVISION}` : payload.toolVersion,
          experimentalLanguagePlugin: unit.language === 'Kotlin',
          inputArtifactSha256: payload.artifactSha256,
          decompiledSourceSha256: unit.outputSha256,
          representation: alternate ? 'Java/Kotlin source after experimental static Allatori flow cleanup' : 'Vineflower Java/Kotlin reconstruction',
          representationSemantics: alternate
            ? 'Secondary source candidate after an Allatori-specific static bytecode-pattern cleanup. Target application code was not executed. Original JAR and baseline Vineflower source are retained; this output is not behavior-validated.'
            : 'Vineflower reconstruction from the imported JAR. Output structure is provisional and does not establish original source or behavior.',
          ...(alternate ? {
            deobfuscatedArtifactId: unit.preprocessorArtifactId as string,
            deobfuscatedArtifactSha256: (unit.preprocessorSha256 as string).toLowerCase(),
            deobfuscationProvider: 'Java Deobfuscator',
            deobfuscationProviderRevision: unit.preprocessorRevision as string,
            deobfuscationEnabledPasses: unit.preprocessor as string,
            deobfuscationDisabledPasses: 'Target-executing string decryption transformers',
            deobfuscationFixedInstructionCount: unit.preprocessorFixedInstructionCount as number,
          } : {}),
        },
      }
    })
    const observationsWithTransform: ToolObservation[] = [...observations]
    if (payload.staticFlowCleanup.status === 'applied') {
      const transformation = payload.staticFlowCleanup
      observationsWithTransform.push({
        kind: 'entity',
        type: 'artifact',
        key: `java-deobfuscator:artifact:${createHash('sha256').update(`${input.artifactId}:${transformation.outputSha256}`).digest('hex').slice(0, 32)}`,
        label: 'allatori-flow.jar',
        attributes: {
          artifactKind: 'derived Java bytecode transformation',
          format: 'jar',
          codeArtifactId: transformation.artifactId as string,
          sizeBytes: transformation.outputBytes as number,
          inputArtifactSha256: payload.artifactSha256,
          outputSha256: (transformation.outputSha256 as string).toLowerCase(),
          provider: transformation.upstream,
          providerRevision: transformation.upstreamRevision,
          transformer: transformation.transformer,
          fixedInstructionCount: transformation.fixedInstructionCount,
          targetCodeExecuted: false,
          evidenceWarning: 'Separate experimental transformed bytecode. The imported JAR and baseline decompilation remain available; this output is not behavior-validated.',
        },
      })
    }
    return {
      status: 'completed',
      ...base,
      data: {
        observations: observationsWithTransform,
        inputName: payload.inputName,
        decompiledCodeUnitCount: payload.sourceFileCount,
        returnedCodeUnitCount: units.length,
        codeBytes: payload.codeBytes,
        truncated: payload.truncated || payload.sourceFileCount > units.length,
        vineflowerVersion: payload.toolVersion,
        warnings: payload.warnings?.slice(0, 4000) || '',
        staticFlowCleanup: payload.staticFlowCleanup,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const vineflowerPlugin: ToolPlugin = { manifest: vineflowerManifest, analyze: executeVineflower }
