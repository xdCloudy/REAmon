/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  taskFindFirst: vi.fn(),
  observationFindFirst: vi.fn(),
  observationFindMany: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  task: { findFirst: mocks.taskFindFirst },
  reamonObservation: { findFirst: mocks.observationFindFirst, findMany: mocks.observationFindMany },
} }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: mocks.getActiveWorkspaceImportSelection }))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { GET } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }
const artifactWhere = { projectId: 'project-1', importId: { in: ['active-import'] } }
const focusRow = {
  id: 'unit-main', stableKey: 'ghidra:function:main', label: 'main', source: 'reamon-ghidra', artifactId: 'artifact-1', type: 'code_unit',
  updatedAt: new Date('2026-10-04T00:01:00.000Z'),
  attributes: { unitType: 'function', name: 'main', qualifiedName: 'main', address: '0x1000', sizeBytes: 80, language: 'C', codeArtifactId: 'sources/main.c' },
  artifact: { relativePath: 'bin/program', originalName: 'program' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.getActiveWorkspaceImportSelection.mockResolvedValue({ artifactWhere })
  mocks.taskFindFirst.mockResolvedValue({ id: 'run-1', artifactId: 'artifact-1', provider: { pluginId: 'reamon-ghidra' } })
  mocks.observationFindFirst.mockResolvedValue(focusRow)
  mocks.observationFindMany.mockResolvedValue([])
})

