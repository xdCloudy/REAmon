import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { activeWorkspaceImportIds, type WorkspaceImportState } from './imports'

export type WorkspaceFileKind = 'executables' | 'source'

export interface WorkspaceFileQuery {
  search?: string
  format?: string
  kind?: WorkspaceFileKind
  limit?: number
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
  hasMore: boolean
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
  return { artifacts: rows.slice(0, limit), total, limit, hasMore }
}
