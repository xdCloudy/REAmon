import { createHash } from 'node:crypto'
import { readAnalyzerResponse } from './analyzer-response'
import prisma from '@/lib/prisma'
import { nativeFunctionIdentity } from './native-function-identity'
import type { ToolExecutionInput, ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const MAX_UNITS = 1200
const DEFAULT_TIMEOUT_MS = 30 * 60_000

interface IdaUnit {
  name: string
  address: string
  relativePath: string
  codeArtifactId: string
  codeSha256: string
  sizeBytes: number
  disassemblyArtifactId: string
  disassemblySha256: string
}

interface IdaResult {
  status: 'completed'
  idaVersion: string
  architecture: string
  sourceSha256: string
  functionCount: number
  failedFunctionCount: number
  truncated: boolean
  units: IdaUnit[]
  calls: Array<{ fromAddress: string; toAddress: string; fromName: string; toName: string }>
}

export const idaManifest: ToolPluginManifest = {
  id: 'reamon-ida',
  name: 'IDA Pro Native Decompiler',
  category: 'static_analysis',
  integration: 'process',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['elf', 'pe', 'pe-dll', 'macho'],
  capabilities: ['decompile', 'disassemble'],
  produces: ['CodeUnit', 'DecompiledSource', 'FunctionAddress', 'CallGraph'],
  requirements: [
    { key: 'licensedIdaInstall', value: 'User-provided IDA Pro installation mounted under /opt/ida' },
    { key: 'artifactPath' },
  ],
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'IDA analysis failed'
}

function isIdaResult(value: unknown): value is IdaResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.status === 'completed'
    && typeof row.idaVersion === 'string' && row.idaVersion.length > 0 && row.idaVersion.length <= 128
    && typeof row.architecture === 'string' && row.architecture.length <= 128
    && typeof row.sourceSha256 === 'string' && /^[a-f0-9]{64}$/i.test(row.sourceSha256)
    && Number.isSafeInteger(row.functionCount) && (row.functionCount as number) >= 0
    && Number.isSafeInteger(row.failedFunctionCount) && (row.failedFunctionCount as number) >= 0
    && typeof row.truncated === 'boolean' && Array.isArray(row.units) && Array.isArray(row.calls)
}

function validUnit(value: unknown, prefix: string): value is IdaUnit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 500
    && typeof row.address === 'string' && /^0x[0-9a-f]{1,16}$/i.test(row.address)
    && typeof row.relativePath === 'string' && /^functions\/[0-9a-f]{16}\.c$/i.test(row.relativePath)
    && row.codeArtifactId === `${prefix}${row.relativePath}`
    && typeof row.codeSha256 === 'string' && /^[a-f0-9]{64}$/i.test(row.codeSha256)
    && Number.isSafeInteger(row.sizeBytes) && (row.sizeBytes as number) > 0 && (row.sizeBytes as number) <= 2 * 1024 * 1024
    && typeof row.disassemblyArtifactId === 'string' && /^assembly\/[0-9a-f]{16}\.asm$/i.test(row.disassemblyArtifactId.slice(prefix.length))
    && row.disassemblyArtifactId.startsWith(prefix)
    && typeof row.disassemblySha256 === 'string' && /^[a-f0-9]{64}$/i.test(row.disassemblySha256)
}

