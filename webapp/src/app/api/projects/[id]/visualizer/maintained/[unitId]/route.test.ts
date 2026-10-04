import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), observation: vi.fn(), upsert: vi.fn(), artifact: vi.fn(), root: vi.fn(), resolvePath: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  reamonObservation: { findFirst: h.observation, upsert: h.upsert },
  artifact: { findFirst: h.artifact },
} }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccess: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/reamon/derived-storage', () => ({ derivedArtifactRoot: h.root, resolveDerivedArtifactPath: h.resolvePath }))

import { GET, PUT } from './route'

const routeParams = { params: Promise.resolve({ id: 'project-1', unitId: 'unit-1' }) }
let testRoot = ''

beforeEach(async () => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.access.mockResolvedValue({ projectId: 'project-1' })
  h.selection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  h.observation.mockResolvedValue({
    id: 'unit-1', artifactId: 'artifact-1', label: 'app.Main',
    attributes: { language: 'Java', codeArtifactId: 'project-1/artifact-1/run/source/Main.java' },
  })
  h.upsert.mockResolvedValue({})
  h.artifact.mockResolvedValue({ id: 'artifact-1' })
  testRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-maintained-'))
  h.root.mockReturnValue(testRoot)
  h.resolvePath.mockImplementation((relativePath: string) => path.join(testRoot, relativePath))
})

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
})

describe('/api/projects/[id]/visualizer/maintained/[unitId]', () => {
  it('saves an independent maintained copy and serves it for editing and download', async () => {
    const save = await PUT(new Request('http://localhost', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCode: 'class Main { String name; }' }),
    }), routeParams)
    expect(save.status).toBe(200)
    expect(await save.json()).toMatchObject({ saved: true, fileName: expect.stringMatching(/\.java$/) })
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId_source_stableKey: { projectId: 'project-1', source: 'reamon-maintained-source', stableKey: 'unit-1' } },
      create: expect.objectContaining({ type: 'maintained_source', artifactId: 'artifact-1' }),
    }))

    const view = await GET(new Request('http://localhost'), routeParams)
    expect(await view.json()).toMatchObject({ exists: true, sourceCode: 'class Main { String name; }' })
    const download = await GET(new Request('http://localhost?download=1'), routeParams)
    expect(await download.text()).toBe('class Main { String name; }')
    expect(download.headers.get('Content-Disposition')).toMatch(/attachment; filename=/)
  })

  it('does not save source units linked outside the active artifact', async () => {
    h.observation.mockResolvedValueOnce({
      id: 'unit-1', artifactId: 'artifact-1', attributes: { codeArtifactId: 'project-1/another-artifact/secret.java' },
    })
    const response = await PUT(new Request('http://localhost', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCode: 'private data' }),
    }), routeParams)
    expect(response.status).toBe(404)
    expect(h.resolvePath).not.toHaveBeenCalled()
  })
})
