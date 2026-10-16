import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_UNITS = 2000
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const MAX_CALL_EDGES = 400

interface GhidraResponse {
  status: 'completed'
  toolVersion: string
  instructionArchitecture?: string
  recoveredLanguage?: string | null
  goVersion?: string | null
  goArchitecture?: string | null
  goTypes?: string[]
  functionCount: number
  visitedFunctionCount?: number
  failedFunctionCount?: number
  codeBytes?: number
  returnedUnits: number
  truncated: boolean
  units: Array<{ name: string; address: string; relativePath: string; codeArtifactId: string; disassemblyArtifactId?: string; referencedStrings?: string[]; instructionMnemonics?: string[]; sourceAddressMap?: Array<{ ghidraLineNumber: number; address: string }>; prototype?: string; recoveredVariables?: Array<{ kind: 'parameter' | 'local'; name: string; dataType: string; sizeBytes: number; parameterIndex?: number; storageStartAddress?: string; nameLocked?: boolean; typeLocked?: boolean }>; recoveredVariablesTruncated?: boolean; sourceLanguage?: string; symbolSource?: string; goPackage?: string; sizeBytes: number }>
  calls?: Array<{ fromAddress: string; toAddress: string; fromName: string; toName: string }>
  callCount?: number
  callGraphTruncated?: boolean
  sourceAddressMapTruncated?: boolean
  recoveredVariablesTruncated?: boolean
  warnings?: string
}

export const ghidraManifest: ToolPluginManifest = {
  id: 'reamon-ghidra',
  name: 'Ghidra Native Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile'],
  produces: ['CodeUnit', 'DecompiledSource', 'FunctionAddress', 'CallGraph', 'Relationship'],
  requirements: [
    { key: 'service', value: 'Ghidra isolated headless analyzer container' },
    { key: 'artifactPath' },
  ],
}

function codeUnitKey(artifactId: string, taskId: string, address: string): string {
  return `ghidra:function:${createHash('sha256').update(`${artifactId}:${taskId}:${address}`).digest('hex').slice(0, 32)}`
}

function graphFunctionKey(artifactId: string, address: string): string {
  return `ghidra:function-target:${createHash('sha256').update(`${artifactId}:${address}`).digest('hex').slice(0, 32)}`
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'Ghidra analysis failed'
}

function boundedEnvNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : fallback
}

function isGhidraResponse(value: unknown): value is GhidraResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.status === 'completed' && Array.isArray(record.units)
    && (record.sourceAddressMapTruncated === undefined || typeof record.sourceAddressMapTruncated === 'boolean')
    && (record.recoveredVariablesTruncated === undefined || typeof record.recoveredVariablesTruncated === 'boolean')
}

