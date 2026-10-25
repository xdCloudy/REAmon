/**
 * Unit tests for access.ts authorization guards (BOLA remediation).
 *
 * Run: npx vitest run src/lib/access.test.ts
 *
 * @vitest-environment node
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mockGetEffectiveUser = vi.fn()
vi.mock('./session', () => ({
  getEffectiveUser: () => mockGetEffectiveUser(),
}))

const mockProjectFindUnique = vi.fn()
const mockConversationFindUnique = vi.fn()
vi.mock('@/lib/prisma', () => ({
  default: {
    project: { findUnique: (a: unknown) => mockProjectFindUnique(a) },
    conversation: { findUnique: (a: unknown) => mockConversationFindUnique(a) },
  },
}))

import {
  requireEffectiveUser,
  assertOwner,
  assertOwnerStrict,
  ownerScope,
  requireProjectAccess,
  requireConversationAccess,
  accessEnforced,
  guardProject,
  requireProjectAccessStrict,
  guardProjectStrict,
} from './access'

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.ACCESS_ENFORCE // default = enforce
})

describe('requireEffectiveUser', () => {
  test('401 when no effective user', async () => {
    mockGetEffectiveUser.mockResolvedValue(null)
    const r = await requireEffectiveUser()
    expect(r).toBeInstanceOf(NextResponse)
    expect((r as NextResponse).status).toBe(401)
  })
  test('returns the effective user', async () => {
    mockGetEffectiveUser.mockResolvedValue({ userId: 'u1' })
    const r = await requireEffectiveUser()
    expect(r).toEqual({ userId: 'u1' })
  })
})

describe('assertOwnerStrict (always enforces)', () => {
  test('owner -> null', () => {
    expect(assertOwnerStrict({ userId: 'u1' }, 'u1')).toBeNull()
  })
  test('non-owner -> 403 even when ACCESS_ENFORCE is off', () => {
    delete process.env.ACCESS_ENFORCE
    const r = assertOwnerStrict({ userId: 'u1' }, 'u2')
    expect((r as NextResponse).status).toBe(403)
  })
})

describe('assertOwner (log-only aware, anti-enum 404)', () => {
  test('owner -> null', () => {
    expect(assertOwner({ userId: 'u1' }, 'u1')).toBeNull()
  })
  test('non-owner, enforce OFF (opt-out) -> null (log-only allow)', () => {
    process.env.ACCESS_ENFORCE = '0'
    expect(assertOwner({ userId: 'u1' }, 'u2')).toBeNull()
  })
  test('non-owner, default (enforce) -> 404 (anti-enum)', () => {
    delete process.env.ACCESS_ENFORCE
    const r = assertOwner({ userId: 'u1' }, 'u2')
    expect((r as NextResponse).status).toBe(404)
  })
})

describe('accessEnforced', () => {
  test('ON by default (fail closed)', () => {
    delete process.env.ACCESS_ENFORCE
    expect(accessEnforced()).toBe(true)
  })
  test('only an explicit "0"/"false" opts out', () => {
    process.env.ACCESS_ENFORCE = '0'
    expect(accessEnforced()).toBe(false)
    process.env.ACCESS_ENFORCE = 'false'
    expect(accessEnforced()).toBe(false)
    process.env.ACCESS_ENFORCE = '1'
    expect(accessEnforced()).toBe(true)
  })
})

describe('ownerScope', () => {
  test('scopes to the effective user id', () => {
    expect(ownerScope({ userId: 'u9' })).toEqual({ userId: 'u9' })
  })
})

describe('requireProjectAccess', () => {
  test('missing project -> 404', async () => {
    mockProjectFindUnique.mockResolvedValue(null)
    const r = await requireProjectAccess({ userId: 'u1' }, 'p1')
    expect((r as NextResponse).status).toBe(404)
  })
  test('owner -> returns project', async () => {
    mockProjectFindUnique.mockResolvedValue({ id: 'p1', userId: 'u1' })
    const r = await requireProjectAccess({ userId: 'u1' }, 'p1')
    expect(r).toEqual({ project: { id: 'p1', userId: 'u1' } })
  })
  test('non-owner, default enforce -> 404 (anti-enum cross-user block)', async () => {
    delete process.env.ACCESS_ENFORCE
    mockProjectFindUnique.mockResolvedValue({ id: 'p1', userId: 'victim' })
    const r = await requireProjectAccess({ userId: 'attacker' }, 'p1')
    expect((r as NextResponse).status).toBe(404)
  })
  test('non-owner, enforce OFF (opt-out) -> returns project (log-only)', async () => {
    process.env.ACCESS_ENFORCE = '0'
    mockProjectFindUnique.mockResolvedValue({ id: 'p1', userId: 'victim' })
    const r = await requireProjectAccess({ userId: 'attacker' }, 'p1')
    expect(r).toEqual({ project: { id: 'p1', userId: 'victim' } })
  })
  test('empty projectId -> 400', async () => {
    const r = await requireProjectAccess({ userId: 'u1' }, '')
    expect((r as NextResponse).status).toBe(400)
  })
})

describe('guardProjectStrict', () => {
  test('requires an effective user', async () => {
    mockGetEffectiveUser.mockResolvedValue(null)
    const r = await guardProjectStrict('p1')
    expect((r as NextResponse).status).toBe(401)
    expect(mockProjectFindUnique).not.toHaveBeenCalled()
  })
  test('blocks a different owner even when ACCESS_ENFORCE is disabled', async () => {
    process.env.ACCESS_ENFORCE = 'false'
    mockGetEffectiveUser.mockResolvedValue({ userId: 'attacker' })
    mockProjectFindUnique.mockResolvedValue({ id: 'p1', userId: 'victim' })
    const r = await guardProjectStrict('p1')
    expect((r as NextResponse).status).toBe(404)
  })
  test('allows the project owner', async () => {
    mockGetEffectiveUser.mockResolvedValue({ userId: 'u1' })
    mockProjectFindUnique.mockResolvedValue({ id: 'p1', userId: 'u1' })
    expect(await guardProjectStrict('p1')).toBeNull()
  })
})

describe('requireProjectAccessStrict', () => {
  test('owner -> returns project', async () => {
    mockProjectFindUnique.mockResolvedValue({ id: 'p1', userId: 'u1' })
    expect(await requireProjectAccessStrict({ userId: 'u1' }, 'p1')).toEqual({
      project: { id: 'p1', userId: 'u1' },
    })
  })
  test('non-owner -> 404 even when ACCESS_ENFORCE is off', async () => {
    process.env.ACCESS_ENFORCE = '0'
    mockProjectFindUnique.mockResolvedValue({ id: 'p1', userId: 'victim' })
    const r = await requireProjectAccessStrict({ userId: 'attacker' }, 'p1')
    expect((r as NextResponse).status).toBe(404)
  })
  test('missing project -> 404', async () => {
    mockProjectFindUnique.mockResolvedValue(null)
    const r = await requireProjectAccessStrict({ userId: 'u1' }, 'p1')
    expect((r as NextResponse).status).toBe(404)
  })
})

describe('guardProject (one-call scan/analytics guard)', () => {
  test('no session -> 401', async () => {
    mockGetEffectiveUser.mockResolvedValue(null)
    const r = await guardProject('p1')
    expect((r as NextResponse).status).toBe(401)
  })
  test('owner -> null (allow)', async () => {
    mockGetEffectiveUser.mockResolvedValue({ userId: 'u1' })
    mockProjectFindUnique.mockResolvedValue({ id: 'p1', userId: 'u1' })
    expect(await guardProject('p1')).toBeNull()
  })
  test('non-owner, enforce -> 404', async () => {
    delete process.env.ACCESS_ENFORCE
    mockGetEffectiveUser.mockResolvedValue({ userId: 'attacker' })
    mockProjectFindUnique.mockResolvedValue({ id: 'p1', userId: 'victim' })
    const r = await guardProject('p1')
    expect((r as NextResponse).status).toBe(404)
  })
})

describe('requireConversationAccess', () => {
  test('missing -> 404', async () => {
    mockConversationFindUnique.mockResolvedValue(null)
    const r = await requireConversationAccess({ userId: 'u1' }, 'c1')
    expect((r as NextResponse).status).toBe(404)
  })
  test('owner -> returns conversation', async () => {
    mockConversationFindUnique.mockResolvedValue({ id: 'c1', userId: 'u1', projectId: 'p1' })
    const r = await requireConversationAccess({ userId: 'u1' }, 'c1')
    expect(r).toEqual({ conversation: { id: 'c1', userId: 'u1', projectId: 'p1' } })
  })
  test('non-owner, default enforce -> 404 (anti-enum)', async () => {
    delete process.env.ACCESS_ENFORCE
    mockConversationFindUnique.mockResolvedValue({ id: 'c1', userId: 'victim', projectId: 'p1' })
    const r = await requireConversationAccess({ userId: 'attacker' }, 'c1')
    expect((r as NextResponse).status).toBe(404)
  })
})