describe('GET /api/projects/[id]/visualizer/callgraph', () => {
  test('requires project access before reading a call graph', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/callgraph?taskId=run-1&unitId=unit-main'), params)

    expect(response.status).toBe(401)
    expect(mocks.taskFindFirst).not.toHaveBeenCalled()
    expect(mocks.observationFindFirst).not.toHaveBeenCalled()
  })

  test('returns direct callers and callees linked to code units in the selected Ghidra run', async () => {
    const callee = {
      ...focusRow,
      id: 'unit-helper',
      stableKey: 'ghidra:function:helper',
      label: 'helper',
      attributes: { ...focusRow.attributes, name: 'helper', qualifiedName: 'helper', address: '0x1080', codeArtifactId: 'sources/helper.c' },
    }
    mocks.observationFindMany
      .mockResolvedValueOnce([{ id: 'edge-1', stableKey: 'edge-main-helper', label: 'main calls helper', fromKey: focusRow.stableKey, toKey: callee.stableKey }])
      .mockResolvedValueOnce([focusRow, callee])

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/callgraph?taskId=run-1&unitId=unit-main'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      focusKey: focusRow.stableKey,
      truncated: false,
      nodes: [
        { key: focusRow.stableKey, label: 'main', isFocus: true, codeUnit: { id: 'unit-main', name: 'main' } },
        { key: callee.stableKey, label: 'helper', address: '0x1080', isFocus: false, codeUnit: { id: 'unit-helper', name: 'helper' } },
      ],
      edges: [{ id: 'edge-1', fromKey: focusRow.stableKey, toKey: callee.stableKey, label: 'main calls helper' }],
    })
    expect(mocks.taskFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'run-1', projectId: 'project-1', status: 'COMPLETED', artifact: { is: artifactWhere } }),
    }))
    expect(mocks.observationFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ taskId: 'run-1', artifactId: 'artifact-1', OR: [{ fromKey: focusRow.stableKey }, { toKey: focusRow.stableKey }] }),
      take: 401,
    }))
  })

  test('returns the bounded call graph for a completed Ghidra run without a focus function', async () => {
    const callee = {
      ...focusRow,
      id: 'unit-helper',
      stableKey: 'ghidra:function:helper',
      label: 'helper',
      attributes: { ...focusRow.attributes, name: 'helper', qualifiedName: 'helper', address: '0x1080', codeArtifactId: 'sources/helper.c' },
    }
    mocks.observationFindMany
      .mockResolvedValueOnce([{ id: 'edge-1', stableKey: 'edge-main-helper', label: 'main calls helper', fromKey: focusRow.stableKey, toKey: callee.stableKey }])
      .mockResolvedValueOnce([focusRow, callee])

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/callgraph?taskId=run-1&view=graph'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      focusKey: null,
      truncated: false,
      nodes: [{ key: focusRow.stableKey, isFocus: false }, { key: callee.stableKey, isFocus: false }],
      edges: [{ id: 'edge-1', fromKey: focusRow.stableKey, toKey: callee.stableKey }],
    })
    expect(mocks.observationFindFirst).not.toHaveBeenCalled()
    expect(mocks.observationFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.not.objectContaining({ OR: expect.anything() }),
      take: 401,
    }))
  })

  test('builds a bounded class-dependency graph from saved JADX references', async () => {
    const main = {
      ...focusRow,
      id: 'unit-main', stableKey: 'jadx:class:main', source: 'reamon-jadx', label: 'app.Main',
      attributes: { unitType: 'class', name: 'app.Main', qualifiedName: 'app.Main', sizeBytes: 240, language: 'Java', codeArtifactId: 'sources/app/Main.java', classReferences: '["app.Helper"]' },
    }
    const helper = {
      ...focusRow,
      id: 'unit-helper', stableKey: 'jadx:class:helper', source: 'reamon-jadx', label: 'app.Helper',
      attributes: { unitType: 'class', name: 'app.Helper', qualifiedName: 'app.Helper', sizeBytes: 180, language: 'Java', codeArtifactId: 'sources/app/Helper.java', classReferences: '[]' },
    }
    mocks.taskFindFirst.mockResolvedValue({ id: 'run-1', artifactId: 'artifact-1', provider: { pluginId: 'reamon-jadx' } })
    mocks.observationFindMany.mockResolvedValue([main, helper])

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/callgraph?taskId=run-1&view=graph'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      graphType: 'class_dependencies', focusKey: null, truncated: false,
      nodes: [
        { key: 'jadx:class:main', label: 'app.Main', codeUnit: { id: 'unit-main' } },
        { key: 'jadx:class:helper', label: 'app.Helper', codeUnit: { id: 'unit-helper' } },
      ],
      edges: [{ fromKey: 'jadx:class:main', toKey: 'jadx:class:helper', label: 'depends on' }],
    })
  })

  test('limits a focused JADX dependency graph to direct neighbors', async () => {
    const main = {
      ...focusRow,
      id: 'unit-main', stableKey: 'jadx:class:main', source: 'reamon-jadx', label: 'app.Main',
      attributes: { unitType: 'class', name: 'app.Main', qualifiedName: 'app.Main', sizeBytes: 240, language: 'Java', codeArtifactId: 'sources/app/Main.java', classReferences: '["app.Helper"]' },
    }
    const helper = {
      ...focusRow,
      id: 'unit-helper', stableKey: 'jadx:class:helper', source: 'reamon-jadx', label: 'app.Helper',
      attributes: { unitType: 'class', name: 'app.Helper', qualifiedName: 'app.Helper', sizeBytes: 180, language: 'Java', codeArtifactId: 'sources/app/Helper.java', classReferences: '[]' },
    }
    mocks.taskFindFirst.mockResolvedValue({ id: 'run-1', artifactId: 'artifact-1', provider: { pluginId: 'reamon-jadx' } })
    mocks.observationFindMany.mockResolvedValue([main, helper])

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/callgraph?taskId=run-1&unitId=unit-helper'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      graphType: 'class_dependencies', focusKey: 'jadx:class:helper', truncated: false,
      nodes: [
        { key: 'jadx:class:main', isFocus: false },
        { key: 'jadx:class:helper', isFocus: true },
      ],
      edges: [{ fromKey: 'jadx:class:main', toKey: 'jadx:class:helper' }],
    })
    expect(mocks.observationFindFirst).not.toHaveBeenCalled()
  })

  test('rejects missing, non Ghidra, and out-of-run functions', async () => {
    const missing = await GET(new Request('http://localhost/api/projects/project-1/visualizer/callgraph?taskId=run-1'), params)
    expect(missing.status).toBe(400)

    mocks.taskFindFirst.mockResolvedValue(null)
    const wrongRun = await GET(new Request('http://localhost/api/projects/project-1/visualizer/callgraph?taskId=other-run&unitId=unit-main'), params)
    expect(wrongRun.status).toBe(404)
    expect(mocks.observationFindFirst).not.toHaveBeenCalled()

    mocks.taskFindFirst.mockResolvedValue({ id: 'run-1', artifactId: 'artifact-1' })
    mocks.observationFindFirst.mockResolvedValue(null)
    const wrongUnit = await GET(new Request('http://localhost/api/projects/project-1/visualizer/callgraph?taskId=run-1&unitId=other-unit'), params)
    expect(wrongUnit.status).toBe(404)
    expect(mocks.observationFindMany).not.toHaveBeenCalled()
  })
})
