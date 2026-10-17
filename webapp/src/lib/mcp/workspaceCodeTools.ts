/** Database-backed code-unit reads for agents working on REAmon workspaces. */
import { open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import prisma from '@/lib/prisma'
import { assertMcpProjectAccess, requireScope } from '@/lib/mcpAuth'
import { McpToolError } from '@/lib/mcp/errors'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { CODE_UNIT_OBSERVATION_TYPE, flossRecoveredStringsOf, providerVariablesOf } from '@/lib/reamon/code-units'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { buildProjectSymbolContext } from '@/lib/reamon/maintenance-memory'
import { nativeAddressAliases, nativeFunctionIdentity } from '@/lib/reamon/native-function-identity'
import { codeNoteText, REAMON_CODE_NOTE_SOURCE } from '@/lib/reamon/code-notes'
import { enforceRate, type McpContext } from '@/lib/mcp/tools'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_CODE_BYTES = 128 * 1024
const MAX_HASH_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_REIPA_BYTES = 128 * 1024
const MAX_RECURSE_EVIDENCE_BYTES = 12 * 1024
const MAX_RELATIONSHIPS = 100
const MAX_PROVIDER_ALTERNATES = 3
const MAX_PROVIDER_ALTERNATE_BYTES = 16 * 1024
const MAX_PROJECT_MEMORY_MATCHES = 100
const CODE_UNIT_TYPES = [CODE_UNIT_OBSERVATION_TYPE, 'function']
const REFERENCE_RELATIONSHIP_TYPES = ['reads_field', 'writes_field', 'references_field', 'references_string']
const REIPA_PROVIDER_VERSION = 'ReIPA@b0d4759451ed20796892a059fa53d9dbb130af61'
const RECURSE_PROVIDER_VERSION = '0.1.0'
const RECURSE_PROVIDER_REVISION = '34ff28af22e6724d29e100001ef79dfe2a001d15'

export interface WorkspaceListCodeUnitsArgs {
  projectId: string
  search?: string
  taskId?: string
  limit?: number
  offset?: number
}

export interface WorkspaceGetCodeUnitArgs {
  projectId: string
  codeUnitId: string
}

export interface WorkspaceSearchGoTypesArgs {
  projectId: string
  codeUnitId: string
  search?: string
  limit?: number
  offset?: number
}

type GoTypeDetail = { name: string; kind: string; reconstructed: string; provider?: string }
type GoInterfaceMethod = {
  interfaceName: string
  concreteType: string
  method: string
  itabAddress: string
  concreteFunctionAddress: string
  incomplete: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function textList(value: unknown, limit: number, maxLength: number): string[] {
  let parsed = value
  if (typeof value === 'string') {
    if (value.length > 100_000) return []
    try { parsed = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return [...new Set(parsed.flatMap((item) => {
    const normalized = text(item, maxLength)
    return normalized ? [normalized] : []
  }))].slice(0, limit)
}

function boundedJsonTextList(value: unknown, maxBytes: number, maxItems: number, maxLength: number): { items: string[]; truncated: boolean } {
  if (typeof value !== 'string') return { items: [], truncated: false }
  if (value.length > maxBytes) return { items: [], truncated: true }
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return { items: [], truncated: true } }
  if (!Array.isArray(parsed)) return { items: [], truncated: true }
  const items: string[] = []
  let bytes = 0
  for (const candidate of parsed) {
    const normalized = text(candidate, maxLength)
    if (!normalized || items.includes(normalized)) continue
    const itemBytes = Buffer.byteLength(normalized, 'utf8') + 1
    if (items.length >= maxItems || bytes + itemBytes > maxBytes) {
      return { items, truncated: true }
    }
    items.push(normalized)
    bytes += itemBytes
  }
  return { items, truncated: items.length < parsed.length }
}

function parseStoredGoTypeDetails(value: unknown): { items: GoTypeDetail[]; truncated: boolean } {
  if (typeof value !== 'string') return { items: [], truncated: false }
  if (value.length > 128_000) return { items: [], truncated: true }
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return { items: [], truncated: true } }
  if (!Array.isArray(parsed)) return { items: [], truncated: true }
  const items: GoTypeDetail[] = []
  let truncated = parsed.length > 1000
  for (const candidate of parsed.slice(0, 1000)) {
    const detail = record(candidate)
    if (typeof detail.name !== 'string' || !detail.name.trim()
        || (typeof detail.kind !== 'string') || typeof detail.reconstructed !== 'string') {
      truncated = true
      continue
    }
    const normalized = {
      name: detail.name.trim().slice(0, 256),
      kind: detail.kind.trim().slice(0, 128),
      reconstructed: detail.reconstructed.trim().slice(0, 4096),
      ...(detail.source === 'unstrip' ? { provider: 'unstrip' } : {}),
    }
    items.push(normalized)
    if (normalized.name.length !== detail.name.length
        || normalized.kind.length !== detail.kind.length
        || normalized.reconstructed.length !== detail.reconstructed.length) truncated = true
  }
  return { items, truncated }
}

function boundedGoTypeDetails(value: unknown): { items: GoTypeDetail[]; truncated: boolean } {
  const parsed = parseStoredGoTypeDetails(value)
  const items: GoTypeDetail[] = []
  let bytes = 0
  let truncated = parsed.truncated || parsed.items.length > 32
  for (const normalized of parsed.items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8') + 1
    if (items.length >= 32 || bytes + itemBytes > 12_000) {
      truncated = true
      continue
    }
    items.push(normalized)
    bytes += itemBytes
  }
  return { items, truncated }
}

function parseGoInterfaceMethods(value: unknown): { items: GoInterfaceMethod[]; truncated: boolean } {
  if (typeof value !== 'string') return { items: [], truncated: false }
  if (value.length > 64_000) return { items: [], truncated: true }
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return { items: [], truncated: true } }
  if (!Array.isArray(parsed)) return { items: [], truncated: true }
  const items: GoInterfaceMethod[] = []
  let truncated = parsed.length > 32
  for (const candidate of parsed.slice(0, 32)) {
    const item = record(candidate)
    if (typeof item.interfaceName !== 'string' || !item.interfaceName.trim()
        || typeof item.concreteType !== 'string' || !item.concreteType.trim()
        || typeof item.method !== 'string' || !item.method.trim()
        || typeof item.itabAddress !== 'string' || typeof item.concreteFunctionAddress !== 'string'
        || typeof item.incomplete !== 'boolean') {
      truncated = true
      continue
    }
    items.push({
      interfaceName: item.interfaceName.trim().slice(0, 500),
      concreteType: item.concreteType.trim().slice(0, 500),
      method: item.method.trim().slice(0, 256),
      itabAddress: item.itabAddress.slice(0, 128),
      concreteFunctionAddress: item.concreteFunctionAddress.slice(0, 128),
      incomplete: item.incomplete,
    })
  }
  return { items, truncated }
}

function sourceAddressMappings(value: unknown): { mappings: Array<{ sourceLineNumber: number; address: string }>; truncated: boolean } {
  if (typeof value !== 'string' || value.length > 1_000_000) return { mappings: [], truncated: false }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return { mappings: [], truncated: false }
    const mappings = parsed.flatMap((item) => {
      const mapping = record(item)
      const lineNumber = mapping.sourceLineNumber ?? mapping.ghidraLineNumber
      return Number.isInteger(lineNumber) && Number(lineNumber) > 0
        && Number(lineNumber) <= 1_000_000
        && typeof mapping.address === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(mapping.address)
        ? [{ sourceLineNumber: Number(lineNumber), address: mapping.address }]
        : []
    })
    return { mappings: mappings.slice(0, 500), truncated: mappings.length > 500 || mappings.length !== parsed.length }
  } catch {
    return { mappings: [], truncated: false }
  }
}

function boundedSource(value: string): { sourceCode: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8')
  const truncated = bytes.byteLength > MAX_CODE_BYTES
  const prefix = bytes.subarray(0, MAX_CODE_BYTES).toString('utf8')
  return { sourceCode: truncated ? prefix.replace(/\uFFFD$/, '') : prefix, truncated }
}

function safeDerivedPath(relativePath: unknown, projectId: string, artifactId: string | null): string | null {
  if (!artifactId || typeof relativePath !== 'string' || relativePath.length > 2000) return null
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\u0000'))) return null
  if (parts[0] !== projectId || parts[1] !== artifactId) return null
  try { return resolveDerivedArtifactPath(relativePath) } catch { return null }
}

