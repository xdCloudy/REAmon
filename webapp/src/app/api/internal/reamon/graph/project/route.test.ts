/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ internal: vi.fn(), project: vi.fn(), close: vi.fn() }))
vi.mock('@/lib/session', () => ({ isInternalRequest: mocks.internal }))
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
