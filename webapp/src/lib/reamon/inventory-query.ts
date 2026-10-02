import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { resolveCapabilities } from './capabilities'
import { activeWorkspaceImportIds, type WorkspaceImportState } from './imports'
import type { CapabilityMatch, TargetProfile } from './types'

export type WorkspaceFileKind = 'executables' | 'source'

export interface WorkspaceFileQuery {
  search?: string
  format?: string
  kind?: WorkspaceFileKind
  limit?: number
  offset?: number
}

export interface WorkspaceFileRecord {
  id: string
  name: string
  relativePath: string
  parentPath: string
  targetId: string | null
  importId: string | null
  sizeBytes: number
  sha256: string
  extension: string
  status: string
  profile: unknown
}

export interface WorkspaceFileQueryResult {
  artifacts: WorkspaceFileRecord[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface WorkspaceArtifactDetails extends WorkspaceFileRecord {
  originalName: string
  mimeType: string
  capabilities: CapabilityMatch[]
  target: {
    id: string
    name: string
    targetType: string
    parentTargetId: string | null
    status: string
    profile: unknown
  } | null
  workspaceImport: {
    id: string
    rootName: string
    sourceType: string
    status: string
  } | null
  tasks: Array<{ id: string; title: string; category: string; status: string; progress: number; createdAt: string; updatedAt: string }>
  findings: Array<{ id: string; title: string; severity: string; status: string; createdAt: string; updatedAt: string }>
  hypotheses: Array<{ id: string; statement: string; status: string; createdAt: string; updatedAt: string }>
  evidence: Array<{ id: string; kind: string; summary: string; source: string; createdAt: string }>
}

export interface ActiveWorkspaceImportSelection {
  states: WorkspaceImportState[]
  activeImportIds: Set<string>
  activeRootTargetIds: Set<string>
  artifactWhere: Prisma.ArtifactWhereInput
}

const EXECUTABLE_EXTENSIONS = ['app', 'apk', 'bin', 'dylib', 'dll', 'elf', 'exe', 'jar', 'so', 'sys', 'wasm']
const SOURCE_EXTENSIONS = ['asm', 'c', 'cc', 'cpp', 'cs', 'go', 'h', 'hpp', 'java', 'js', 'jsx', 'kt', 'py', 'rs', 'swift', 'ts', 'tsx']

export async function getActiveWorkspaceImportSelection(projectId: string): Promise<ActiveWorkspaceImportSelection> {
  const states = await prisma.workspaceImport.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, rootName: true, status: true, rootTargetId: true, createdAt: true },
  })
  const activeImportIds = activeWorkspaceImportIds(states)
  const activeRootTargetIds = new Set(states
    .filter((workspaceImport) => activeImportIds.has(workspaceImport.id) && workspaceImport.rootTargetId)
    .map((workspaceImport) => workspaceImport.rootTargetId as string))
  const artifactWhere: Prisma.ArtifactWhereInput = activeImportIds.size
    ? { projectId, OR: [{ importId: null }, { importId: { in: [...activeImportIds] } }] }
    : { projectId, importId: null }
  return { states, activeImportIds, activeRootTargetIds, artifactWhere }
}

export async function listWorkspaceFiles(projectId: string, query: WorkspaceFileQuery = {}): Promise<WorkspaceFileQueryResult> {
  const selection = await getActiveWorkspaceImportSelection(projectId)
  const limit = Math.max(1, Math.min(query.limit || 100, 500))
  const offset = Math.max(0, Math.min(Math.floor(query.offset || 0), 100000))
  const search = query.search?.trim().slice(0, 200)
  const format = query.format?.trim().toLowerCase().slice(0, 64)
  const conditions: Prisma.ArtifactWhereInput[] = []
  if (search) {
    conditions.push({
      OR: [
        { relativePath: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ],
    })
  }
  if (format) conditions.push({ profile: { path: ['format'], equals: format } })
  if (query.kind === 'executables') conditions.push({ extension: { in: EXECUTABLE_EXTENSIONS } })
  if (query.kind === 'source') conditions.push({ extension: { in: SOURCE_EXTENSIONS } })

  const where: Prisma.ArtifactWhereInput = conditions.length
    ? { ...selection.artifactWhere, AND: conditions }
    : selection.artifactWhere
  const [rows, total] = await Promise.all([
    prisma.artifact.findMany({
      where,
      orderBy: [{ relativePath: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: limit + 1,
      select: {
        id: true,
        name: true,
        relativePath: true,
        parentPath: true,
        targetId: true,
        importId: true,
        sizeBytes: true,
        sha256: true,
        extension: true,
        status: true,
        profile: true,
      },
    }),
    prisma.artifact.count({ where }),
  ])
  const hasMore = rows.length > limit
  return { artifacts: rows.slice(0, limit), total, limit, offset, hasMore }
}

export async function getWorkspaceArtifact(projectId: string, artifactId: string): Promise<WorkspaceArtifactDetails | null> {
  const selection = await getActiveWorkspaceImportSelection(projectId)
  const artifact = await prisma.artifact.findFirst({
    where: { ...selection.artifactWhere, id: artifactId },
    select: {
      id: true,
      name: true,
      originalName: true,
      relativePath: true,
      parentPath: true,
      targetId: true,
      importId: true,
      sizeBytes: true,
      sha256: true,
      extension: true,
      mimeType: true,
      status: true,
      profile: true,
      createdAt: true,
      updatedAt: true,
      target: {
        select: { id: true, name: true, targetType: true, parentTargetId: true, status: true, profile: true },
      },
      workspaceImport: {
        select: { id: true, rootName: true, sourceType: true, status: true },
      },
      tasks: {
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, title: true, category: true, status: true, progress: true, createdAt: true, updatedAt: true },
      },
      findings: {
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, title: true, severity: true, status: true, createdAt: true, updatedAt: true },
      },
      hypotheses: {
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, statement: true, status: true, createdAt: true, updatedAt: true },
      },
      evidence: {
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, kind: true, summary: true, source: true, createdAt: true },
      },
    },
  })
  if (!artifact) return null

  const profile = artifact.profile as unknown as TargetProfile
  return {
    id: artifact.id,
    name: artifact.name,
    originalName: artifact.originalName,
    relativePath: artifact.relativePath || artifact.originalName,
    parentPath: artifact.parentPath,
    targetId: artifact.targetId,
    importId: artifact.importId,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    extension: artifact.extension,
    mimeType: artifact.mimeType,
    status: artifact.status,
    profile,
    capabilities: resolveCapabilities(profile),
    target: artifact.target,
    workspaceImport: artifact.workspaceImport,
    tasks: artifact.tasks.map((task) => ({ ...task, createdAt: task.createdAt.toISOString(), updatedAt: task.updatedAt.toISOString() })),
    findings: artifact.findings.map((finding) => ({ ...finding, createdAt: finding.createdAt.toISOString(), updatedAt: finding.updatedAt.toISOString() })),
    hypotheses: artifact.hypotheses.map((hypothesis) => ({ ...hypothesis, createdAt: hypothesis.createdAt.toISOString(), updatedAt: hypothesis.updatedAt.toISOString() })),
    evidence: artifact.evidence.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
  }
}
