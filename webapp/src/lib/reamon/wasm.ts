import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
import { readAnalyzerResponse } from './analyzer-response'

const MAX_UNITS = 2_000
const DEFAULT_TIMEOUT_MS = 240_000
const MAX_TIMEOUT_MS = 10 * 60_000

interface WasmUnit {
  name: string
  address: string
  relativePath: string
  codeArtifactId: string
  sizeBytes: number
  instructionMnemonics?: string[]
  nameEvidence?: string
  disassemblyArtifactId?: string
  disassemblyRelativePath?: string
  disassemblyLanguage?: string
  sourceAddressMap?: Array<{ ghidraLineNumber: number; address: string }>
  sourceAddressMapTruncated?: boolean
}

interface WasmCall {
  fromAddress: string
  toAddress: string
  fromName: string
  toName: string
}

interface WasmResponse {
  status: 'completed'
  toolVersion: string
  functionCount: number
  returnedUnits: number
  codeBytes?: number
  truncated: boolean
  units: WasmUnit[]
  rustUnits?: Array<WasmUnit & { nameEvidence?: string }>
  rustVersion?: string
  calls?: WasmCall[]
  callCount?: number
  callGraphTruncated?: boolean
  warnings?: string
}

export const wasmManifest: ToolPluginManifest = {
  id: 'reamon-wabt',
  name: 'WebAssembly Analysis (WABT + unwasm)',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['wasm'],
  capabilities: ['disassemble', 'decompile'],
  produces: ['CodeUnit', 'WATFunction', 'RustFunction'],
  requirements: [
    { key: 'service', value: 'Isolated WABT and unwasm analyzer' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4_000) || 'WebAssembly analysis failed'
}

function boundedTimeoutMs(): number {
  const value = Number(process.env.REAMON_WASM_REQUEST_TIMEOUT_MS)
  return Number.isFinite(value) ? Math.min(MAX_TIMEOUT_MS, Math.max(10_000, Math.floor(value))) : DEFAULT_TIMEOUT_MS
}

function isWasmUnit(value: unknown): value is WasmUnit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const unit = value as Record<string, unknown>
  return typeof unit.name === 'string' && unit.name.length > 0 && unit.name.length <= 500
    && typeof unit.address === 'string' && unit.address.length > 0 && unit.address.length <= 128
    && typeof unit.relativePath === 'string' && unit.relativePath.length > 0 && unit.relativePath.length <= 1_000
    && typeof unit.codeArtifactId === 'string' && unit.codeArtifactId.length > 0 && unit.codeArtifactId.length <= 2_000
    && typeof unit.sizeBytes === 'number' && Number.isSafeInteger(unit.sizeBytes) && unit.sizeBytes > 0
    && (unit.disassemblyArtifactId === undefined || (typeof unit.disassemblyArtifactId === 'string' && unit.disassemblyArtifactId.length <= 2_000))
    && (unit.disassemblyRelativePath === undefined || (typeof unit.disassemblyRelativePath === 'string' && unit.disassemblyRelativePath.length <= 1_000))
    && (unit.disassemblyLanguage === undefined || (typeof unit.disassemblyLanguage === 'string' && unit.disassemblyLanguage.length <= 80))
    && (unit.sourceAddressMap === undefined || (Array.isArray(unit.sourceAddressMap) && unit.sourceAddressMap.length <= 100
      && unit.sourceAddressMap.every((mapping) => mapping && Number.isInteger(mapping.ghidraLineNumber)
        && mapping.ghidraLineNumber > 0 && typeof mapping.address === 'string' && /^0x[0-9a-f]{1,16}$/i.test(mapping.address))))
    && (unit.sourceAddressMapTruncated === undefined || typeof unit.sourceAddressMapTruncated === 'boolean')
    && (unit.instructionMnemonics === undefined || (Array.isArray(unit.instructionMnemonics) && unit.instructionMnemonics.length <= 800
      && unit.instructionMnemonics.every((mnemonic) => typeof mnemonic === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,31}$/.test(mnemonic))))
}