async function readDerivedText(relativePath: unknown, projectId: string, artifactId: string | null) {
  const filePath = safeDerivedPath(relativePath, projectId, artifactId)
  if (!filePath) return null
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const root = await realpath(derivedArtifactRoot())
    const resolved = await realpath(filePath)
    const relative = path.relative(root, resolved)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
    handle = await open(resolved, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 0) return null
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_HASH_SOURCE_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const sourceHash = stat.size <= MAX_HASH_SOURCE_BYTES && bytesRead === stat.size
      ? createHash('sha256').update(buffer).digest('hex')
      : null
    return {
      text: buffer.subarray(0, Math.min(bytesRead, MAX_CODE_BYTES)).toString('utf8'),
      bytesReturned: Math.min(bytesRead, MAX_CODE_BYTES),
      sizeBytes: stat.size,
      truncated: stat.size > MAX_CODE_BYTES,
      sourceHash,
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

function recurseOptimizerPasses(value: unknown): Record<string, number> | null {
  if (typeof value !== 'string' || value.length > 1500) return null
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return null }
  const passes = record(parsed)
  const allowed = ['rounds', 'propagated', 'folded', 'simplified', 'dead_stores_removed', 'branches_resolved']
  const output = Object.fromEntries(allowed.flatMap((name) => {
    const count = passes[name]
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000
      ? [[name, count]] : []
  }))
  return Object.keys(output).length ? output : null
}

async function readMatchingRecurseLift(input: {
  projectId: string
  artifactId: string
  artifactSha256: string
  identity: string
}): Promise<Record<string, unknown> | null> {
  const rows = await prisma.reamonObservation.findMany({
    where: {
      projectId: input.projectId,
      artifactId: input.artifactId,
      source: 'reamon-recurse',
      type: CODE_UNIT_OBSERVATION_TYPE,
      kind: 'entity',
      AND: [
        { attributes: { path: ['identity'], equals: input.identity } },
        { attributes: { path: ['inputArtifactSha256'], equals: input.artifactSha256 } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { taskId: true, label: true, attributes: true },
  })
  const taskIds = [...new Set(rows.flatMap((row) => row.taskId ? [row.taskId] : []))]
  const tasks = taskIds.length ? await prisma.task.findMany({
    where: {
      id: { in: taskIds },
      projectId: input.projectId,
      artifactId: input.artifactId,
      capability: 'decompile',
      status: 'COMPLETED',
      provider: { is: { pluginId: 'reamon-recurse' } },
    },
    select: { id: true, runToken: true, provider: { select: { pluginId: true } } },
  }) : []
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  for (const row of rows) {
    if (!row.taskId) continue
    const task = tasksById.get(row.taskId)
    if (!task || task.provider?.pluginId !== 'reamon-recurse' || !task.runToken) continue
    const attributes = record(row.attributes)
    const address = text(attributes.address, 128) || ''
    const relativePath = text(attributes.relativePath, 1000) || ''
    const codeArtifactId = text(attributes.codeArtifactId, 2000) || ''
    const inputHash = text(attributes.inputArtifactSha256, 64)?.toLowerCase()
    const outputHash = text(attributes.codeArtifactSha256, 64)?.toLowerCase()
    const runPrefix = `${input.projectId}/${input.artifactId}/${task.id}/${task.runToken}/`
    if (attributes.providerRevision !== RECURSE_PROVIDER_REVISION
        || attributes.decompilerVersion !== RECURSE_PROVIDER_VERSION
        || attributes.identity !== input.identity
        || nativeFunctionIdentity(input.artifactId, address) !== input.identity
        || inputHash !== input.artifactSha256.toLowerCase()
        || !outputHash || !/^[a-f0-9]{64}$/.test(outputHash)
        || !/^lift\/[0-9a-f]+\.vtil$/i.test(relativePath)
        || codeArtifactId !== `${runPrefix}${relativePath}`) continue
    const code = await readDerivedText(codeArtifactId, input.projectId, input.artifactId)
    if (!code || code.truncated || code.sourceHash !== outputHash || code.sizeBytes > 128 * 1024) continue
    return {
      provider: 'Recurse',
      providerVersion: RECURSE_PROVIDER_VERSION,
      providerRevision: RECURSE_PROVIDER_REVISION,
      taskId: task.id,
      name: text(row.label, 500) || address,
      address,
      inputArtifactSha256: inputHash,
      outputSha256: code.sourceHash,
      instructionCount: typeof attributes.recurseInstructionCount === 'number'
        && Number.isSafeInteger(attributes.recurseInstructionCount) && attributes.recurseInstructionCount >= 0
        ? attributes.recurseInstructionCount : null,
      optimizerPasses: recurseOptimizerPasses(attributes.recurseOptimizerPasses),
      text: code.text.slice(0, MAX_RECURSE_EVIDENCE_BYTES),
      truncated: code.sizeBytes > MAX_RECURSE_EVIDENCE_BYTES,
      semantics: 'Provisional VTIL-style optimized intermediate representation for this exact function and binary. Recurse lifting is x86/x64-focused; unsupported instructions may remain opaque. This is structural analysis evidence, not recovered original source or proof of behavior.',
    }
  }
  return null
}

async function readVerifiedReipaAlternate(input: {
  projectId: string
  artifactId: string | null
  taskId: string | null
  runToken: string | null
  providerId: string | null
  unitSource: string
  unitAttributes: Record<string, unknown>
  inputSha256: string | null
}) {
  const attributes = input.unitAttributes
  const sourceLanguage = text(attributes.sourceLanguage, 80)
  const addressValue = text(attributes.address ?? attributes.startAddress, 128)?.trim() || ''
  const address = addressValue.replace(/^0x/i, '').replace(/^0+/, '').toLowerCase() || '0'
  const relativePath = text(attributes.reipaAlternateCodeArtifactId, 2000) || ''
  const outputSha256 = (text(attributes.reipaAlternateOutputSha256, 64) || '').toLowerCase()
  if (input.unitSource !== 'reamon-ghidra' || input.providerId !== 'reamon-ghidra'
    || !input.taskId || !input.artifactId || !input.runToken
    || attributes.symbolSource !== 'ReIPA'
    || (sourceLanguage !== 'Swift' && sourceLanguage !== 'Objective-C')
    || attributes.reipaAlternateProviderVersion !== REIPA_PROVIDER_VERSION
    || !/^[a-f0-9]+$/.test(address) || !/^[a-f0-9]{64}$/.test(outputSha256)
    || !input.inputSha256 || attributes.inputArtifactSha256 !== input.inputSha256) return null

  const expectedPrefix = `${input.projectId}/${input.artifactId}/${input.taskId}/${input.runToken}/`
  if (!relativePath.startsWith(expectedPrefix) || relativePath.slice(expectedPrefix.length) !== `alternates/reipa/${address}.c`) return null
  const filePath = safeDerivedPath(relativePath, input.projectId, input.artifactId)
  if (!filePath) return null

  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const root = await realpath(derivedArtifactRoot())
    const runRoot = await realpath(resolveDerivedArtifactPath(expectedPrefix.slice(0, -1)))
    const resolved = await realpath(filePath)
    const relativeToRoot = path.relative(root, runRoot)
    const relativeToRun = path.relative(runRoot, resolved)
    const isInside = (relative: string) => Boolean(relative) && relative !== '..'
      && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    if (!isInside(relativeToRoot) || !isInside(relativeToRun)) return null
    handle = await open(resolved, 'r')
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > MAX_REIPA_BYTES) return null
    const bytes = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== info.size) return null
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')
    if (actualSha256 !== outputSha256) return null
    return {
      provider: 'ReIPA',
      providerVersion: REIPA_PROVIDER_VERSION,
      language: 'C-like pseudocode',
      sourceLanguage,
      address: `0x${address}`,
      artifactId: relativePath,
      outputSha256: actualSha256,
      source: bytes.toString('utf8'),
      semantics: `Experimental ReIPA pseudocode for the exact ${sourceLanguage} function address. This is same-run analysis evidence, not recovered ${sourceLanguage} source or reviewed maintained code.`,
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function prepareRead(ctx: McpContext, projectId: string) {
  requireScope(ctx.token, 'recon:read')
  enforceRate(ctx, 'read')
  await assertMcpProjectAccess(ctx.token.userId, projectId)
  return getActiveWorkspaceImportSelection(projectId)
}

export async function listWorkspaceCodeUnits(ctx: McpContext, args: WorkspaceListCodeUnitsArgs) {
  const selection = await prepareRead(ctx, args.projectId)
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(args.limit ?? DEFAULT_LIMIT)))
  const offset = Math.max(0, Math.min(100_000, Math.floor(args.offset ?? 0)))
  const search = args.search?.trim() || ''
  if (search.length > 200) throw new McpToolError('Code unit search is limited to 200 characters.', 'invalid_input')
  if (args.taskId && args.taskId.length > 64) throw new McpToolError('Invalid analysis task id.', 'invalid_input')

  const where = {
    projectId: args.projectId,
    type: { in: CODE_UNIT_TYPES },
    artifact: { is: selection.artifactWhere },
    ...(args.taskId ? { taskId: args.taskId } : {}),
    ...(search ? {
      OR: [
        { label: { contains: search, mode: 'insensitive' as const } },
        { stableKey: { contains: search, mode: 'insensitive' as const } },
        ...['name', 'qualifiedName', 'address', 'language', 'sourceLanguage', 'dialect', 'engineVersion', 'relativePath', 'prototype', 'symbolSource', 'goPackage'].map((key) => ({
          attributes: { path: [key], string_contains: search, mode: 'insensitive' as const },
        })),
      ],
    } : {}),
  }
  const [rows, total] = await Promise.all([
    prisma.reamonObservation.findMany({
      where,
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: limit,
      select: {
        id: true, stableKey: true, type: true, label: true, source: true, taskId: true, artifactId: true, updatedAt: true, attributes: true,
        artifact: { select: { relativePath: true, originalName: true, sha256: true } },
      },
    }),
    prisma.reamonObservation.count({ where }),
  ])
  return {
    projectId: args.projectId,
    units: rows.map((row) => {
      const attributes = record(row.attributes)
      return {
        id: row.id,
        stableKey: row.stableKey,
        observationType: row.type,
        taskId: row.taskId,
        artifactId: row.artifactId,
        name: text(attributes.qualifiedName) || text(attributes.name) || text(row.label) || row.stableKey,
        unitType: text(attributes.unitType, 80),
        language: text(attributes.language, 80),
        sourceLanguage: text(attributes.sourceLanguage, 80),
        dialect: text(attributes.dialect, 40),
        engineVersion: text(attributes.engineVersion, 80),
        inputSha256: text(attributes.inputSha256, 64),
        vectorConstructor: text(attributes.vectorConstructor, 120),
        vectorSize: attributes.vectorSize === 3 || attributes.vectorSize === 4 ? attributes.vectorSize : null,
        address: text(attributes.address ?? attributes.startAddress, 128),
        prototype: text(attributes.prototype, 1000),
        symbolSource: text(attributes.symbolSource, 80),
        packageName: text(attributes.goPackage, 500),
        parentCodeUnitKey: text(attributes.parentCodeUnitKey, 1000),
        externalOrUndecompiled: attributes.externalOrUndecompiled === true,
        relativePath: text(attributes.relativePath, 1000),
        artifactPath: row.artifact?.relativePath || row.artifact?.originalName || null,
        artifactSha256: row.artifact?.sha256 || null,
        sourceArtifactSha256: text(attributes.sourceArtifactSha256, 64),
        assemblyArtifactSha256: text(attributes.assemblyArtifactSha256, 64),
        source: row.source,
        updatedAt: row.updatedAt.toISOString(),
      }
    }),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  }
}

export async function getWorkspaceCodeUnit(ctx: McpContext, args: WorkspaceGetCodeUnitArgs) {
  const selection = await prepareRead(ctx, args.projectId)
  if (!args.codeUnitId || args.codeUnitId.length > 64) throw new McpToolError('Invalid code unit id.', 'invalid_input')
  const unit = await prisma.reamonObservation.findFirst({
    where: {
      id: args.codeUnitId,
      projectId: args.projectId,
      type: { in: CODE_UNIT_TYPES },
      artifact: { is: selection.artifactWhere },
    },
    select: {
      id: true, stableKey: true, canonicalKey: true, type: true, label: true, source: true, taskId: true, artifactId: true, updatedAt: true, attributes: true,
      artifact: { select: { relativePath: true, originalName: true, sha256: true } },
    },
  })
  if (!unit) throw new McpToolError('Code unit not found in the active workspace import.', 'not_found')

  const attributes = record(unit.attributes)
  const savedCodeNote = await prisma.reamonObservation.findFirst({
    where: {
      projectId: args.projectId,
      artifactId: unit.artifactId,
      source: REAMON_CODE_NOTE_SOURCE,
      stableKey: unit.id,
    },
    select: { attributes: true },
  })
  const projectCodeNote = codeNoteText(savedCodeNote?.attributes, text(attributes.decompiledSourceSha256, 64) || undefined)
  const sourceAddressMap = sourceAddressMappings(attributes.sourceAddressMap)
  const parentCodeUnitKey = text(attributes.parentCodeUnitKey, 1000)
  const parentUnit = unit.type === 'function' && parentCodeUnitKey ? await prisma.reamonObservation.findFirst({
    where: {
      projectId: args.projectId,
      taskId: unit.taskId,
      artifactId: unit.artifactId,
      source: unit.source,
      stableKey: parentCodeUnitKey,
      type: CODE_UNIT_OBSERVATION_TYPE,
    },
    select: { id: true, stableKey: true, label: true, attributes: true },
  }) : null
  const maintenanceCodeUnitId = parentUnit?.id || unit.id
  const maintenanceAttributes = record(parentUnit?.attributes)
  const codeArtifactId = text(attributes.codeArtifactId, 2000)
  const disassemblyArtifactId = text(attributes.disassemblyArtifactId, 2000)
  const bytecodeArtifactId = text(attributes.bytecodeArtifactId, 2000)
  const rawEvidenceArtifactId = text(attributes.rawEvidenceArtifactId, 2000)
  const classUnitEdgeFilters = unit.type === CODE_UNIT_OBSERVATION_TYPE ? [
    { attributes: { path: ['fromCodeUnitKey'], equals: unit.stableKey } },
    { attributes: { path: ['toCodeUnitKey'], equals: unit.stableKey } },
  ] : []
  const classReferenceFilters = unit.type === CODE_UNIT_OBSERVATION_TYPE
    ? [{ attributes: { path: ['fromCodeUnitKey'], equals: unit.stableKey } }]
    : []
  const currentAddress = text(attributes.address ?? attributes.startAddress, 128) || ''
  const currentNativeIdentity = unit.artifactId ? nativeFunctionIdentity(unit.artifactId, currentAddress) : null
  const currentAddressAliases = nativeAddressAliases(currentAddress)
  const [code, disassembly, bytecode, rawEvidence, task, edges, referenceEdges, maintained, providerTypeMetadataRow, providerAlternateRows] = await Promise.all([
    readDerivedText(codeArtifactId, args.projectId, unit.artifactId),
    readDerivedText(disassemblyArtifactId, args.projectId, unit.artifactId),
    readDerivedText(bytecodeArtifactId, args.projectId, unit.artifactId),
    readDerivedText(rawEvidenceArtifactId, args.projectId, unit.artifactId),
    unit.taskId ? prisma.task.findFirst({
      where: { id: unit.taskId, projectId: args.projectId, artifactId: unit.artifactId },
      select: { id: true, title: true, status: true, completedAt: true, runToken: true, provider: { select: { pluginId: true } }, result: true },
    }) : null,
    unit.taskId ? prisma.reamonObservation.findMany({
      where: {
        projectId: args.projectId,
        taskId: unit.taskId,
        artifactId: unit.artifactId,
        source: unit.source,
        kind: 'relationship',
        type: 'calls',
        OR: [
          { fromKey: unit.stableKey },
          { toKey: unit.stableKey },
          ...classUnitEdgeFilters,
        ],
      },
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      take: MAX_RELATIONSHIPS + 1,
      select: { stableKey: true, label: true, fromKey: true, toKey: true, attributes: true },
    }) : [],
    unit.taskId ? prisma.reamonObservation.findMany({
      where: {
        projectId: args.projectId,
        taskId: unit.taskId,
        artifactId: unit.artifactId,
        source: unit.source,
        kind: 'relationship',
        type: { in: REFERENCE_RELATIONSHIP_TYPES },
        OR: [
          { fromKey: unit.stableKey },
          ...classReferenceFilters,
        ],
      },
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      take: MAX_RELATIONSHIPS + 1,
      select: { stableKey: true, type: true, label: true, fromKey: true, toKey: true, attributes: true },
    }) : [],
    prisma.reamonMaintainedSource.findFirst({
      where: { projectId: args.projectId, codeUnitId: maintenanceCodeUnitId, artifactId: unit.artifactId || '' },
      select: { sourceCode: true, sourceHash: true, acceptedReviewId: true, language: true, updatedAt: true },
    }),
    (unit.source === 'reamon-ghidra' || unit.source === 'reamon-tocode-import') && unit.taskId ? prisma.reamonObservation.findFirst({
      where: {
        projectId: args.projectId,
        taskId: unit.taskId,
        artifactId: unit.artifactId,
        source: unit.source,
        type: 'language_metadata',
        AND: [
          { attributes: { path: ['language'], equals: unit.source === 'reamon-ghidra' ? 'Go' : 'ToCode' } },
          ...(unit.source === 'reamon-tocode-import' ? [{ attributes: { path: ['exportPath'], equals: text(attributes.exportPath, 1000) || '.' } }] : []),
        ],
      },
      select: { attributes: true },
    }) : null,
    unit.type === CODE_UNIT_OBSERVATION_TYPE && unit.artifactId
      && unit.artifact?.sha256 && /^[a-f0-9]{64}$/i.test(unit.artifact.sha256)
      ? prisma.reamonObservation.findMany({
        where: {
          projectId: args.projectId,
          artifactId: unit.artifactId,
          type: CODE_UNIT_OBSERVATION_TYPE,
          kind: 'entity',
          id: { not: unit.id },
          source: { notIn: [unit.source, 'reamon-recurse'] },
          task: { is: { status: 'COMPLETED', capability: 'decompile' } },
          AND: [{ attributes: { path: ['inputArtifactSha256'], equals: unit.artifact.sha256 } }],
          OR: [
            { canonicalKey: unit.canonicalKey },
            ...(currentNativeIdentity ? [
              { attributes: { path: ['identity'], equals: currentNativeIdentity } },
              ...currentAddressAliases.flatMap((address) => [
                { attributes: { path: ['address'], equals: address } },
                { attributes: { path: ['startAddress'], equals: address } },
              ]),
            ] : []),
          ],
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: MAX_PROJECT_MEMORY_MATCHES,
        select: { id: true, stableKey: true, canonicalKey: true, source: true, label: true, taskId: true, attributes: true },
      })
      : [],
  ])
  const alternateProviderByUnitId = new Map(providerAlternateRows.map((row) => [row.id, row.source]))
  const alternateIdentityEvidenceByUnitId = new Map(providerAlternateRows.map((row) => {
    const rowAttributes = record(row.attributes)
    return [row.id, row.canonicalKey === unit.canonicalKey ? 'canonical' as const
      : rowAttributes.identity === currentNativeIdentity ? 'native_identity' as const : 'native_address_alias' as const]
  }))
  const alternateMaintainedRows = providerAlternateRows.length ? await prisma.reamonMaintainedSource.findMany({
    where: { projectId: args.projectId, artifactId: unit.artifactId || '', codeUnitId: { in: providerAlternateRows.map((row) => row.id) } },
    select: { codeUnitId: true, artifactId: true, unitName: true, language: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  }) : []
  const alternateReviewIds = [...new Set(alternateMaintainedRows.flatMap((row) => row.acceptedReviewId ? [row.acceptedReviewId] : []))]
  const alternateReviews = alternateReviewIds.length ? await prisma.reamonCodeReview.findMany({
    where: { projectId: args.projectId, id: { in: alternateReviewIds }, decision: 'ACCEPTED' },
    select: { id: true, artifactId: true, codeUnitId: true, maintainedSourceHash: true },
  }) : []
  const alternateReviewById = new Map(alternateReviews.map((review) => [review.id, review]))
  const acceptedAlternateRows = alternateMaintainedRows.filter((row) => {
    if (!row.sourceHash || !row.acceptedReviewId) return false
    const receipt = alternateReviewById.get(row.acceptedReviewId)
    return receipt?.artifactId === row.artifactId
      && receipt.codeUnitId === row.codeUnitId
      && receipt.maintainedSourceHash === row.sourceHash
  })
  const acceptedCrossProviderProjectMemory = buildProjectSymbolContext(acceptedAlternateRows.map((row) => ({
    ...row,
    artifactHash: unit.artifact?.sha256 || undefined,
    functionIdentity: unit.canonicalKey,
    identityEvidence: alternateIdentityEvidenceByUnitId.get(row.codeUnitId),
    provider: alternateProviderByUnitId.get(row.codeUnitId),
  })), new Set(), 3_500, unit.artifact?.sha256 || undefined, new Set(),
  providerAlternateRows.length >= MAX_PROJECT_MEMORY_MATCHES, undefined, unit.canonicalKey)
  const providerAlternates = []
  for (const alternate of providerAlternateRows) {
    if (providerAlternates.length >= MAX_PROVIDER_ALTERNATES) break
    const alternateAttributes = record(alternate.attributes)
    const inputHash = text(alternateAttributes.inputArtifactSha256, 64)?.toLowerCase()
    const outputHash = text(alternateAttributes.codeArtifactSha256, 64)?.toLowerCase()
    const alternatePath = text(alternateAttributes.codeArtifactId, 2000)
    if (inputHash !== unit.artifact?.sha256?.toLowerCase()
        || !outputHash || !/^[a-f0-9]{64}$/.test(outputHash)
        || !alternatePath) continue
    const alternateCode = await readDerivedText(alternatePath, args.projectId, unit.artifactId)
    if (!alternateCode?.sourceHash || alternateCode.sourceHash.toLowerCase() !== outputHash) continue
    const codeBuffer = Buffer.from(alternateCode.text, 'utf8')
    const boundedSource = codeBuffer.length > MAX_PROVIDER_ALTERNATE_BYTES
      ? codeBuffer.subarray(0, MAX_PROVIDER_ALTERNATE_BYTES).toString('utf8').replace(/\uFFFD$/, '')
      : alternateCode.text
    providerAlternates.push({
      provider: alternate.source,
      identityMatch: alternateIdentityEvidenceByUnitId.get(alternate.id),
      name: text(alternateAttributes.qualifiedName) || text(alternateAttributes.name) || text(alternate.label),
      address: text(alternateAttributes.address ?? alternateAttributes.startAddress, 128),
      language: text(alternateAttributes.language, 80),
      representation: text(alternateAttributes.representation, 80),
      decompiler: text(alternateAttributes.decompiler, 80),
      decompilerVersion: text(alternateAttributes.decompilerVersion, 120),
      taskId: alternate.taskId,
      inputSha256: inputHash,
      outputSha256: outputHash,
      sourceCode: boundedSource,
      sourceCodeTruncated: codeBuffer.length > MAX_PROVIDER_ALTERNATE_BYTES || alternateCode.truncated,
      semantics: 'Completed output from a different provider for the same imported binary, matched by persisted canonical key, normalized native identity, or legacy native address alias as recorded in identityMatch. Input and saved-output SHA-256 values were checked. This is an independent analysis view, not verified original source, accepted maintained code, or proof of equivalent behavior.',
    })
  }
  const reviewReceipt = maintained?.acceptedReviewId && maintained.sourceHash ? await prisma.reamonCodeReview.findFirst({
    where: {
      id: maintained.acceptedReviewId,
      projectId: args.projectId,
      artifactId: unit.artifactId || '',
      codeUnitId: maintenanceCodeUnitId,
      maintainedSourceHash: maintained.sourceHash,
    },
    select: { decision: true, rationale: true, validationStatus: true, validationMethod: true, validationMessage: true, createdAt: true },
  }) : null

  const runKey = codeArtifactId?.split('/').slice(0, 4).join('/') || ''
  const draft = code?.sourceHash && runKey ? await prisma.reamonCodeDraft.findFirst({
    where: {
      projectId: args.projectId,
      artifactId: unit.artifactId || '',
      codeUnitId: maintenanceCodeUnitId,
      runKey,
      sourceHash: code.sourceHash,
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      sourceCode: true, sourceHash: true, draftHash: true, providerName: true, modelIdentifier: true,
      validationStatus: true, validationMethod: true, validationMessage: true,
      syntaxValidated: true, updatedAt: true,
    },
  }) : null

  const endpointKeys = [...new Set([...edges, ...referenceEdges]
    .flatMap((edge) => [edge.fromKey, edge.toKey])
    .filter((key): key is string => Boolean(key)))]
  const endpointRows = endpointKeys.length ? await prisma.reamonObservation.findMany({
    where: {
      projectId: args.projectId,
      taskId: unit.taskId,
      artifactId: unit.artifactId,
      source: unit.source,
      stableKey: { in: endpointKeys },
      type: { in: [...CODE_UNIT_TYPES, 'symbol'] },
    },
    select: { stableKey: true, label: true, attributes: true },
  }) : []
  const endpointNames = new Map(endpointRows.map((row) => {
    const endpoint = record(row.attributes)
    return [row.stableKey, text(endpoint.qualifiedName) || text(endpoint.name) || text(row.label) || row.stableKey]
  }))
  const result = record(task?.result)
  const recoveredVariableData = providerVariablesOf(attributes, unit.source)
  const isRecurseLift = unit.source === 'reamon-recurse'
    && attributes.decompiler === 'Recurse'
    && attributes.representation === 'optimized intermediate representation'
  const recurseLiftEvidence = !isRecurseLift && unit.artifactId && unit.artifact?.sha256 && currentNativeIdentity
    ? await readMatchingRecurseLift({
      projectId: args.projectId,
      artifactId: unit.artifactId,
      artifactSha256: unit.artifact.sha256,
      identity: currentNativeIdentity,
    })
    : null
  const selectedRecurseEvidence = isRecurseLift && code ? {
    provider: 'Recurse',
    providerVersion: text(attributes.decompilerVersion, 120),
    providerRevision: text(attributes.providerRevision, 120),
    taskId: unit.taskId,
    name: text(attributes.qualifiedName) || text(attributes.name) || text(unit.label),
    address: text(attributes.address ?? attributes.startAddress, 128),
    inputArtifactSha256: text(attributes.inputArtifactSha256, 64),
    outputSha256: text(attributes.codeArtifactSha256, 64),
    instructionCount: typeof attributes.recurseInstructionCount === 'number'
      && Number.isSafeInteger(attributes.recurseInstructionCount) && attributes.recurseInstructionCount >= 0
      ? attributes.recurseInstructionCount : null,
    optimizerPasses: recurseOptimizerPasses(attributes.recurseOptimizerPasses),
    text: code.text.slice(0, MAX_RECURSE_EVIDENCE_BYTES),
    truncated: code.sizeBytes > MAX_RECURSE_EVIDENCE_BYTES || code.truncated,
    semantics: text(attributes.representationSemantics, 500)
      || 'Provisional VTIL-style optimized intermediate representation for this exact function and binary. This is structural analysis evidence, not recovered original source or proof of behavior.',
  } : null
  const reipaPseudocode = task?.status === 'COMPLETED' ? await readVerifiedReipaAlternate({
    projectId: args.projectId,
    artifactId: unit.artifactId,
    taskId: unit.taskId,
    runToken: task.runToken,
    providerId: task.provider?.pluginId || null,
    unitSource: unit.source,
    unitAttributes: attributes,
    inputSha256: unit.artifact?.sha256 || null,
  }) : null
  const goMetadataAttributes = record(providerTypeMetadataRow?.attributes)
  const goTypeCatalog = boundedJsonTextList(goMetadataAttributes.types, 4_000, 64, 256)
  const goTypeDetails = boundedGoTypeDetails(goMetadataAttributes.typeDetails)
  const unstripGoTypeDetails = boundedGoTypeDetails(goMetadataAttributes.unstripTypeDetails)
  const unstripGoInterfaceMethods = parseGoInterfaceMethods(attributes.goUnstripInterfaces)
  const goMetadata = providerTypeMetadataRow ? goMetadataAttributes.language === 'Go' ? {
    language: 'Go',
    goVersion: text(goMetadataAttributes.goVersion, 128),
    architecture: text(goMetadataAttributes.goArchitecture, 128),
    recoveredFunctionCount: typeof goMetadataAttributes.recoveredFunctionCount === 'number'
      ? goMetadataAttributes.recoveredFunctionCount
      : null,
    types: goTypeCatalog.items,
    typesTruncated: goTypeCatalog.truncated,
    typeDetails: goTypeDetails.items,
    typeDetailsTruncated: goTypeDetails.truncated || goMetadataAttributes.typeDetailsTruncated === true,
    unstripVersion: text(goMetadataAttributes.unstripVersion, 32),
    unstripTypeDetails: unstripGoTypeDetails.items,
    unstripTypeDetailsTruncated: unstripGoTypeDetails.truncated || goMetadataAttributes.unstripTypeDetailsTruncated === true,
    unstripInterfacesTruncated: goMetadataAttributes.unstripInterfacesTruncated === true,
    typesSemantics: 'Artifact-wide GoReSym and unstrip type evidence from this exact analysis run. unstrip records are explicitly tagged with their provider. They are not assigned to this function; match each candidate against the selected function source or signature before relying on it.',
  } : {
    language: 'ToCode native export',
    unstripInterfacesTruncated: false,
    exportPath: text(goMetadataAttributes.exportPath, 1000),
    typeCount: typeof goMetadataAttributes.typeCount === 'number' ? goMetadataAttributes.typeCount : null,
    typeDetails: goTypeDetails.items,
    typeDetailsTruncated: goTypeDetails.truncated || goMetadataAttributes.typeDetailsTruncated === true,
    typeSourceArtifactId: text(goMetadataAttributes.typeSourceArtifactId, 128),
    typeSourceArtifactSha256: text(goMetadataAttributes.typeSourceArtifactSha256, 64),
    typeSourceArtifactPath: text(goMetadataAttributes.typeSourceArtifactPath, 1000),
    typesSemantics: 'Artifact-wide type declarations from the selected ToCode export’s exact types.json or APK classes.json artifact. They are not assigned to this function; use a type only when the selected function source or signature supports the match.',
  } : null
  const recoveredVariableSemantics = unit.source === 'reamon-ghidra'
    ? 'Recovered names and types are provider evidence from Ghidra symbols, not reviewed canonical names. nameLocked/typeLocked describe constraints applied by Ghidra to its decompiler model; they do not prove original-source provenance or correctness.'
    : `Recovered names and types are provisional provider evidence from ${unit.source}; they are not reviewed canonical names.`
  const claimedToCodeInputSha256 = text(attributes.toCodeClaimedInputSha256, 64)
  const matchedToCodeInputSha256 = text(attributes.toCodeInputArtifactSha256, 64)
  const toCodeInputHashMatched = unit.source === 'reamon-tocode-import'
    && attributes.toCodeInputProvenance === 'HASH_MATCHED_IMPORTED_ARTIFACT'
    && claimedToCodeInputSha256 !== null
    && /^[a-f0-9]{64}$/i.test(claimedToCodeInputSha256)
    && matchedToCodeInputSha256?.toLowerCase() === claimedToCodeInputSha256.toLowerCase()
  const toCodeInputProvenance = unit.source === 'reamon-tocode-import'
    && claimedToCodeInputSha256
    && /^[a-f0-9]{64}$/i.test(claimedToCodeInputSha256) ? {
        status: toCodeInputHashMatched ? 'HASH_MATCHED_IMPORTED_ARTIFACT' : 'HASH_NOT_IMPORTED',
        claimedInput: {
          path: text(attributes.toCodeClaimedInputPath, 1000),
          sha256: claimedToCodeInputSha256.toLowerCase(),
        },
        matchedImportedArtifact: toCodeInputHashMatched ? {
          id: text(attributes.toCodeInputArtifactId, 128),
          path: text(attributes.toCodeInputRelativePath, 1000),
          sha256: matchedToCodeInputSha256?.toLowerCase() || null,
        } : null,
        functionsManifest: {
          artifactId: text(attributes.toCodeFunctionsArtifactId, 128),
          sha256: text(attributes.toCodeFunctionsArtifactSha256, 64),
        },
        inventoryArtifact: {
          artifactId: text(attributes.toCodeInventoryArtifactId, 128),
          sha256: text(attributes.toCodeInventoryArtifactSha256, 64),
        },
        semantics: 'ToCode inventory claim. A matched SHA-256 identifies imported bytes with that digest; it does not attest that ToCode actually analyzed those bytes.',
      } : null

  return {
    projectId: args.projectId,
    codeUnit: {
      id: unit.id,
      stableKey: unit.stableKey,
      observationType: unit.type,
      canonicalKey: unit.canonicalKey,
      name: text(attributes.qualifiedName) || text(attributes.name) || text(unit.label) || unit.stableKey,
      unitType: text(attributes.unitType, 80),
      address: text(attributes.address ?? attributes.startAddress, 128),
      sizeBytes: typeof attributes.sizeBytes === 'number' ? attributes.sizeBytes : null,
      language: text(attributes.language, 80),
      sourceLanguage: text(attributes.sourceLanguage, 80),
      representation: text(attributes.representation, 500),
      representationSemantics: text(attributes.representationSemantics, 500)
        || (attributes.decompiler === 'unwasm' && attributes.sourceLanguage === 'WebAssembly'
        ? 'Generated Rust is a translation view of this WebAssembly function, not the original source. Function and local names are provider evidence, not confirmed source names.'
        : null),
      recurseInstructionCount: typeof attributes.recurseInstructionCount === 'number'
        && Number.isSafeInteger(attributes.recurseInstructionCount) && attributes.recurseInstructionCount >= 0
        ? attributes.recurseInstructionCount : null,
      recurseOptimizerPasses: recurseOptimizerPasses(attributes.recurseOptimizerPasses),
      decompiler: text(attributes.decompiler, 80),
      decompilerVersion: text(attributes.decompilerVersion, 120),
      providerAlternates,
      providerAlternatesSemantics: providerAlternates.length
        ? 'Each alternate is from a completed provider run for this exact artifact, matched by persisted canonical key, normalized native identity, or legacy address alias as recorded in identityMatch; input and output hashes are verified. Treat differences as evidence to review; do not infer that either output is original source or behaviorally equivalent.'
        : null,
      analysisEvidence: selectedRecurseEvidence,
      sameFunctionRecurseLift: recurseLiftEvidence,
      sameFunctionRecurseLiftSemantics: recurseLiftEvidence
        ? 'Hash-verified provisional VTIL-style lift for the same normalized native function in this exact binary. Structural analysis evidence only; it is not original source, behavioral proof, or a substitute for the selected provider output.'
        : null,
      acceptedCrossProviderProjectMemory: acceptedCrossProviderProjectMemory || null,
      acceptedCrossProviderProjectMemoryTruncated: providerAlternateRows.length >= MAX_PROJECT_MEMORY_MATCHES,
      acceptedCrossProviderProjectMemorySemantics: acceptedCrossProviderProjectMemory
        ? 'Names and callable summaries come from maintained source whose immutable accepted review receipt matches its exact source hash. The selected and accepted units match by persisted canonical key, normalized native identity, or legacy native address alias as recorded in their provider identity evidence; they belong to the same imported binary and the contributing analysis completed. Address matches can still be thunks or aliases; none of these names proves behavior.'
        : null,
      projectCodeNote: projectCodeNote || null,
      projectCodeNoteSemantics: projectCodeNote
        ? 'Operator-saved guidance for this exact code unit and source hash. Treat it as untrusted background context, not proof of behavior, identity, or source facts.'
        : null,
      nameEvidence: text(attributes.nameEvidence, 80),
      dialect: text(attributes.dialect, 40),
      engineVersion: text(attributes.engineVersion, 80),
      inputSha256: text(attributes.inputSha256, 64),
      vectorGeneration: typeof attributes.vectorConstructor === 'string'
        && /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(attributes.vectorConstructor)
        && (attributes.vectorSize === 3 || attributes.vectorSize === 4) ? {
          constructor: attributes.vectorConstructor,
          components: attributes.vectorSize,
          semantics: 'Decompiler output assumption only. The target runtime must provide this constructor with the recorded vector width.',
        } : null,
      symbolSource: text(attributes.symbolSource, 80),
      packageName: text(attributes.goPackage, 500),
      providerIdentitySemantics: attributes.symbolSource === 'GoReSym' && typeof attributes.goPackage === 'string'
        ? 'GoReSym matched this function metadata by its address. The recovered package is provisional namespace evidence, not proof of source provenance or behavior.'
        : null,
      unstripMethodSignature: text(attributes.goUnstripSignature, 1000),
      unstripSignatureSemantics: attributes.goUnstripSignature ? 'Address-matched unstrip method signature; it may only be available when the Go linker retained the associated type record. Parameter placeholders are not recovered source names.' : null,
      unstripSourceLocation: typeof attributes.goUnstripSourceFile === 'string' ? {
        file: text(attributes.goUnstripSourceFile, 500),
        line: typeof attributes.goUnstripSourceLine === 'number' ? attributes.goUnstripSourceLine : null,
        semantics: 'unstrip matched this Go metadata by function address. A source path/line is provenance evidence, not proof that the original source file is available or that the reconstructed pseudocode matches it.',
      } : null,
      unstripInterfaceImplementations: unstripGoInterfaceMethods.items,
      unstripInterfaceImplementationsTruncated: unstripGoInterfaceMethods.truncated
        || attributes.goUnstripInterfacesTruncated === true
        || goMetadata?.unstripInterfacesTruncated === true,
      unstripInterfaceSemantics: unstripGoInterfaceMethods.items.length
        ? 'Address-matched unstrip itab method rows from this function. Each row names the interface, concrete type, method, and concrete function address. Incomplete itabs are explicitly flagged; these are provider dispatch records, not proof of behavior in every runtime path.'
        : null,
      languageMetadata: goMetadata,
      prototype: text(attributes.prototype, 2000),
      recoveredVariables: recoveredVariableData.variables,
      recoveredVariablesTruncated: recoveredVariableData.truncated || attributes.recoveredVariablesTruncated === true,
      recoveredVariablesSemantics: recoveredVariableData.variables.length ? recoveredVariableSemantics : null,
      parentCodeUnit: parentUnit ? {
        id: parentUnit.id,
        stableKey: parentUnit.stableKey,
        name: text(maintenanceAttributes.qualifiedName) || text(maintenanceAttributes.name) || text(parentUnit.label) || parentUnit.stableKey,
      } : null,
      parentCodeUnitKey,
      maintenanceTarget: {
        id: maintenanceCodeUnitId,
        stableKey: parentUnit?.stableKey || unit.stableKey,
        scope: parentUnit ? 'containing_code_unit' : 'code_unit',
      },
      externalOrUndecompiled: attributes.externalOrUndecompiled === true,
      relativePath: text(attributes.relativePath, 1000),
      exportPath: text(attributes.exportPath, 1000),
      sourceArtifactSha256: text(attributes.sourceArtifactSha256, 64),
      assemblyArtifactSha256: text(attributes.assemblyArtifactSha256, 64),
      toCodeInputProvenance,
      artifact: unit.artifact ? { id: unit.artifactId, path: unit.artifact.relativePath || unit.artifact.originalName, sha256: unit.artifact.sha256 } : null,
      provider: unit.source,
      updatedAt: unit.updatedAt.toISOString(),
      recoveredTypeData: attributes.recoveredTypeData === true,
      parameters: text(attributes.parametersJson, 4000),
      instructionLanguage: text(attributes.instructionLanguage, 80),
      instructionCount: typeof attributes.instructionCount === 'number' ? attributes.instructionCount : null,
      instructionMnemonics: text(attributes.instructionMnemonics, 16_000),
      sourceAddressMap: sourceAddressMap.mappings,
      sourceAddressMapProvider: text(attributes.sourceAddressMapProvider, 80) || (unit.source === 'reamon-ghidra' ? 'Ghidra' : null),
      sourceAddressMapTruncated: sourceAddressMap.truncated || attributes.sourceAddressMapTruncated === true,
      sourceAddressMapSemantics: sourceAddressMap.mappings.length
        ? attributes.decompiler === 'unwasm' && attributes.sourceLanguage === 'WebAssembly'
          ? 'One-based lines in this Rust translation map to byte offsets in the original Wasm module. The linked listing contains bounded raw byte ranges; this mapping is provenance evidence, not proof of semantic equivalence.'
          : `One-based source lines from ${text(attributes.sourceAddressMapProvider, 80) || (unit.source === 'reamon-ghidra' ? 'Ghidra' : 'the provider')} map to associated instruction addresses; this is navigation evidence, not proof of semantic equivalence.`
        : null,
      rawEvidence: rawEvidence ? {
        artifactId: rawEvidenceArtifactId,
        sha256: text(attributes.rawEvidenceSha256, 64) || rawEvidence.sourceHash,
        sizeBytes: rawEvidence.sizeBytes,
        text: rawEvidence.text,
        truncated: rawEvidence.truncated,
      } : null,
      controlFlowGraph: text(attributes.controlFlowGraph, 4_000),
      controlFlowMetrics: text(attributes.controlFlowMetrics, 512),
      controlFlowMetricsSemantics: typeof attributes.controlFlowMetrics === 'string'
        ? 'Ghidra basic-block counts are structural evidence only. A truncated record contains lower bounds; equal counts do not establish function identity or behavioral equivalence.'
        : null,
      controlFlowFlattening: text(attributes.controlFlowFlattening, 64_000),
      controlFlowFlatteningSemantics: typeof attributes.controlFlowFlattening === 'string'
        ? 'Ghidra Deobfuscation Lab p-code recovery stored for this exact function observation. Transitions and confidence are provider evidence/navigation leads, not recovered source, function identity, or semantic equivalence; check truncation and verify against disassembly.'
        : null,
      cfgTruncated: attributes.cfgTruncated === true,
      bytecodeRowsTruncated: attributes.bytecodeRowsTruncated === true,
      locals: text(attributes.localsJson, 4000),
      referencedStrings: textList(attributes.referencedStrings, 50, 512),
      referencedStringsTruncated: attributes.referencedStringsTruncated === true,
      flossVersion: text(attributes.flossVersion, 32),
      flossRecoveredStrings: flossRecoveredStringsOf(attributes.flossRecoveredStrings),
      flossRecoveredStringsTruncated: attributes.flossRecoveredStringsTruncated === true,
      flossRecoveredStringsSemantics: attributes.flossVersion === '3.1.1'
        ? 'FLOSS stack, tight-loop, or decoded strings associated with this function address. This is static-analysis evidence, not proof of runtime behavior or intent.' : null,
      referencedStringsSemantics: unit.source === 'reamon-tocode-import'
        ? 'ToCode strings.json entries whose xrefs include this function address. This is address-linked provider evidence, not proof of behavior or intent.'
        : unit.source === 'reamon-ghidra' ? 'Strings referenced by this function according to Ghidra data references; this is provider evidence, not proof of behavior or intent.' : null,
      importedCalls: textList(attributes.importedCalls, 32, 256),
      importedCallsSemantics: unit.source === 'reamon-tocode-import'
        ? 'External symbols listed in this function row’s callees_imports field in ToCode functions.json; names remain provider-attributed.' : null,
      fieldReferences: textList(attributes.fieldReferences, 32, 512),
      fieldReferencesTruncated: attributes.fieldReferencesTruncated === true,
      fieldReferencesSemantics: unit.source === 'reamon-tocode-import'
        ? 'Field identities listed by this function row’s field_refs in ToCode functions.json. ToCode does not report read/write direction for these entries.' : null,
      classReferences: textList(attributes.classReferences, 100, 512),
    },
    analysis: task ? {
      taskId: task.id,
      title: task.title,
      status: task.status,
      providerId: task.provider?.pluginId || null,
      completedAt: task.completedAt?.toISOString() || null,
      warnings: text(result.warnings, 2000),
    } : null,
    decompiledSource: code && !isRecurseLift ? {
      scope: parentUnit ? 'containing_code_unit' : 'code_unit',
      relativePath: text(attributes.relativePath, 1000),
      text: code.text,
      sizeBytes: code.sizeBytes,
      sourceHash: code.sourceHash,
      truncated: code.truncated,
    } : null,
    alternateDecompilerOutputs: reipaPseudocode ? [reipaPseudocode] : [],
    disassembly: disassembly ? { relativePath: text(attributes.assemblyRelativePath ?? attributes.disassemblyRelativePath, 1000), language: text(attributes.disassemblyLanguage, 80), text: disassembly.text, sizeBytes: disassembly.sizeBytes, truncated: disassembly.truncated } : null,
    bytecode: bytecode ? { text: bytecode.text, sizeBytes: bytecode.sizeBytes, truncated: bytecode.truncated || attributes.bytecodeRowsTruncated === true } : null,
    callRelationships: edges.slice(0, MAX_RELATIONSHIPS).map((edge) => ({
      stableKey: edge.stableKey,
      direction: edge.fromKey === unit.stableKey || record(edge.attributes).fromCodeUnitKey === unit.stableKey
        ? 'outgoing'
        : 'incoming',
      from: edge.fromKey ? endpointNames.get(edge.fromKey) || edge.fromKey : null,
      to: edge.toKey ? endpointNames.get(edge.toKey) || edge.toKey : null,
      label: text(edge.label, 500),
      evidence: {
        source: text(record(edge.attributes).source, 120),
        importSymbol: text(record(edge.attributes).importSymbol, 256),
        importer: text(record(edge.attributes).importer, 1000),
        target: text(record(edge.attributes).target, 1000),
        resolution: text(record(edge.attributes).resolution, 128),
        exportPath: text(record(edge.attributes).exportPath, 1000),
      },
    })),
    relationshipsTruncated: edges.length > MAX_RELATIONSHIPS,
    relationshipAvailability: edges.length
      ? 'recorded_relationships'
      : 'none_recorded_for_this_unit_in_this_analysis_task',
    memberReferences: referenceEdges.slice(0, MAX_RELATIONSHIPS).map((edge) => {
      const evidence = record(edge.attributes)
      return {
        stableKey: edge.stableKey,
        type: edge.type,
        from: edge.fromKey ? endpointNames.get(edge.fromKey) || edge.fromKey : null,
        to: edge.toKey ? endpointNames.get(edge.toKey) || edge.toKey : null,
        label: text(edge.label, 500),
        evidence: {
          referenceKind: text(evidence.referenceKind, 80),
          accessDirection: text(evidence.accessDirection, 80),
          referenceSemantics: text(evidence.referenceSemantics, 500),
          targetName: text(evidence.targetName, 500),
          targetSignature: text(evidence.targetSignature, 1000),
          occurrenceCount: typeof evidence.occurrenceCount === 'number' ? evidence.occurrenceCount : null,
          referenceOffsets: text(evidence.referenceOffsets, 2000),
        },
      }
    }),
    memberReferencesTruncated: referenceEdges.length > MAX_RELATIONSHIPS,
    memberReferenceAvailability: referenceEdges.length
      ? 'recorded_references'
      : 'none_recorded_for_this_unit_in_this_analysis_task',
    controlFlowGraphAvailability: typeof attributes.controlFlowGraph === 'string'
      ? 'persisted'
      : 'not_persisted',
    controlFlowMetricsAvailability: typeof attributes.controlFlowMetrics === 'string'
      ? 'persisted_structural_counts_only'
      : 'not_persisted',
    instructionSequenceAvailability: typeof attributes.instructionMnemonics === 'string'
      ? 'persisted'
      : typeof attributes.instructionCount === 'number'
        ? 'count_only'
        : 'not_persisted',
    maintainedSource: maintained ? {
      ...boundedSource(maintained.sourceCode),
      scope: parentUnit ? 'containing_code_unit' : 'code_unit',
      sourceHash: maintained.sourceHash,
      acceptedReviewId: maintained.acceptedReviewId,
      reviewed: Boolean(reviewReceipt),
      reviewReceipt: reviewReceipt ? {
        decision: reviewReceipt.decision,
        rationale: text(reviewReceipt.rationale, 1000),
        validationStatus: reviewReceipt.validationStatus,
        validationMethod: reviewReceipt.validationMethod,
        validationMessage: text(reviewReceipt.validationMessage, 1000),
        createdAt: reviewReceipt.createdAt.toISOString(),
      } : null,
      language: maintained.language,
      updatedAt: maintained.updatedAt.toISOString(),
    } : null,
    savedDraft: draft ? {
      ...boundedSource(draft.sourceCode),
      scope: parentUnit ? 'containing_code_unit' : 'code_unit',
      sourceHash: draft.sourceHash,
      draftHash: draft.draftHash,
      providerName: draft.providerName,
      modelIdentifier: draft.modelIdentifier,
      syntaxValidated: draft.syntaxValidated,
      validationStatus: draft.validationStatus,
      validationMethod: draft.validationMethod,
      validationMessage: text(draft.validationMessage, 1000),
      updatedAt: draft.updatedAt.toISOString(),
    } : null,
    evidenceBasis: 'Stored REAmon observation, provider result, and derived source files. Names and types remain provider evidence; no new explanation or symbol inference was generated by this tool.',
  }
}

export async function searchWorkspaceGoTypes(ctx: McpContext, args: WorkspaceSearchGoTypesArgs) {
  const selection = await prepareRead(ctx, args.projectId)
  if (!args.codeUnitId || args.codeUnitId.length > 64) throw new McpToolError('Invalid code unit id.', 'invalid_input')
  const search = args.search?.trim() || ''
  if (search.length > 200) throw new McpToolError('Go type search is limited to 200 characters.', 'invalid_input')
  const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 50)))
  const offset = Math.max(0, Math.min(100_000, Math.floor(args.offset ?? 0)))
  const unit = await prisma.reamonObservation.findFirst({
    where: {
      id: args.codeUnitId,
      projectId: args.projectId,
      type: { in: CODE_UNIT_TYPES },
      artifact: { is: selection.artifactWhere },
    },
    select: {
      id: true, label: true, source: true, taskId: true, artifactId: true, attributes: true,
      artifact: { select: { sha256: true } },
    },
  })
  if (!unit) throw new McpToolError('Code unit not found in the active workspace import.', 'not_found')
  if (unit.source !== 'reamon-ghidra' || !unit.taskId || !unit.artifactId) {
    return { available: false, reason: 'No Go binary type catalog is associated with this code unit.', types: [], totalMatches: 0 }
  }
  const metadataRow = await prisma.reamonObservation.findFirst({
    where: {
      projectId: args.projectId,
      taskId: unit.taskId,
      artifactId: unit.artifactId,
      source: unit.source,
      type: 'language_metadata',
      attributes: { path: ['language'], equals: 'Go' },
    },
    select: { attributes: true },
  })
  if (!metadataRow) {
    return { available: false, reason: 'No Go binary type catalog was recorded for this function’s exact analysis run.', types: [], totalMatches: 0 }
  }

  const metadata = record(metadataRow.attributes)
  const structured = parseStoredGoTypeDetails(metadata.typeDetails)
  const unstripStructured = parseStoredGoTypeDetails(metadata.unstripTypeDetails)
  const typeNames = boundedJsonTextList(metadata.types, 4_000, 1000, 500)
  const catalog = [...structured.items, ...unstripStructured.items]
  const detailsByName = new Set(catalog.map((item) => item.name))
  for (const name of typeNames.items) {
    if (!detailsByName.has(name)) catalog.push({ name, kind: 'unknown', reconstructed: '' })
  }
  const normalizedSearch = search.toLocaleLowerCase()
  const matches = catalog.filter((item) => !normalizedSearch
    || `${item.name} ${item.kind} ${item.reconstructed}`.toLocaleLowerCase().includes(normalizedSearch))
  const page = matches.slice(offset, offset + limit)
  const types: GoTypeDetail[] = []
  let responseBytes = 0
  for (const item of page) {
    const bounded = { ...item, reconstructed: item.reconstructed.slice(0, 1024) }
    const itemBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8') + 1
    if (responseBytes + itemBytes > 12_000) break
    types.push(bounded)
    responseBytes += itemBytes
  }
  const catalogTruncated = structured.truncated || unstripStructured.truncated || typeNames.truncated
    || metadata.typeDetailsTruncated === true || metadata.unstripTypeDetailsTruncated === true
  return {
    available: true,
    codeUnit: {
      id: unit.id,
      name: text(record(unit.attributes).qualifiedName) || text(record(unit.attributes).name) || text(unit.label) || unit.id,
      address: text(record(unit.attributes).address, 128),
      packageName: text(record(unit.attributes).goPackage, 500),
    },
    analysis: { taskId: unit.taskId, provider: unit.source, artifactId: unit.artifactId, artifactSha256: unit.artifact?.sha256 || null },
    search: search || null,
    types,
    totalMatches: matches.length,
    limit,
    offset,
    hasMore: offset + types.length < matches.length,
    catalogTruncated,
    semantics: 'These GoReSym and unstrip type records come from the selected function’s exact analysis run but are artifact-wide, not assigned to it. Each record carries its provider. Match each type against the selected source or signature before relying on it. Names and kinds are provider evidence, not reviewed canonical symbols.',
  }
}

export async function searchWorkspaceProviderTypes(ctx: McpContext, args: WorkspaceSearchGoTypesArgs) {
  const selection = await prepareRead(ctx, args.projectId)
  if (!args.codeUnitId || args.codeUnitId.length > 64) throw new McpToolError('Invalid code unit id.', 'invalid_input')
  const search = args.search?.trim() || ''
  if (search.length > 200) throw new McpToolError('Type search is limited to 200 characters.', 'invalid_input')
  const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 50)))
  const offset = Math.max(0, Math.min(100_000, Math.floor(args.offset ?? 0)))
  const unit = await prisma.reamonObservation.findFirst({
    where: {
      id: args.codeUnitId,
      projectId: args.projectId,
      type: { in: CODE_UNIT_TYPES },
      artifact: { is: selection.artifactWhere },
    },
    select: { id: true, label: true, source: true, taskId: true, artifactId: true, attributes: true, artifact: { select: { sha256: true } } },
  })
  if (!unit) throw new McpToolError('Code unit not found in the active workspace import.', 'not_found')
  if ((unit.source !== 'reamon-ghidra' && unit.source !== 'reamon-tocode-import') || !unit.taskId || !unit.artifactId) {
    return { available: false, reason: 'No searchable provider type catalog is associated with this code unit.', types: [], totalMatches: 0 }
  }
  const attributes = record(unit.attributes)
  const metadataRow = await prisma.reamonObservation.findFirst({
    where: {
      projectId: args.projectId,
      taskId: unit.taskId,
      artifactId: unit.artifactId,
      source: unit.source,
      type: 'language_metadata',
      AND: [
        { attributes: { path: ['language'], equals: unit.source === 'reamon-ghidra' ? 'Go' : 'ToCode' } },
        ...(unit.source === 'reamon-tocode-import' ? [{ attributes: { path: ['exportPath'], equals: text(attributes.exportPath, 1000) || '.' } }] : []),
      ],
    },
    select: { attributes: true },
  })
  if (!metadataRow) {
    return { available: false, reason: 'No provider type catalog was stored for this function’s exact analysis run and export.', types: [], totalMatches: 0 }
  }
  const metadata = record(metadataRow.attributes)
  const parsed = parseStoredGoTypeDetails(metadata.typeDetails)
  const normalizedSearch = search.toLocaleLowerCase()
  const matches = parsed.items.filter((item) => !normalizedSearch
    || `${item.name} ${item.kind} ${item.reconstructed}`.toLocaleLowerCase().includes(normalizedSearch))
  const page = matches.slice(offset, offset + limit)
  const types: GoTypeDetail[] = []
  let responseBytes = 0
  for (const item of page) {
    const bounded = { ...item, reconstructed: item.reconstructed.slice(0, 1024) }
    const itemBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8') + 1
    if (responseBytes + itemBytes > 12_000) break
    types.push(bounded)
    responseBytes += itemBytes
  }
  return {
    available: true,
    codeUnit: {
      id: unit.id,
      name: text(attributes.qualifiedName) || text(attributes.name) || text(unit.label) || unit.id,
      address: text(attributes.address, 128),
      exportPath: text(attributes.exportPath, 1000),
    },
    analysis: {
      taskId: unit.taskId,
      provider: unit.source,
      artifactId: unit.artifactId,
      artifactSha256: unit.artifact?.sha256 || null,
      typeSourceArtifactId: text(metadata.typeSourceArtifactId, 128),
      typeSourceArtifactSha256: text(metadata.typeSourceArtifactSha256, 64),
      typeSourceArtifactPath: text(metadata.typeSourceArtifactPath, 1000),
    },
    search: search || null,
    types,
    totalMatches: matches.length,
    limit,
    offset,
    hasMore: offset + types.length < matches.length,
    catalogTruncated: parsed.truncated || metadata.typeDetailsTruncated === true,
    semantics: 'These provider types come from the selected code unit’s exact analysis run; the catalog is export-wide, not assigned to that function. Match each name against its source or signature before relying on it.',
  }
}
