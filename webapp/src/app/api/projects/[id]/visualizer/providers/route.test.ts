import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({ user: vi.fn(), strictAccess: vi.fn(), findMany: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { userLlmProvider: { findMany: h.findMany } } }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccessStrict: h.strictAccess }))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.strictAccess.mockResolvedValue({ projectId: 'project-1' })
  h.findMany.mockResolvedValue([{ id: 'provider-1', name: 'Local model', modelIdentifier: 'Qwen' }])
})

describe('GET /api/projects/[id]/visualizer/providers', () => {
  it('denies a foreign project before reading caller provider records', async () => {
    h.strictAccess.mockResolvedValueOnce(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await GET(new NextRequest('http://localhost/api/projects/project-1/visualizer/providers'), {
      params: Promise.resolve({ id: 'project-1' }),
    })

    expect(response.status).toBe(404)
    expect(h.findMany).not.toHaveBeenCalled()
  })

  it('returns only caller-owned provider labels and model names', async () => {
    const response = await GET(new NextRequest('http://localhost/api/projects/project-1/visualizer/providers'), {
      params: Promise.resolve({ id: 'project-1' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ providers: [{ id: 'provider-1', name: 'Local model', modelIdentifier: 'Qwen' }] })
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', providerType: 'openai_compatible' },
      select: { id: true, name: true, modelIdentifier: true },
    }))
  })
})
