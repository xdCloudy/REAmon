/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { signTag } from '@/lib/redamonCtx'

const mocks = vi.hoisted(() => ({
  internal: vi.fn(),
  projectFindFirst: vi.fn(),
  listEvidence: vi.fn(),
  readEvidence: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ isInternalRequest: mocks.internal }))
vi.mock('@/lib/prisma', () => ({ default: { project: { findFirst: mocks.projectFindFirst } } }))
vi.mock('@/lib/reamon/workspace-evidence', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reamon/workspace-evidence')>('@/lib/reamon/workspace-evidence')
  return { ...actual, listPersistedWorkspaceEvidence: mocks.listEvidence, readPersistedWorkspaceEvidence: mocks.readEvidence }
})

import { POST } from './route'

const token = (tool = 'workspace_list_evidence', patch: Record<string, unknown> = {}) => signTag({
  source: 'agent', project_id: 'project-1', user_id: 'owner-1', tool, exp: Math.floor(Date.now() / 1000) + 120, ...patch,
}, 'internal-key')
const request = (body: unknown, tag = token()) => new Request('http://localhost', {
  method: 'POST', headers: { 'x-redamon-ctx': tag, 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INTERNAL_API_KEY = 'internal-key'
  mocks.internal.mockReturnValue(true)
  mocks.projectFindFirst.mockResolvedValue({ id: 'project-1' })
  mocks.listEvidence.mockResolvedValue({ projectId: 'project-1', evidence: [], total: 0 })
  mocks.readEvidence.mockResolvedValue({ projectId: 'project-1', evidenceHash: 'a'.repeat(64) })
})

describe('POST /api/internal/reamon/workspace/evidence', () => {
  test('requires internal transport authentication and signed agent context', async () => {
    mocks.internal.mockReturnValue(false)
    expect((await POST(request({ tool: 'workspace_list_evidence' }) as never)).status).toBe(401)
    mocks.internal.mockReturnValue(true)
    expect((await POST(request({ tool: 'workspace_list_evidence' }, 'bad') as never)).status).toBe(401)
    expect(mocks.projectFindFirst).not.toHaveBeenCalled()
  })

  test('derives project scope from verified context and forwards bounded index arguments', async () => {
    const response = await POST(request({ tool: 'workspace_list_evidence', artifactId: 'artifact-1', limit: 2 }) as never)
    expect(response.status).toBe(200)
    expect(mocks.projectFindFirst).toHaveBeenCalledWith({ where: { id: 'project-1', userId: 'owner-1' }, select: { id: true } })
    expect(mocks.listEvidence).toHaveBeenCalledWith({ projectId: 'project-1', artifactId: 'artifact-1', limit: 2 })
  })

  test('rejects mismatched tool arguments and refuses projects the signed user does not own', async () => {
    expect((await POST(request({ tool: 'workspace_get_evidence', evidenceId: 'e1' }) as never)).status).toBe(403)
    mocks.projectFindFirst.mockResolvedValue(null)
    expect((await POST(request({ tool: 'workspace_list_evidence' }) as never)).status).toBe(404)
    expect(mocks.listEvidence).not.toHaveBeenCalled()
  })

  test('rejects malformed or oversized bodies before querying project evidence', async () => {
    const malformed = await POST(new Request('http://localhost', { method: 'POST', headers: { 'x-redamon-ctx': token() }, body: '{' }) as never)
    const oversized = await POST(new Request('http://localhost', { method: 'POST', headers: { 'x-redamon-ctx': token() }, body: JSON.stringify({ tool: 'workspace_list_evidence', cursor: 'x'.repeat(5000) }) }) as never)
    expect(malformed.status).toBe(400)
    expect(oversized.status).toBe(413)
    expect(mocks.projectFindFirst).not.toHaveBeenCalled()
  })

  test('uses project scope from the signed context for hash-paged details', async () => {
    const response = await POST(request({ tool: 'workspace_get_evidence', evidenceId: 'evidence-1', offsetBytes: 128, evidenceHash: 'b'.repeat(64) }, token('workspace_get_evidence')) as never)
    expect(response.status).toBe(200)
    expect(mocks.readEvidence).toHaveBeenCalledWith({ projectId: 'project-1', evidenceId: 'evidence-1', offsetBytes: 128, evidenceHash: 'b'.repeat(64) })
  })
})