export async function executeIda(input: ToolExecutionInput): Promise<ToolResult> {
  const base = { toolId: idaManifest.id, capabilities: idaManifest.capabilities, produced: idaManifest.produces }
  if (!input.artifactPath || !input.artifactId || !input.projectId || !input.taskId || !input.runToken) {
    return { status: 'failed', ...base, data: {}, error: 'IDA requires a stored native binary and task context' }
  }

  const baseUrl = process.env.REAMON_IDA_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return { status: 'failed', ...base, data: {}, error: 'The isolated IDA analyzer is not configured' }
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { userId: true } })
  if (!project) return { status: 'failed', ...base, data: {}, error: 'The project for this IDA task no longer exists' }
  const settings = await prisma.userSettings.findUnique({ where: { userId: project.userId }, select: { idaExecutablePath: true } })
  const executablePath = settings?.idaExecutablePath?.trim()
  if (!executablePath) return { status: 'failed', ...base, data: {}, error: 'IDA Pro is not configured. Add its batch executable path in Settings → System.' }
  if (!/^\/opt\/ida\/(?:[A-Za-z0-9._-]+\/)*idat(?:64)?$/.test(executablePath)) {
    return { status: 'failed', ...base, data: {}, error: 'IDA executable must be idat or idat64 under /opt/ida' }
  }
  const artifact = await prisma.artifact.findFirst({ where: { id: input.artifactId, projectId: input.projectId }, select: { sha256: true } })
  if (!artifact || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    return { status: 'failed', ...base, data: {}, error: 'IDA could not verify the stored input artifact hash' }
  }

  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    await input.reportProgress?.('IDA Pro is analyzing the binary in the isolated analyzer')
    const response = await fetch(`${baseUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({
        projectId: input.projectId,
        artifactId: input.artifactId,
        taskId: input.taskId,
        runId: input.runToken,
        artifactPath: input.artifactPath,
        executablePath,
      }),
      signal,
      cache: 'no-store',
    })
    const payload: unknown = await readAnalyzerResponse<unknown>(response, input.reportProgress)
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error.slice(0, 1200)
        : `IDA analyzer returned HTTP ${response.status}`
      throw new Error(detail)
    }
    if (!isIdaResult(payload)) throw new Error('IDA analyzer returned an invalid result bundle')
    if (payload.sourceSha256.toLowerCase() !== artifact.sha256.toLowerCase()) {
      throw new Error('IDA analyzer input hash did not match the stored artifact')
    }

    const expectedPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/ida/`
    const units = payload.units.slice(0, MAX_UNITS).filter((unit) => validUnit(unit, expectedPrefix))
    if (!units.length) throw new Error('IDA produced no Hex-Rays pseudocode. Confirm the Pro/Hex-Rays license is available to the analyzer runtime.')
    const observations: ToolObservation[] = units.map((unit) => ({
      kind: 'entity',
      type: 'code_unit',
      key: `ida:function:${createHash('sha256').update(`${input.artifactId}:${input.taskId}:${unit.address}`).digest('hex').slice(0, 32)}`,
      label: unit.name,
      attributes: {
        unitType: 'function',
        ...(nativeFunctionIdentity(input.artifactId!, unit.address) ? { identity: nativeFunctionIdentity(input.artifactId!, unit.address)! } : {}),
        name: unit.name,
        qualifiedName: unit.name,
        address: unit.address,
        relativePath: unit.relativePath,
        sizeBytes: unit.sizeBytes,
        language: 'C',
        representation: 'pseudocode',
        representationSemantics: 'IDA Hex-Rays pseudocode reconstructed from a native binary; it is analysis evidence, not original source or proof of behavior.',
        decompiler: 'IDA Pro',
        decompilerVersion: payload.idaVersion,
        architecture: payload.architecture,
        inputArtifactSha256: payload.sourceSha256.toLowerCase(),
        codeArtifactId: unit.codeArtifactId,
        codeArtifactSha256: unit.codeSha256.toLowerCase(),
        decompiledSourceSha256: unit.codeSha256.toLowerCase(),
        disassemblyArtifactId: unit.disassemblyArtifactId,
        disassemblyArtifactSha256: unit.disassemblySha256.toLowerCase(),
        source: 'IDA Pro Hex-Rays',
      },
    }))

    const seenEdges = new Set<string>()
    for (const edge of payload.calls.slice(0, 400)) {
      if (!edge || typeof edge.fromAddress !== 'string' || typeof edge.toAddress !== 'string'
        || !/^0x[0-9a-f]{1,16}$/i.test(edge.fromAddress) || !/^0x[0-9a-f]{1,16}$/i.test(edge.toAddress)) continue
      const digest = createHash('sha256').update(`${input.artifactId}:${edge.fromAddress}:${edge.toAddress}`).digest('hex').slice(0, 32)
      if (seenEdges.has(digest)) continue
      seenEdges.add(digest)
      observations.push({
        kind: 'relationship',
        type: 'calls',
        key: `ida:call:${digest}`,
        fromKey: `ida:function-target:${createHash('sha256').update(`${input.artifactId}:${edge.fromAddress}`).digest('hex').slice(0, 32)}`,
        toKey: `ida:function-target:${createHash('sha256').update(`${input.artifactId}:${edge.toAddress}`).digest('hex').slice(0, 32)}`,
        label: `${edge.fromName} calls ${edge.toName}`.slice(0, 1000),
        attributes: { fromAddress: edge.fromAddress, toAddress: edge.toAddress, decompiler: 'IDA Pro' },
      })
    }

    return {
      status: 'completed',
      ...base,
      data: {
        functionCount: payload.functionCount,
        decompiledFunctionCount: units.length,
        returnedFunctionCount: units.length,
        failedFunctionCount: payload.failedFunctionCount,
        callCount: seenEdges.size,
        truncated: payload.truncated || payload.functionCount > units.length || payload.units.length > units.length,
        sourceSha256: payload.sourceSha256.toLowerCase(),
        idaVersion: payload.idaVersion,
        architecture: payload.architecture,
        observations,
      },
    }
  } catch (error) {
    return { status: 'failed', ...base, data: {}, error: errorText(error) }
  }
}

export const idaPlugin: ToolPlugin = { manifest: idaManifest, analyze: executeIda }
