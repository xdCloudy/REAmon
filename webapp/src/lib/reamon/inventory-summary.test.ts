/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  importFindMany: vi.fn(),
  targetFindMany: vi.fn(),
  artifactFindMany: vi.fn(),
  taskFindMany: vi.fn(),
  findingFindMany: vi.fn(),
  hypothesisFindMany: vi.fn(),
  evidenceCount: vi.fn(),
  selection: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    project: { findUnique: mocks.projectFindUnique },
    workspaceImport: { findMany: mocks.importFindMany },
    target: { findMany: mocks.targetFindMany },
    artifact: { findMany: mocks.artifactFindMany },
    task: { findMany: mocks.taskFindMany },
    finding: { findMany: mocks.findingFindMany },
    hypothesis: { findMany: mocks.hypothesisFindMany },
    evidence: { count: mocks.evidenceCount },
  },
}))
vi.mock('./inventory-query', () => ({ getActiveWorkspaceImportSelection: mocks.selection }))

import { getWorkspaceInventorySummary } from './inventory-summary'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.projectFindUnique.mockResolvedValue({
    id: 'project-1', name: 'ExampleApp', description: 'A workspace', projectKind: 'REVERSE_ENGINEERING',
    updatedAt: new Date('2026-10-02T12:00:00Z'),
  })
  mocks.selection.mockResolvedValue({
    states: [{ id: 'import-1', rootName: 'ExampleApp', status: 'COMPLETED', rootTargetId: 'root-1' }],
    activeImportIds: new Set(['import-1']),
    activeRootTargetIds: new Set(['root-1']),
    artifactWhere: { projectId: 'project-1', importId: 'import-1' },
  })
  mocks.importFindMany.mockResolvedValue([{
    id: 'import-1', rootTargetId: 'root-1', sourceType: 'BROWSER_DIRECTORY', rootName: 'ExampleApp',
    status: 'COMPLETED', totalFiles: 3, completedFiles: 3, failedFiles: 0, totalBytes: BigInt(30), uploadedBytes: BigInt(30),
    rootTarget: { profile: { targetType: 'DIRECTORY', directoryCount: 2 } },
  }])
  mocks.targetFindMany.mockResolvedValue([
    { id: 'root-1', name: 'ExampleApp', targetType: 'DIRECTORY', parentTargetId: null, status: 'IDENTIFIED', profile: {} },
    { id: 'target-1', name: 'app.exe', targetType: 'FILE', parentTargetId: 'root-1', status: 'CLASSIFIED', profile: {} },
    { id: 'stale-target', name: 'old.exe', targetType: 'FILE', parentTargetId: null, status: 'VERIFIED', profile: {} },
  ])
  mocks.artifactFindMany.mockResolvedValue([
    { id: 'artifact-1', targetId: 'target-1', sizeBytes: 10, status: 'CLASSIFIED', profile: { targetType: 'FILE', format: 'pe', platform: 'windows', architecture: 'x86-64', runtimes: ['native'] } },
    { id: 'artifact-2', targetId: null, sizeBytes: 20, status: 'IDENTIFIED', profile: { targetType: 'FILE', format: 'source', platform: null, architecture: null, runtimes: ['python'] } },
  ])
  mocks.taskFindMany.mockResolvedValue([{ status: 'COMPLETED' }])
  mocks.findingFindMany.mockResolvedValue([{ status: 'OPEN' }])
  mocks.hypothesisFindMany.mockResolvedValue([])
  mocks.evidenceCount.mockResolvedValue(2)
})

describe('workspace inventory summary', () => {
  test('aggregates active files, profiles, capabilities, targets, and deterministic progress', async () => {
    const result = await getWorkspaceInventorySummary('project-1')

    expect(result).toMatchObject({
      projectId: 'project-1',
      workspace: { name: 'ExampleApp', projectKind: 'REVERSE_ENGINEERING' },
      rootCount: 1,
      counts: { files: 2, directories: 2, totalBytes: 30, targets: 3, tasks: 1, findings: 1, hypotheses: 0, evidence: 2 },
      profiles: {
        formats: [{ value: 'pe', count: 1 }, { value: 'source', count: 1 }],
        platforms: [{ value: 'windows', count: 1 }],
        runtimes: [{ value: 'native', count: 1 }, { value: 'python', count: 1 }],
      },
      logicalTargets: [{ id: 'root-1' }, { id: 'target-1' }, { id: 'stale-target' }],
      logicalTargetsTruncated: false,
      progress: { overallPercent: expect.any(Number), metrics: expect.any(Array) },
    })
    expect(result?.logicalTargets.map((target) => target.id)).toContain('stale-target')
    expect(result?.capabilities.find((provider) => provider.pluginId === 'reamon-artifact-profiler')).toMatchObject({
      compatibleArtifactCount: 2,
    })
    expect(mocks.artifactFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 'project-1', importId: 'import-1' } }))
  })

  test('returns null for a missing project without querying its inventory', async () => {
    mocks.projectFindUnique.mockResolvedValue(null)
    expect(await getWorkspaceInventorySummary('missing')).toBeNull()
    expect(mocks.artifactFindMany).not.toHaveBeenCalled()
  })
})
