/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), task: vi.fn(), observations: vi.fn(), findBuildReceipt: vi.fn(), reviews: vi.fn(), drafts: vi.fn(), root: vi.fn(), resolvePath: vi.fn(), maintainedSources: vi.fn(), artifacts: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  task: { findFirst: h.task },
  artifact: { findMany: h.artifacts },
  reamonObservation: { findMany: h.observations, findFirst: h.findBuildReceipt },
  reamonMaintainedSource: { findMany: h.maintainedSources },
  reamonCodeReview: { findMany: h.reviews },
  reamonCodeDraft: { findMany: h.drafts },
} }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccess: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/reamon/derived-storage', () => ({ derivedArtifactRoot: h.root, resolveDerivedArtifactPath: h.resolvePath }))

import { GET } from './route'

const routeParams = { params: Promise.resolve({ id: 'project-1' }) }
const taskId = 'task-1'
let testRoot = ''

beforeEach(async () => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.access.mockResolvedValue({ projectId: 'project-1' })
  h.selection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  h.task.mockResolvedValue({ id: taskId, title: 'JADX decompile', artifactId: 'artifact-1', provider: { pluginId: 'reamon-jadx' }, artifact: { originalName: 'app.apk' } })
  h.observations.mockImplementation(async (args: { where: { type?: string } }) => args.where.type === 'maintained_source'
    ? [{ stableKey: 'unit-1', artifactId: 'artifact-1', updatedAt: new Date('2026-10-04T00:00:00.000Z') }]
    : [{ id: 'unit-1', stableKey: 'jadx:com.example.Main', artifactId: 'artifact-1', label: 'com.example.Main', attributes: {
      qualifiedName: 'com.example.Main', language: 'Java',
      codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/com/example/Main.java',
    } }])
  h.maintainedSources.mockResolvedValue([{
    codeUnitId: 'unit-1', artifactId: 'artifact-1', sourceCode: 'package com.example;\npublic class DatabaseMaintained { }\n',
    updatedAt: new Date('2026-10-04T00:00:00.000Z'),
  }])
  h.findBuildReceipt.mockResolvedValue(null)
  h.artifacts.mockResolvedValue([])
  h.reviews.mockResolvedValue([])
  h.drafts.mockResolvedValue([])
  testRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-source-bundle-'))
  h.root.mockReturnValue(testRoot)
  h.resolvePath.mockImplementation((relativePath: string) => path.join(testRoot, relativePath))

  const original = path.join(testRoot, 'project-1/artifact-1/task-1/run-1/sources/com/example/Main.java')
  const maintainedRelativePath = `project-1/maintained/${createHash('sha256').update('unit-1').digest('hex')}-Main.java`
  const maintained = path.join(testRoot, maintainedRelativePath)
  await mkdir(path.dirname(original), { recursive: true })
  await mkdir(path.dirname(maintained), { recursive: true })
  await writeFile(original, 'package com.example;\npublic class a { }\n')
  await writeFile(maintained, 'package com.example;\npublic class Main { }\n')
})

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
})

