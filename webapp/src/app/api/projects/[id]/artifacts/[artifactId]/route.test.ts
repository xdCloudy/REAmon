/** @vitest-environment node */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: { artifact: { findFirst: mocks.artifactFindFirst } } }))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { GET } from './route'

let storageRoot = ''

function params() {
  return { params: Promise.resolve({ id: 'project-1', artifactId: 'artifact-1' }) }
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    storagePath: 'project-1/import-1/artifact-1/content',
    originalName: 'payload.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: 7,
    ...overrides,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-artifact-download-'))
  vi.stubEnv('REAMON_ARTIFACTS_PATH', storageRoot)
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.artifactFindFirst.mockResolvedValue(artifact())
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
})

describe('GET /api/projects/[id]/artifacts/[artifactId]', () => {
  test('returns the authenticated artifact bytes with safe download metadata', async () => {
    const storagePath = artifact().storagePath as string
    await mkdir(path.join(storageRoot, path.dirname(storagePath)), { recursive: true })
    await writeFile(path.join(storageRoot, storagePath), 'payload')

    const response = await GET(new Request('http://localhost/download'), params())

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('payload')
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(response.headers.get('Content-Length')).toBe('7')
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="payload.bin"')
  })

  test('returns 404 when the project-scoped artifact does not exist', async () => {
    mocks.artifactFindFirst.mockResolvedValue(null)

    const response = await GET(new Request('http://localhost/download'), params())

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Artifact not found' })
  })

  test('returns 503 when the database row points to missing bytes', async () => {
    const response = await GET(new Request('http://localhost/download'), params())

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Artifact is temporarily unavailable' })
  })

  test('returns 500 when the stored path is outside the artifact volume', async () => {
    mocks.artifactFindFirst.mockResolvedValue(artifact({ storagePath: '../secrets.txt' }))

    const response = await GET(new Request('http://localhost/download'), params())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Artifact storage path is invalid' })
  })
})
