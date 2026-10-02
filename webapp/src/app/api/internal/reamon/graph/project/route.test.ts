/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ internal: vi.fn(), project: vi.fn(), close: vi.fn(), activityCreate: vi.fn() }))
vi.mock('@/lib/session', () => ({ isInternalRequest: mocks.internal }))
vi.mock('@/lib/prisma', () => ({ default: { workspaceActivity: { create: mocks.activityCreate } } }))
vi.mock('@/lib/reamon/observation-projector', () => ({
  MAX_PROJECTED_OBSERVATIONS: 10000,
  projectReamonObservations: mocks.project,
}))
vi.mock('@/app/api/graph/neo4j', () => ({ getGraphSession: () => ({ close: mocks.close }) }))

import { POST } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.internal.mockReturnValue(true)
  mocks.project.mockResolvedValue({ projectId: 'project-1', selected: 2, nodes: 2, relationships: 0, truncated: false })
  mocks.close.mockResolvedValue(undefined)
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
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
    expect(await response.json()).toMatchObject({ projectId: 'project-1', selected: 2 })
    expect(mocks.project).toHaveBeenCalledWith('project-1', expect.anything(), 100, 25)
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.activityCreate).toHaveBeenCalledTimes(2)
    expect(mocks.activityCreate.mock.calls[0][0]).toMatchObject({ data: { projectId: 'project-1', eventType: 'analysis.graph_projection.started' } })
    expect(mocks.activityCreate.mock.calls[1][0]).toMatchObject({ data: { projectId: 'project-1', eventType: 'analysis.graph_projection.completed' } })
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
    expect(mocks.activityCreate).toHaveBeenCalledTimes(2)
    expect(mocks.activityCreate.mock.calls[1][0]).toMatchObject({ data: { projectId: 'project-1', eventType: 'analysis.graph_projection.failed' } })
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