describe('GET /api/projects/[id]/visualizer/maintained/export', () => {
  it('exports the selected run decompilation and maintained copy with provenance', async () => {
    const response = await GET(new Request(`http://localhost?taskId=${taskId}`), routeParams)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Content-Disposition')).toContain(`reamon-source-bundle-${taskId}.zip`)
    const zip = await JSZip.loadAsync(await response.arrayBuffer())
    const decompiled = await zip.file('decompiled/sources/com/example/Main.java')?.async('string')
    const maintained = await zip.file('maintained/sources/com/example/Main.java')?.async('string')
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      codeUnitCount: number; decompiledFiles: number; maintainedFiles: number; skippedFiles: number; files: Array<Record<string, unknown>>
    }

    expect(decompiled).toContain('class a')
    expect(maintained).toContain('class DatabaseMaintained')
    expect(await zip.file('README.txt')?.async('string')).toContain('decompiled/ contains the analyzer output')
    expect(manifest).toMatchObject({ codeUnitCount: 1, decompiledFiles: 1, maintainedFiles: 1, skippedFiles: 0 })
    expect(manifest.files[0]).toMatchObject({
      unitId: 'unit-1', name: 'com.example.Main', language: 'Java',
      decompiledPath: 'decompiled/sources/com/example/Main.java',
      decompiledStatus: 'exported',
      maintainedPath: 'maintained/sources/com/example/Main.java',
      maintainedStatus: 'exported',
    })
    expect(h.task).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: taskId, projectId: 'project-1', capability: { in: ['decompile', 'disassemble'] }, status: 'COMPLETED' }),
    }))
  })

  it('requires access before reading run observations', async () => {
    const { NextResponse } = await import('next/server')
    h.access.mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))

    const response = await GET(new Request(`http://localhost?taskId=${taskId}`), routeParams)

    expect(response.status).toBe(403)
    expect(h.task).not.toHaveBeenCalled()
    expect(h.observations).not.toHaveBeenCalled()
  })

  it('skips linked paths that escape the active artifact', async () => {
    h.observations.mockImplementation(async (args: { where: { type?: string } }) => args.where.type === 'maintained_source'
      ? []
      : [{ id: 'unit-1', stableKey: 'jadx:com.example.Main', artifactId: 'artifact-1', label: 'com.example.Main', attributes: {
        qualifiedName: 'com.example.Main', language: 'Java', codeArtifactId: 'project-1/artifact-1/../../outside/Main.java',
      } }])

    const response = await GET(new Request(`http://localhost?taskId=${taskId}`), routeParams)
    const zip = await JSZip.loadAsync(await response.arrayBuffer())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      decompiledFiles: number; maintainedFiles: number; skippedFiles: number; files: Array<Record<string, unknown>>
    }

    expect(response.status).toBe(200)
    expect(Object.keys(zip.files).some((name) => name.includes('/outside/Main.java'))).toBe(false)
    expect(manifest).toMatchObject({ decompiledFiles: 0, maintainedFiles: 0, skippedFiles: 1 })
    expect(manifest.files[0]).toMatchObject({ unitId: 'unit-1', status: 'skipped' })
  })

  it('rejects a task that is not a completed decompilation in the active import', async () => {
    h.task.mockResolvedValueOnce(null)

    const response = await GET(new Request(`http://localhost?taskId=${taskId}`), routeParams)

    expect(response.status).toBe(404)
    expect(h.observations).not.toHaveBeenCalled()
  })

  it('exports a currently verified C# build receipt as whitelisted manifest evidence', async () => {
    const sourceCode = 'namespace Sample; public class Pair { public static int Sum() => 42; }\n'
    const sourceHash = createHash('sha256').update(sourceCode).digest('hex')
    const relativePath = 'Core/Pair.cs'
    const sourceSetHash = createHash('sha256').update(relativePath).update('\0').update(sourceHash).update('\n').digest('hex')
    h.observations.mockImplementation(async (args: { where: { type?: string } }) => args.where.type === 'maintained_source'
      ? [{ stableKey: 'unit-1', artifactId: 'artifact-1', updatedAt: new Date('2026-10-04T00:00:00.000Z') }]
      : [{ id: 'unit-1', stableKey: 'jadx:Pair', artifactId: 'artifact-1', label: 'Pair', attributes: {
        qualifiedName: 'Pair', language: 'C#', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/Core/Pair.cs',
      } }])
    h.maintainedSources.mockResolvedValue([{
      codeUnitId: 'unit-1', artifactId: 'artifact-1', sourceCode, sourceHash,
      acceptedReviewId: 'review-1', relativePath, symbolIndex: [],
      updatedAt: new Date('2026-10-04T00:00:00.000Z'),
    }])
    h.reviews.mockResolvedValue([{
      id: 'review-1', artifactId: 'artifact-1', codeUnitId: 'unit-1', reviewerId: 'user-1',
      decision: 'ACCEPTED', maintainedSourceHash: sourceHash, symbolIndexSnapshot: [],
      validationStatus: 'PASSED', validationMethod: 'roslyn-parse', createdAt: new Date('2026-10-04T00:00:00.000Z'),
    }])
    h.findBuildReceipt.mockResolvedValue({
      stableKey: `csharp-build:${taskId}:${sourceSetHash}`,
      attributes: {
        version: 'reamon-csharp-project-build-v1', taskId, artifactId: 'artifact-1',
        sourceSha256: sourceSetHash, validationStatus: 'FAILED',
        validationMethod: 'roslyn-csharp-project-4.11.0-compile', compilerVersion: '4.11.0',
        validationMessage: 'Do not export diagnostic source context.', compiledSha256: 'b'.repeat(64),
        createdAt: '2026-10-04T00:00:00.000Z',
        files: [{ codeUnitId: 'unit-1', acceptedReviewId: 'review-1', relativePath, sourceSha256: sourceHash }],
      },
    })

    const response = await GET(new Request(`http://localhost?taskId=${taskId}`), routeParams)
    const zip = await JSZip.loadAsync(await response.arrayBuffer())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(manifest.buildEvidence).toEqual({ csharpProject: {
      schema: 'reamon-csharp-project-build-v1',
      validationStatus: 'FAILED',
      validationMethod: 'roslyn-csharp-project-4.11.0-compile',
      compilerVersion: '4.11.0',
      sourceSetSha256: sourceSetHash,
      compiledAssemblySha256: 'b'.repeat(64),
      compiledAssemblyIncluded: false,
      createdAt: '2026-10-04T00:00:00.000Z',
      files: [{ codeUnitId: 'unit-1', acceptedReviewId: 'review-1', relativePath, sourceSha256: sourceHash }],
    } })
    expect(JSON.stringify(manifest.buildEvidence)).not.toContain('Do not export diagnostic')
  })

  it('includes a verified Go project build and imported module hashes in the archive manifest', async () => {
    const sourceCode = 'package main\nfunc main() {}\n'
    const sourceHash = createHash('sha256').update(sourceCode).digest('hex')
    const relativePath = 'src/main.go'
    const sourceSetHash = createHash('sha256').update(relativePath).update('\0').update(sourceHash).update('\n').digest('hex')
    const dependencyHash = createHash('sha256').update('go.mod').update('\0').update('d'.repeat(64)).update('\n').digest('hex')
    h.observations.mockImplementation(async (args: { where: { type?: string } }) => args.where.type === 'maintained_source'
      ? [{ stableKey: 'unit-1', artifactId: 'artifact-1', updatedAt: new Date('2026-10-04T00:00:00.000Z') }]
      : [{ id: 'unit-1', stableKey: 'go:main', artifactId: 'artifact-1', label: 'main', attributes: {
        qualifiedName: 'main', language: 'Go', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/src/main.go',
      } }])
    h.maintainedSources.mockResolvedValue([{
      codeUnitId: 'unit-1', artifactId: 'artifact-1', sourceCode, sourceHash, acceptedReviewId: 'review-1', relativePath,
      updatedAt: new Date('2026-10-04T00:00:00.000Z'),
    }])
    h.reviews.mockResolvedValue([{
      id: 'review-1', artifactId: 'artifact-1', codeUnitId: 'unit-1', reviewerId: 'user-1',
      decision: 'ACCEPTED', maintainedSourceHash: sourceHash, symbolIndexSnapshot: [],
      validationStatus: 'PASSED', validationMethod: 'go-1.24-project-build', createdAt: new Date('2026-10-04T00:00:00.000Z'),
    }])
    h.findBuildReceipt.mockResolvedValue({
      stableKey: `go-build:${taskId}:${sourceSetHash}:${dependencyHash}`,
      attributes: {
        version: 'reamon-go-project-build-v1', taskId, artifactId: 'artifact-1', sourceSha256: sourceSetHash,
        dependencySha256: dependencyHash, validationStatus: 'PASSED', validationMethod: 'go-1.24-project-build',
        compilerVersion: '1.24.4', compiledSha256: 'b'.repeat(64), packageCount: 1,
        createdAt: '2026-10-04T00:00:00.000Z',
        files: [{ codeUnitId: 'unit-1', acceptedReviewId: 'review-1', relativePath, buildPath: 'src/main.go', sourceSha256: sourceHash }],
        dependencies: [{ artifactId: 'go-mod-1', relativePath: 'go.mod', buildPath: 'go.mod', sourceSha256: 'd'.repeat(64) }],
      },
    })
    h.artifacts.mockResolvedValue([{ id: 'go-mod-1', relativePath: 'go.mod', sha256: 'd'.repeat(64) }])

    const response = await GET(new Request(`http://localhost?taskId=${taskId}`), routeParams)
    const zip = await JSZip.loadAsync(await response.arrayBuffer())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { buildEvidence?: Record<string, unknown> }

    expect(response.status).toBe(200)
    expect(manifest.buildEvidence?.goProject).toMatchObject({
      schema: 'reamon-go-project-build-v1',
      validationStatus: 'PASSED',
      dependencySetSha256: dependencyHash,
      packageCount: 1,
      compiledArtifactsIncluded: false,
      dependencies: [{ relativePath: 'go.mod', manifestPath: 'go.mod', sourceSha256: 'd'.repeat(64) }],
    })
  })

  it('omits a stale C# build receipt when another accepted source is present', async () => {
    const sourceCode = 'namespace Sample; public class Pair { }\n'
    const sourceHash = createHash('sha256').update(sourceCode).digest('hex')
    const relativePath = 'Core/Pair.cs'
    const sourceSetHash = createHash('sha256').update(relativePath).update('\0').update(sourceHash).update('\n').digest('hex')
    h.observations.mockImplementation(async (args: { where: { type?: string } }) => args.where.type === 'maintained_source'
      ? []
      : [
        { id: 'unit-1', stableKey: 'pair', artifactId: 'artifact-1', label: 'Pair', attributes: { language: 'C#' } },
        { id: 'unit-2', stableKey: 'extra', artifactId: 'artifact-1', label: 'Extra', attributes: { language: 'C#' } },
      ])
    h.maintainedSources.mockResolvedValue([
      { codeUnitId: 'unit-1', artifactId: 'artifact-1', sourceCode, sourceHash, acceptedReviewId: 'review-1', relativePath },
      { codeUnitId: 'unit-2', artifactId: 'artifact-1', sourceCode, sourceHash, acceptedReviewId: 'review-2', relativePath: 'Core/Extra.cs' },
    ])
    h.findBuildReceipt.mockResolvedValue({
      stableKey: `csharp-build:${taskId}:${sourceSetHash}`,
      attributes: {
        version: 'reamon-csharp-project-build-v1', taskId, artifactId: 'artifact-1', sourceSha256: sourceSetHash,
        validationStatus: 'PASSED', files: [{ codeUnitId: 'unit-1', acceptedReviewId: 'review-1', relativePath, sourceSha256: sourceHash }],
      },
    })

    const response = await GET(new Request(`http://localhost?taskId=${taskId}`), routeParams)
    const zip = await JSZip.loadAsync(await response.arrayBuffer())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(manifest).not.toHaveProperty('buildEvidence')
  })
})
