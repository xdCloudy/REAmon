/** Database-backed code-unit reads for agents working on REAmon workspaces. */
import { open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import prisma from '@/lib/prisma'
import { assertMcpProjectAccess, requireScope } from '@/lib/mcpAuth'
import { McpToolError } from '@/lib/mcp/errors'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { CODE_UNIT_OBSERVATION_TYPE } from '@/lib/reamon/code-units'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { enforceRate, type McpContext } from '@/lib/mcp/tools'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_CODE_BYTES = 128 * 1024
const MAX_HASH_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_RELATIONSHIPS = 100
const CODE_UNIT_TYPES = [CODE_UNIT_OBSERVATION_TYPE, 'function']
const REFERENCE_RELATIONSHIP_TYPES = ['reads_field', 'writes_field', 'references_string']

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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, max = 500): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function textList(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap((item) => {
    const normalized = text(item, maxLength)
    return normalized ? [normalized] : []
  }))].slice(0, limit)
}

function sourceAddressMappings(value: unknown): { mappings: Array<{ ghidraLineNumber: number; address: string }>; truncated: boolean } {
  if (typeof value !== 'string' || value.length > 1_000_000) return { mappings: [], truncated: false }
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return { mappings: [], truncated: false }
    const mappings = parsed.flatMap((item) => {
      const mapping = record(item)
      return Number.isInteger(mapping.ghidraLineNumber) && Number(mapping.ghidraLineNumber) > 0
        && Number(mapping.ghidraLineNumber) <= 1_000_000
        && typeof mapping.address === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(mapping.address)
        ? [{ ghidraLineNumber: Number(mapping.ghidraLineNumber), address: mapping.address }]
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
        ...['name', 'qualifiedName', 'address', 'language', 'sourceLanguage', 'relativePath', 'prototype'].map((key) => ({
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
        address: text(attributes.address ?? attributes.startAddress, 128),
        prototype: text(attributes.prototype, 1000),
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
  const classUnitEdgeFilters = unit.type === CODE_UNIT_OBSERVATION_TYPE ? [
    { attributes: { path: ['fromCodeUnitKey'], equals: unit.stableKey } },
    { attributes: { path: ['toCodeUnitKey'], equals: unit.stableKey } },
  ] : []
  const classReferenceFilters = unit.type === CODE_UNIT_OBSERVATION_TYPE
    ? [{ attributes: { path: ['fromCodeUnitKey'], equals: unit.stableKey } }]
    : []
  const [code, disassembly, bytecode, task, edges, referenceEdges, maintained] = await Promise.all([
    readDerivedText(codeArtifactId, args.projectId, unit.artifactId),
    readDerivedText(disassemblyArtifactId, args.projectId, unit.artifactId),
    readDerivedText(bytecodeArtifactId, args.projectId, unit.artifactId),
    unit.taskId ? prisma.task.findFirst({
      where: { id: unit.taskId, projectId: args.projectId, artifactId: unit.artifactId },
      select: { id: true, title: true, status: true, completedAt: true, provider: { select: { pluginId: true } }, result: true },
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
  ])
  const reviewReceipt = maintained?.acceptedReviewId && maintained.sourceHash ? await prisma.reamonCodeReview.findFirst({
    where: {
      id: maintained.acceptedReviewId,
      projectId: args.projectId,
      artifactId: unit.artifactId || '',
      codeUnitId: maintenanceCodeUnitId,
      maintainedSourceHash: maintained.sourceHash,
    },
    select: { decision: true, rationale: true, createdAt: true },
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
      prototype: text(attributes.prototype, 2000),
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
      artifact: unit.artifact ? { id: unit.artifactId, path: unit.artifact.relativePath || unit.artifact.originalName, sha256: unit.artifact.sha256 } : null,
      provider: unit.source,
      updatedAt: unit.updatedAt.toISOString(),
      recoveredTypeData: attributes.recoveredTypeData === true,
      parameters: text(attributes.parametersJson, 4000),
      instructionLanguage: text(attributes.instructionLanguage, 80),
      instructionCount: typeof attributes.instructionCount === 'number' ? attributes.instructionCount : null,
      instructionMnemonics: text(attributes.instructionMnemonics, 16_000),
      sourceAddressMap: sourceAddressMap.mappings,
      sourceAddressMapTruncated: sourceAddressMap.truncated || attributes.sourceAddressMapTruncated === true,
      sourceAddressMapSemantics: sourceAddressMap.mappings.length
        ? 'One-based Ghidra source line numbers are passed through unchanged; each mapped statement points to its associated p-code operation target address.'
        : null,
      controlFlowGraph: text(attributes.controlFlowGraph, 4_000),
      cfgTruncated: attributes.cfgTruncated === true,
      bytecodeRowsTruncated: attributes.bytecodeRowsTruncated === true,
      locals: text(attributes.localsJson, 4000),
      referencedStrings: textList(attributes.referencedStrings, 50, 512),
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
    decompiledSource: code ? {
      scope: parentUnit ? 'containing_code_unit' : 'code_unit',
      relativePath: text(attributes.relativePath, 1000),
      text: code.text,
      sizeBytes: code.sizeBytes,
      sourceHash: code.sourceHash,
      truncated: code.truncated,
    } : null,
    disassembly: disassembly ? { relativePath: text(attributes.assemblyRelativePath ?? attributes.disassemblyRelativePath, 1000), text: disassembly.text, sizeBytes: disassembly.sizeBytes, truncated: disassembly.truncated } : null,
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
