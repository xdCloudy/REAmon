/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ internal: vi.fn(), project: vi.fn(), reconcile: vi.fn(), close: vi.fn(), activityCreate: vi.fn(), projectionRunUpsert: vi.fn(), projectionRunUpdate: vi.fn(), queryRaw: vi.fn(), executeRaw: vi.fn() }))
vi.mock('@/lib/session', () => ({ isInternalRequest: mocks.internal }))
vi.mock('@/lib/prisma', () => ({ default: { workspaceActivity: { create: mocks.activityCreate }, reamonProjectionRun: { upsert: mocks.projectionRunUpsert, update: mocks.projectionRunUpdate }, $queryRaw: mocks.queryRaw, $executeRaw: mocks.executeRaw } }))
vi.mock('@/lib/reamon/observation-projector', () => ({
  MAX_PROJECTED_OBSERVATIONS: 10000,
  projectReamonObservations: mocks.project,
  reconcileProjectedGraph: mocks.reconcile,
}))
vi.mock('@/app/api/graph/neo4j', () => ({ getGraphSession: () => ({ close: mocks.close }) }))

import { POST } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.internal.mockReturnValue(true)
  mocks.project.mockResolvedValue({ projectId: 'project-1', selected: 2, nodes: 2, relationships: 0, truncated: false })
  mocks.reconcile.mockResolvedValue({ deletedNodes: 1, deletedRelationships: 2 })
  mocks.close.mockResolvedValue(undefined)
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.projectionRunUpsert.mockResolvedValue({ projectionRunId: 'run-1' })
  mocks.projectionRunUpdate.mockResolvedValue({ projectionRunId: 'run-1' })
  mocks.queryRaw.mockResolvedValue([{ project_id: 'project-1' }])
  mocks.executeRaw.mockResolvedValue(1)
})

describe('POST /api/internal/reamon/graph/project', () => {
  test('requires internal authentication', async () => {
    mocks.internal.mockReturnValue(false)
    const response = await POST(new Request('http://localhost', { method: 'POST' }) as never)
    expect(response.status).toBe(401)
    expect(mocks.project).not.toHaveBeenCalled()
  })

  test('projects one bounded project and always closes the graph session', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project-1', limit: 100, batchSize: 25 }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ projectId: 'project-1', selected: 2, reconciled: true, deletedNodes: 1, deletedRelationships: 2, projectionRunId: expect.any(String) })
    expect(mocks.project).toHaveBeenCalledWith('project-1', expect.anything(), 100, 25, undefined, expect.any(String))
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.activityCreate).toHaveBeenCalledTimes(2)
    expect(mocks.activityCreate.mock.calls[0][0]).toMatchObject({ data: { projectId: 'project-1', eventType: 'analysis.graph_projection.started' } })
    expect(mocks.activityCreate.mock.calls[1][0]).toMatchObject({ data: { projectId: 'project-1', eventType: 'analysis.graph_projection.completed' } })
    expect(mocks.projectionRunUpsert).toHaveBeenCalledWith({ where: { projectionRunId: expect.any(String) }, create: expect.objectContaining({ projectId: 'project-1', offset: 0 }), update: {} })
    expect(mocks.projectionRunUpdate).toHaveBeenCalledWith({ where: { projectionRunId: expect.any(String) }, data: expect.objectContaining({ status: 'COMPLETED', selected: 2 }) })
  })

  test('passes a bounded backfill offset to the projector', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project-1', limit: 100, offset: 1000 }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.project).toHaveBeenCalledWith('project-1', expect.anything(), 100, undefined, 1000, expect.any(String))
  })

  test('keeps the project lease across a truncated page', async () => {
    mocks.project.mockResolvedValueOnce({ projectId: 'project-1', selected: 2, nodes: 2, relationships: 0, truncated: true, nextOffset: 2 })

    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project-1', limit: 2 }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ truncated: true, reconciled: false, nextOffset: 2 })
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.executeRaw).not.toHaveBeenCalled()
  })

  test('continues a paginated run with the caller-provided provenance id', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project-1', projectionRunId: 'run-1', offset: 1000 }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ projectionRunId: 'run-1' })
    expect(mocks.projectionRunUpsert).toHaveBeenCalledWith({ where: { projectionRunId: 'run-1' }, create: expect.objectContaining({ projectId: 'project-1', offset: 1000 }), update: {} })
  })

  test('records a durable failure when graph projection cannot complete', async () => {
    mocks.project.mockRejectedValueOnce(new Error('Neo4j unavailable'))

    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project-1' }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(500)
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.projectionRunUpdate).toHaveBeenCalledWith({ where: { projectionRunId: expect.any(String) }, data: expect.objectContaining({ status: 'FAILED', error: 'Neo4j unavailable' }) })
    expect(mocks.activityCreate).toHaveBeenCalledTimes(2)
    expect(mocks.activityCreate.mock.calls[1][0]).toMatchObject({ data: { projectId: 'project-1', eventType: 'analysis.graph_projection.failed' } })
  })

  test('rejects an overlapping projection while the project lease is held', async () => {
    mocks.queryRaw.mockResolvedValueOnce([])

    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project-1' }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('already running') })
    expect(mocks.project).not.toHaveBeenCalled()
    expect(mocks.projectionRunUpsert).not.toHaveBeenCalled()
  })

  test('rejects an unbounded or missing project', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ limit: 100 }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)
    expect(response.status).toBe(400)
    expect(mocks.project).not.toHaveBeenCalled()
  })
})
