import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), observations: vi.fn(), root: vi.fn(), resolvePath: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: { reamonObservation: { findMany: h.observations } } }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccess: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/reamon/derived-storage', () => ({ derivedArtifactRoot: h.root, resolveDerivedArtifactPath: h.resolvePath }))

import { GET } from './route'

const routeParams = { params: Promise.resolve({ id: 'project-1' }) }
let testRoot = ''

beforeEach(async () => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.access.mockResolvedValue({ projectId: 'project-1' })
  h.selection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  h.observations.mockImplementation(async (args: { where: { type?: string } }) => args.where.type === 'maintained_source'
    ? [{ stableKey: 'unit-1', artifactId: 'artifact-1', attributes: {}, updatedAt: new Date('2026-10-04T00:00:00.000Z') }]
    : [{ id: 'unit-1', artifactId: 'artifact-1', label: 'com.example.Main', attributes: {
      qualifiedName: 'com.example.Main', language: 'Java',
      codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/com/example/Main.java',
    } }])
  testRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-maintained-export-'))
  h.root.mockReturnValue(testRoot)
  h.resolvePath.mockImplementation((relativePath: string) => path.join(testRoot, relativePath))
  const maintainedRelativePath = `project-1/maintained/${createHash('sha256').update('unit-1').digest('hex')}-Main.java`
  const maintainedFilePath = path.join(testRoot, maintainedRelativePath)
  await mkdir(path.dirname(maintainedFilePath), { recursive: true })
  await writeFile(maintainedFilePath, 'package com.example;\npublic class Main { }\n')
})

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
})

describe('GET /api/projects/[id]/visualizer/maintained/export', () => {
  it('exports saved source files with a provenance manifest', async () => {
    const response = await GET(new Request('http://localhost'), routeParams)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Content-Disposition')).toContain('reamon-maintained-source-project-1.zip')
    const zip = await JSZip.loadAsync(await response.arrayBuffer())
    const source = await zip.file('sources/task-1/run-1/sources/com/example/Main.java')?.async('string')
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      exportedFiles: number; skippedFiles: number; files: Array<Record<string, unknown>>
    }

    expect(source).toContain('public class Main')
    expect(await zip.file('README.txt')?.async('string')).toContain('Only saved maintained copies are included')
    expect(manifest).toMatchObject({ exportedFiles: 1, skippedFiles: 0 })
    expect(manifest.files[0]).toMatchObject({
      unitId: 'unit-1', name: 'com.example.Main', language: 'Java',
      archivePath: 'sources/task-1/run-1/sources/com/example/Main.java', status: 'exported',
    })
    expect(h.observations).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ source: 'reamon-maintained-source', artifact: { is: { projectId: 'project-1', importId: { in: ['active-import'] } } } }),
    }))
  })

  it('does not export maintained source for an inaccessible project', async () => {
    const { NextResponse } = await import('next/server')
    h.access.mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))

    const response = await GET(new Request('http://localhost'), routeParams)

    expect(response.status).toBe(403)
    expect(h.observations).not.toHaveBeenCalled()
  })

  it('records and skips a maintained unit whose original path escapes the active artifact', async () => {
    h.observations.mockImplementation(async (args: { where: { type?: string } }) => args.where.type === 'maintained_source'
      ? [{ stableKey: 'unit-1', artifactId: 'artifact-1', attributes: {}, updatedAt: new Date('2026-10-04T00:00:00.000Z') }]
      : [{ id: 'unit-1', artifactId: 'artifact-1', label: 'com.example.Main', attributes: {
        qualifiedName: 'com.example.Main', language: 'Java', codeArtifactId: 'project-1/artifact-1/../../outside/Main.java',
      } }])

    const response = await GET(new Request('http://localhost'), routeParams)
    const zip = await JSZip.loadAsync(await response.arrayBuffer())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      exportedFiles: number; skippedFiles: number; files: Array<Record<string, unknown>>
    }

    expect(response.status).toBe(200)
    expect(Object.keys(zip.files).some((name) => name.endsWith('/outside/Main.java'))).toBe(false)
    expect(manifest).toMatchObject({ exportedFiles: 0, skippedFiles: 1 })
    expect(manifest.files[0]).toMatchObject({ unitId: 'unit-1', status: 'skipped' })
  })
})
