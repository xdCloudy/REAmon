import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({ user: vi.fn(), strictAccess: vi.fn(), taskFindFirst: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { task: { findFirst: h.taskFindFirst } } }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccessStrict: h.strictAccess }))

import { POST } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'foreign-user' })
  h.strictAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
})

describe('POST /api/projects/[id]/visualizer/apk/rebuild ownership', () => {
  it('denies foreign users before inspecting an APK analysis task', async () => {
    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/apk/rebuild', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'private-task' }),
    }), { params: Promise.resolve({ id: 'project-1' }) })

    expect(response.status).toBe(404)
    expect(h.taskFindFirst).not.toHaveBeenCalled()
  })
})