export async function executeGhidra(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: ghidraManifest.id,
    capabilities: ghidraManifest.capabilities,
    produced: ghidraManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'Ghidra requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_GHIDRA_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated Ghidra analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedEnvNumber('REAMON_GHIDRA_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000, 30 * 60_000))
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
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
        : `Ghidra analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isGhidraResponse(payload)) throw new Error('Ghidra analyzer returned an invalid result')

    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => {
      if (!unit || typeof unit.name !== 'string' || typeof unit.address !== 'string'
          || typeof unit.relativePath !== 'string' || typeof unit.codeArtifactId !== 'string'
          || !Number.isFinite(unit.sizeBytes) || unit.sizeBytes <= 0
          || (unit.disassemblyArtifactId !== undefined && typeof unit.disassemblyArtifactId !== 'string')
          || (unit.referencedStrings !== undefined && (!Array.isArray(unit.referencedStrings)
            || !unit.referencedStrings.every((value) => typeof value === 'string' && value.length <= 512)))
          || (unit.instructionMnemonics !== undefined && (!Array.isArray(unit.instructionMnemonics)
            || unit.instructionMnemonics.length > 800
            || !unit.instructionMnemonics.every((value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,31}$/.test(value))))
          || (unit.sourceAddressMap !== undefined && (!Array.isArray(unit.sourceAddressMap)
            || unit.sourceAddressMap.length > 5000
            || !unit.sourceAddressMap.every((mapping) => mapping && Number.isInteger(mapping.ghidraLineNumber)
              && mapping.ghidraLineNumber > 0 && mapping.ghidraLineNumber <= 1_000_000
              && typeof mapping.address === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(mapping.address))))
          || (unit.prototype !== undefined && (typeof unit.prototype !== 'string' || unit.prototype.length > 2000))
          || (unit.recoveredVariables !== undefined && (!Array.isArray(unit.recoveredVariables)
            || unit.recoveredVariables.length > 100
            || !unit.recoveredVariables.every((variable) => variable && (variable.kind === 'parameter' || variable.kind === 'local')
              && typeof variable.name === 'string' && variable.name.length > 0 && variable.name.length <= 256
              && typeof variable.dataType === 'string' && variable.dataType.length <= 256
              && Number.isInteger(variable.sizeBytes) && variable.sizeBytes >= 0 && variable.sizeBytes <= 65536
              && (variable.parameterIndex === undefined || (variable.kind === 'parameter' && Number.isInteger(variable.parameterIndex) && variable.parameterIndex >= 0 && variable.parameterIndex < 100))
              && (variable.storageStartAddress === undefined || (typeof variable.storageStartAddress === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(variable.storageStartAddress)))
              && (variable.nameLocked === undefined || typeof variable.nameLocked === 'boolean')
              && (variable.typeLocked === undefined || typeof variable.typeLocked === 'boolean'))))
          || (unit.recoveredVariablesTruncated !== undefined && typeof unit.recoveredVariablesTruncated !== 'boolean')
          || (unit.sourceLanguage !== undefined && typeof unit.sourceLanguage !== 'string')
          || (unit.symbolSource !== undefined && typeof unit.symbolSource !== 'string')
          || (unit.goPackage !== undefined && typeof unit.goPackage !== 'string')) return false
      return true
    })
    if (!units.length) throw new Error('Ghidra did not produce any viewable function decompilations')

    const observations = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: codeUnitKey(input.artifactId!, input.taskId!, unit.address),
      label: unit.name,
      attributes: {
        unitType: 'function',
        identity: `${input.artifactId}:${unit.address}`,
        name: unit.name.slice(0, 500),
        qualifiedName: unit.name.slice(0, 500),
        address: unit.address.slice(0, 128),
        relativePath: unit.relativePath.slice(0, 1000),
        sizeBytes: Math.floor(unit.sizeBytes),
        language: 'C',
        ...(unit.sourceLanguage ? { sourceLanguage: unit.sourceLanguage.slice(0, 80) } : {}),
        ...(unit.symbolSource ? { symbolSource: unit.symbolSource.slice(0, 64) } : {}),
        ...(unit.goPackage ? { goPackage: unit.goPackage.slice(0, 500) } : {}),
        ...(typeof input.targetProfile.architecture === 'string' && input.targetProfile.architecture
          ? { architecture: input.targetProfile.architecture.slice(0, 128) } : {}),
        ...(typeof payload.instructionArchitecture === 'string' && payload.instructionArchitecture
          ? { instructionArchitecture: payload.instructionArchitecture.slice(0, 128) } : {}),
        decompiled: true,
        codeArtifactId: unit.codeArtifactId.slice(0, 2000),
        ...(unit.disassemblyArtifactId ? { disassemblyArtifactId: unit.disassemblyArtifactId.slice(0, 2000) } : {}),
        ...(unit.referencedStrings?.length ? { referencedStrings: JSON.stringify(unit.referencedStrings.slice(0, 12).map((value) => value.slice(0, 512))) } : {}),
        ...(unit.instructionMnemonics?.length ? { instructionMnemonics: JSON.stringify(unit.instructionMnemonics.slice(0, 800)) } : {}),
        ...(unit.sourceAddressMap?.length ? { sourceAddressMap: JSON.stringify(unit.sourceAddressMap.slice(0, 5000)) } : {}),
        ...(unit.prototype ? { prototype: unit.prototype.slice(0, 2000) } : {}),
        ...(unit.recoveredVariables?.length ? { recoveredVariables: JSON.stringify(unit.recoveredVariables.slice(0, 100)) } : {}),
        ...(unit.recoveredVariablesTruncated ? { recoveredVariablesTruncated: true } : {}),
        ...(payload.sourceAddressMapTruncated ? { sourceAddressMapTruncated: true } : {}),
      },
    })) as ToolObservation[]
    const goTypes = Array.isArray(payload.goTypes)
      ? payload.goTypes.slice(0, 1000).filter((value) => typeof value === 'string').map((value) => value.slice(0, 500))
      : []
    if (payload.recoveredLanguage === 'Go') {
      const storedGoTypes: string[] = []
      for (const name of goTypes) {
        if (JSON.stringify([...storedGoTypes, name]).length > 3500) break
        storedGoTypes.push(name)
      }
      const goMetadata = {
        kind: 'entity',
        type: 'language_metadata',
        key: `ghidra:go-metadata:${createHash('sha256').update(input.artifactId!).digest('hex').slice(0, 32)}`,
        label: `Go ${payload.goVersion || 'binary metadata'}`,
        attributes: {
          identity: `${input.artifactId}:go-metadata`,
          language: 'Go',
          symbolSource: 'GoReSym',
          ...(typeof payload.goVersion === 'string' ? { goVersion: payload.goVersion.slice(0, 128) } : {}),
          ...(typeof payload.goArchitecture === 'string' ? { goArchitecture: payload.goArchitecture.slice(0, 128) } : {}),
          recoveredFunctionCount: units.filter((unit) => unit.symbolSource === 'GoReSym').length,
          types: JSON.stringify(storedGoTypes),
        },
      } satisfies ToolObservation
      observations.push(goMetadata)
    }
    const unitAddresses = new Set(units.map((unit) => unit.address))
    const functionNodes = new Set<string>()
    const seenEdges = new Set<string>()
    const calls = (Array.isArray(payload.calls) ? payload.calls : []).slice(0, MAX_CALL_EDGES)
    for (const call of calls) {
      if (!call || typeof call.fromAddress !== 'string' || typeof call.toAddress !== 'string'
          || typeof call.fromName !== 'string' || typeof call.toName !== 'string'
          || call.fromAddress.length > 128 || call.toAddress.length > 128
          || call.fromName.length > 500 || call.toName.length > 500
          || !unitAddresses.has(call.fromAddress)) continue
      const edgeIdentity = call.fromAddress + '->' + call.toAddress
      if (seenEdges.has(edgeIdentity)) continue
      seenEdges.add(edgeIdentity)
      const fromKey = codeUnitKey(input.artifactId, input.taskId, call.fromAddress)
      let toKey: string
      if (unitAddresses.has(call.toAddress)) {
        toKey = codeUnitKey(input.artifactId, input.taskId, call.toAddress)
      } else {
        toKey = graphFunctionKey(input.artifactId, call.toAddress)
        if (!functionNodes.has(toKey)) {
          functionNodes.add(toKey)
          observations.push({
            kind: 'entity',
            type: 'function',
            key: toKey,
            label: call.toName.slice(0, 500),
            attributes: {
              identity: `${input.artifactId}:${call.toAddress}`,
              qualifiedName: call.toName.slice(0, 500),
              name: call.toName.slice(0, 500),
              address: call.toAddress,
              language: 'C',
              ...(payload.recoveredLanguage === 'Go' ? { sourceLanguage: 'Go' } : {}),
              externalOrUndecompiled: true,
            },
          })
        }
      }
      const edgeDigest = createHash('sha256')
        .update(`${input.artifactId}:${call.fromAddress}:${call.toAddress}`)
        .digest('hex').slice(0, 32)
      observations.push({
        kind: 'relationship',
        type: 'calls',
        relation: 'calls',
        key: `ghidra:call:${edgeDigest}`,
        fromKey,
        toKey,
        label: `${call.fromName} calls ${call.toName}`.slice(0, 500),
        attributes: { fromAddress: call.fromAddress, toAddress: call.toAddress },
      })
    }
    const callGraphTruncated = payload.callGraphTruncated === true || (payload.calls?.length || 0) > MAX_CALL_EDGES
    return {
      status: 'completed',
      ...base,
      data: {
        decompiledFunctionCount: payload.functionCount,
        returnedFunctionCount: units.length,
        callCount: seenEdges.size,
        callGraphTruncated,
        visitedFunctionCount: typeof payload.visitedFunctionCount === 'number' && Number.isFinite(payload.visitedFunctionCount) ? payload.visitedFunctionCount : null,
        failedFunctionCount: typeof payload.failedFunctionCount === 'number' && Number.isFinite(payload.failedFunctionCount) ? payload.failedFunctionCount : null,
        codeBytes: typeof payload.codeBytes === 'number' && Number.isFinite(payload.codeBytes) ? Math.max(0, Math.floor(payload.codeBytes)) : units.reduce((sum, unit) => sum + Math.floor(unit.sizeBytes), 0),
        truncated: payload.truncated || payload.functionCount > units.length || callGraphTruncated,
        ghidraVersion: payload.toolVersion,
        recoveredLanguage: payload.recoveredLanguage === 'Go' ? 'Go' : null,
        goVersion: typeof payload.goVersion === 'string' ? payload.goVersion.slice(0, 128) : null,
        goArchitecture: typeof payload.goArchitecture === 'string' ? payload.goArchitecture.slice(0, 128) : null,
        goTypes,
        goRecoveredFunctionCount: units.filter((unit) => unit.symbolSource === 'GoReSym').length,
        warnings: payload.warnings?.slice(0, 4000) || '',
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const ghidraPlugin: ToolPlugin = { manifest: ghidraManifest, analyze: executeGhidra }
