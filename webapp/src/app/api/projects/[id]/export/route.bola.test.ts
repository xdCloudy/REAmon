/**
 * BOLA exploit-repro — GET /api/projects/[id]/export.
 *
 * The export bundles the ENTIRE project (row + RoE binary, conversations, messages,
 * reports, Neo4j subgraph, presets). The rollout-aware guard allowed a foreign
 * logged-in user to download the whole project when ACCESS_ENFORCE=0. The route
 * now uses the strict project-owner guard before reading export data.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockProjectFindUnique = vi.fn()
const mockRequireEff = vi.fn()

vi.mock('@/lib/prisma', () => ({
  default: {
    project: { findUnique: (...a: unknown[]) => mockProjectFindUnique(...a) },
    conversation: { findMany: vi.fn().mockResolvedValue([]) },
    report: { findMany: vi.fn().mockResolvedValue([]) },
    userProjectPreset: { findMany: vi.fn().mockResolvedValue([]) },
  },
}))
vi.mock('@/app/api/graph/neo4j', () => ({ getGraphSession: () => ({ run: vi.fn().mockResolvedValue({ records: [] }), close: vi.fn() }) }))
vi.mock('@/lib/access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/access')>('@/lib/access')
  return { ...actual, requireEffectiveUser: () => mockRequireEff() }
})

import { GET } from './route'

const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.ACCESS_ENFORCE
  mockProjectFindUnique.mockResolvedValue({ id: 'victimProj', userId: 'victim', name: 'secret', targetDomain: 'v.tld' })
})

describe('GET /api/projects/[id]/export — BOLA', () => {
  test('EXPLOIT: cross-user export → 404 even when ownership rollout is disabled', async () => {
    process.env.ACCESS_ENFORCE = '0'
    mockRequireEff.mockResolvedValue({ userId: 'attacker' })
    const res = await GET(new NextRequest('http://x/api/projects/victimProj/export'), params('victimProj'))
    expect(res.status).toBe(404)
    expect(mockProjectFindUnique).toHaveBeenCalledTimes(1)
    expect(mockProjectFindUnique).toHaveBeenCalledWith({
      where: { id: 'victimProj' }, select: { id: true, userId: true },
    })
  })

  test('no session → 401, project access not checked', async () => {
    mockRequireEff.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await GET(new NextRequest('http://x/api/projects/victimProj/export'), params('victimProj'))
    expect(res.status).toBe(401)
    expect(mockProjectFindUnique).not.toHaveBeenCalled()
  })
})
