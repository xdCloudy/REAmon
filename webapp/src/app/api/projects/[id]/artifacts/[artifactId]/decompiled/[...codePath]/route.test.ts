import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  observationFindMany: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: { artifact: { findFirst: mocks.artifactFindFirst }, reamonObservation: { findMany: mocks.observationFindMany } } }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: mocks.getActiveWorkspaceImportSelection }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: mocks.requireEffectiveUser, requireProjectAccess: mocks.requireProjectAccess }))

import { GET } from './route'

const relativePath = 'project-1/artifact-1/task-1/run-1/sources/app/Main.java'
const context = { params: Promise.resolve({ id: 'project-1', artifactId: 'artifact-1', codePath: relativePath.split('/') }) }
let derivedRoot = ''

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(derivedRoot, { recursive: true, force: true })
})

beforeEach(async () => {
  vi.clearAllMocks()
  derivedRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-derived-code-'))
  vi.stubEnv('REAMON_DERIVED_PATH', derivedRoot)
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.getActiveWorkspaceImportSelection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  mocks.artifactFindFirst.mockResolvedValue({ id: 'artifact-1' })
  mocks.observationFindMany.mockResolvedValue([{ attributes: { codeArtifactId: relativePath } }])
  const file = path.join(derivedRoot, relativePath)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, 'package app;\nclass Main {}\n')
})

describe('GET decompiled code artifact', () => {
  test('requires project authentication before reading source', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))
    const response = await GET(new Request('http://localhost'), context)
    expect(response.status).toBe(401)
    expect(mocks.artifactFindFirst).not.toHaveBeenCalled()
  })

  test('serves a source file only when its active artifact has a matching code-unit observation', async () => {
    const response = await GET(new Request('http://localhost'), context)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toContain('class Main')
    expect(mocks.artifactFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ id: 'artifact-1', projectId: 'project-1' }, { projectId: 'project-1', importId: { in: ['active-import'] } }] } }))
  })

  test('does not serve unlinked source paths', async () => {
    mocks.observationFindMany.mockResolvedValue([])
    const response = await GET(new Request('http://localhost'), context)
    expect(response.status).toBe(404)
  })
})