function isWasmResponse(value: unknown): value is WasmResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  return response.status === 'completed'
    && typeof response.toolVersion === 'string'
    && Number.isSafeInteger(response.functionCount) && (response.functionCount as number) >= 0
    && Number.isSafeInteger(response.returnedUnits) && (response.returnedUnits as number) >= 0
    && (response.codeBytes === undefined || (Number.isSafeInteger(response.codeBytes) && (response.codeBytes as number) >= 0))
    && typeof response.truncated === 'boolean'
    && Array.isArray(response.units)
    && (response.rustUnits === undefined || Array.isArray(response.rustUnits))
    && (response.rustVersion === undefined || typeof response.rustVersion === 'string')
    && (response.calls === undefined || Array.isArray(response.calls))
    && (response.warnings === undefined || typeof response.warnings === 'string')
}

export async function executeWasm(input: ToolExecutionInput): Promise<ToolResult> {
  const base = {
    toolId: wasmManifest.id,
    capabilities: wasmManifest.capabilities,
    produced: wasmManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'WABT requires a stored WebAssembly module and task context' }
  }

  const baseUrl = process.env.REAMON_WASM_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated WebAssembly analyzer is not configured' }

  const timeout = AbortSignal.timeout(boundedTimeoutMs())
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    const response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
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
        ? payload.error.slice(0, 1_000)
        : `WABT analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isWasmResponse(payload)) throw new Error('WABT analyzer returned an invalid result')

    const units = payload.units.slice(0, MAX_UNITS).filter(isWasmUnit)
    if (!units.length) throw new Error('WABT did not produce any viewable WebAssembly functions')
    const observations: ToolObservation[] = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: `wasm:function:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${unit.address}`).digest('hex').slice(0, 32)}`,
      label: unit.name,
      attributes: {
        unitType: 'function',
        name: unit.name,
        qualifiedName: unit.name,
        address: unit.address,
        relativePath: unit.relativePath,
        sizeBytes: unit.sizeBytes,
        language: 'WebAssembly Text (WAT)',
        decompiled: true,
        codeArtifactId: unit.codeArtifactId,
        ...(unit.disassemblyArtifactId ? { disassemblyArtifactId: unit.disassemblyArtifactId } : {}),
        ...(unit.disassemblyRelativePath ? { disassemblyRelativePath: unit.disassemblyRelativePath } : {}),
        ...(unit.disassemblyLanguage ? { disassemblyLanguage: unit.disassemblyLanguage } : {}),
        ...(unit.sourceAddressMap ? { sourceAddressMap: JSON.stringify(unit.sourceAddressMap) } : {}),
        ...(unit.sourceAddressMapTruncated ? { sourceAddressMapTruncated: true } : {}),
        ...(unit.instructionMnemonics?.length ? { instructionMnemonics: JSON.stringify(unit.instructionMnemonics.slice(0, 800)) } : {}),
      },
    }))
    const rustUnits = (Array.isArray(payload.rustUnits) ? payload.rustUnits : []).slice(0, MAX_UNITS).filter(isWasmUnit)
    for (const unit of rustUnits) {
      const sourceKey = `wasm:function:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${unit.address}`).digest('hex').slice(0, 32)}`
      const rustKey = `wasm:rust-function:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${unit.address}`).digest('hex').slice(0, 32)}`
      observations.push({
        kind: 'entity',
        type: 'code_unit',
        key: rustKey,
        label: `${unit.name} (Rust reconstruction)`,
        attributes: {
          unitType: 'function',
          name: unit.name,
          qualifiedName: unit.name,
          address: unit.address,
          relativePath: unit.relativePath,
          sizeBytes: unit.sizeBytes,
          language: 'Rust',
          sourceLanguage: 'WebAssembly',
          representation: 'unwasm level 0 Rust translation; not recovered original Rust source',
          decompiler: 'unwasm',
          decompilerVersion: payload.rustVersion?.slice(0, 120) || 'unwasm (version unavailable)',
          nameEvidence: typeof unit.nameEvidence === 'string' ? unit.nameEvidence.slice(0, 80) : 'unavailable',
          decompiled: true,
          codeArtifactId: unit.codeArtifactId,
          ...(unit.disassemblyArtifactId ? { disassemblyArtifactId: unit.disassemblyArtifactId } : {}),
          ...(unit.disassemblyRelativePath ? { disassemblyRelativePath: unit.disassemblyRelativePath } : {}),
          ...(unit.disassemblyLanguage ? { disassemblyLanguage: unit.disassemblyLanguage } : {}),
          ...(unit.sourceAddressMap ? { sourceAddressMap: JSON.stringify(unit.sourceAddressMap) } : {}),
          ...(unit.sourceAddressMapTruncated ? { sourceAddressMapTruncated: true } : {}),
        },
      })
      observations.push({
        kind: 'relationship',
        type: 'has_translation',
        relation: 'has_translation',
        key: `wasm:translation:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${unit.address}`).digest('hex').slice(0, 32)}`,
        fromKey: sourceKey,
        toKey: rustKey,
        label: `${unit.name} translated from WebAssembly to Rust`,
        attributes: { sourceLanguage: 'WebAssembly', outputLanguage: 'Rust', provider: 'unwasm' },
      })
    }
    const unitAddresses = new Set(units.map((unit) => unit.address))
    const calls = (Array.isArray(payload.calls) ? payload.calls : []).slice(0, MAX_UNITS)
    const externalFunctions = new Set<string>()
    const seenEdges = new Set<string>()
    for (const call of calls) {
      if (!call || typeof call.fromAddress !== 'string' || typeof call.toAddress !== 'string'
          || typeof call.fromName !== 'string' || typeof call.toName !== 'string'
          || call.fromAddress.length > 128 || call.toAddress.length > 128
          || call.fromName.length > 500 || call.toName.length > 500
          || !unitAddresses.has(call.fromAddress)) continue
      const edgeIdentity = `${call.fromAddress}->${call.toAddress}`
      if (seenEdges.has(edgeIdentity)) continue
      seenEdges.add(edgeIdentity)
      const fromKey = `wasm:function:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${call.fromAddress}`).digest('hex').slice(0, 32)}`
      let toKey = `wasm:function:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${call.toAddress}`).digest('hex').slice(0, 32)}`
      if (!unitAddresses.has(call.toAddress)) {
        if (!externalFunctions.has(toKey)) {
          externalFunctions.add(toKey)
          observations.push({
            kind: 'entity',
            type: 'function',
            key: toKey,
            label: call.toName,
            attributes: {
              identity: `${input.artifactId}:${call.toAddress}`,
              qualifiedName: call.toName,
              name: call.toName,
              address: call.toAddress,
              language: 'WebAssembly',
              externalOrUndecompiled: true,
            },
          })
        }
      }
      const digest = createHash('sha256').update(`${input.artifactId}:${call.fromAddress}:${call.toAddress}`).digest('hex').slice(0, 32)
      observations.push({
        kind: 'relationship',
        type: 'calls',
        relation: 'calls',
        key: `wasm:call:${digest}`,
        fromKey,
        toKey,
        label: `${call.fromName} calls ${call.toName}`.slice(0, 500),
        attributes: { fromAddress: call.fromAddress, toAddress: call.toAddress },
      })
    }
    const omittedUnits = payload.units.length - units.length
    const truncated = payload.truncated || payload.functionCount > units.length || omittedUnits > 0 || payload.callGraphTruncated === true || (payload.calls?.length || 0) > MAX_UNITS
    const warnings = [payload.warnings?.trim(), omittedUnits > 0 ? `${omittedUnits} invalid or excess function records were omitted.` : '']
      .filter(Boolean).join(' ').slice(0, 4_000)

    return {
      status: 'completed',
      ...base,
      data: {
        observations,
        wasmFunctionCount: payload.functionCount,
        returnedFunctionCount: units.length,
        omittedFunctionCount: omittedUnits,
        rustFunctionCount: rustUnits.length,
        callCount: seenEdges.size,
        callGraphTruncated: payload.callGraphTruncated === true || (payload.calls?.length || 0) > MAX_UNITS,
        codeBytes: payload.codeBytes ?? units.reduce((sum, unit) => sum + unit.sizeBytes, 0),
        truncated,
        wabtVersion: payload.toolVersion.slice(0, 80),
        warnings,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const wasmPlugin: ToolPlugin = { manifest: wasmManifest, analyze: executeWasm }
