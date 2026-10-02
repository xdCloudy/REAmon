/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  getWorkspaceArtifact: vi.fn(),
  getBuiltinProvider: vi.fn(),
  resolveCapabilities: vi.fn(),
  ensureProviderRegistered: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  taskFindUnique: vi.fn(),
  taskCreate: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@/lib/reamon/inventory-query', () => ({ getWorkspaceArtifact: mocks.getWorkspaceArtifact }))
vi.mock('@/lib/reamon/provider-registry', () => ({
  getBuiltinProvider: mocks.getBuiltinProvider,
  ensureProviderRegistered: mocks.ensureProviderRegistered,
}))
vi.mock('@/lib/reamon/capabilities', () => ({ resolveCapabilities: mocks.resolveCapabilities }))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/prisma', () => ({
  default: {
    task: { findUnique: mocks.taskFindUnique },
    $transaction: mocks.transaction,
  },
}))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }
const plugin = {
  manifest: {
    id: 'reamon-source-inspector',
    name: 'REAmon Source Inspector',
    category: 'static_analysis',
    integration: 'native',
    acceptsTargetTypes: ['FILE'],
    acceptsFormats: ['source'],
    capabilities: ['extract_strings'],
    produces: ['String'],
    requirements: [],
  },
  analyze: vi.fn(),
}
const artifact = {
  id: 'artifact-1',
  relativePath: 'src/main.c',
  targetId: 'target-1',
  profile: { targetType: 'FILE', format: 'source' },
}
const provider = { id: 'provider-row-1', pluginId: plugin.manifest.id, name: plugin.manifest.name, enabled: true }

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'REAmon Source Inspector: extract_strings · src/main.c',
    category: 'static_analysis',
    status: 'QUEUED',
    progress: 0,
    providerId: provider.id,
    capability: 'extract_strings',
    artifactId: artifact.id,
    createdAt: new Date('2026-10-02T12:00:00Z'),
    updatedAt: new Date('2026-10-02T12:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.getWorkspaceArtifact.mockResolvedValue(artifact)
  mocks.getBuiltinProvider.mockReturnValue(plugin)
  mocks.resolveCapabilities.mockReturnValue([{
    pluginId: plugin.manifest.id,
    pluginName: plugin.manifest.name,
    category: plugin.manifest.category,
    integration: plugin.manifest.integration,
    acceptsTargetTypes: plugin.manifest.acceptsTargetTypes,
    acceptsFormats: plugin.manifest.acceptsFormats,
    capabilities: plugin.manifest.capabilities,
    produces: plugin.manifest.produces,
    requirements: plugin.manifest.requirements,
  }])
  mocks.ensureProviderRegistered.mockResolvedValue(provider)
  mocks.taskFindUnique.mockResolvedValue(null)
  mocks.taskCreate.mockResolvedValue(task())
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    task: { create: mocks.taskCreate },
    workspaceActivity: { create: mocks.activityCreate },
  }))
})

describe('POST /api/projects/[id]/workspace/analysis-plan/schedule', () => {
  test('stops at the project access boundary', async () => {
    mocks.requireProjectAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ artifactId: 'artifact-1', providerId: plugin.manifest.id, capability: 'extract_strings' }),
    }), params)

    expect(response.status).toBe(404)
    expect(mocks.getWorkspaceArtifact).not.toHaveBeenCalled()
  })

  test('authenticates, verifies compatibility, persists the provider, and queues a task', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ artifactId: 'artifact-1', providerId: plugin.manifest.id, capability: 'EXTRACT_STRINGS' }),
      headers: { 'Content-Type': 'application/json' },
    }), params)

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ scheduled: true, reused: false, task: { status: 'QUEUED', capability: 'extract_strings' } })
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith({ userId: 'user-1' }, 'project-1')
    expect(mocks.getWorkspaceArtifact).toHaveBeenCalledWith('project-1', 'artifact-1')
    expect(mocks.ensureProviderRegistered).toHaveBeenCalledWith(plugin.manifest)
    expect(mocks.taskCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-1', artifactId: 'artifact-1', targetId: 'target-1',
        providerId: 'provider-row-1', capability: 'extract_strings', status: 'QUEUED',
        idempotencyKey: 'analysis:project-1:artifact-1:reamon-source-inspector:extract_strings',
      }),
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'analysis.task.queued', data: expect.objectContaining({ taskId: 'task-1' }) }),
    }))
  })

  test('reuses the idempotent task without creating a duplicate', async () => {
    mocks.taskFindUnique.mockResolvedValue(task({ id: 'existing-task' }))

    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ artifactId: 'artifact-1', providerId: plugin.manifest.id, capability: 'extract_strings' }),
    }), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ scheduled: false, reused: true, task: { id: 'existing-task' } })
    expect(mocks.taskCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  test('rejects a provider that cannot perform the requested capability', async () => {
    mocks.resolveCapabilities.mockReturnValue([])

    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ artifactId: 'artifact-1', providerId: plugin.manifest.id, capability: 'disassemble' }),
    }), params)

    expect(response.status).toBe(409)
    expect(mocks.ensureProviderRegistered).not.toHaveBeenCalled()
    expect(mocks.taskCreate).not.toHaveBeenCalled()
  })

  test('does not schedule historical or inaccessible artifacts', async () => {
    mocks.getWorkspaceArtifact.mockResolvedValue(null)

    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ artifactId: 'old-artifact', providerId: plugin.manifest.id, capability: 'extract_strings' }),
    }), params)

    expect(response.status).toBe(404)
    expect(mocks.taskCreate).not.toHaveBeenCalled()
  })

  test('rejects malformed schedule requests before reading inventory', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ artifactId: 'artifact-1', providerId: plugin.manifest.id }),
    }), params)

    expect(response.status).toBe(400)
    expect(mocks.getWorkspaceArtifact).not.toHaveBeenCalled()
  })
})
