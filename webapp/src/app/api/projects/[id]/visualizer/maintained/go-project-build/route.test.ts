/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), task: vi.fn(), observations: vi.fn(), findReceipt: vi.fn(),
  sources: vi.fn(), reviews: vi.fn(), receipt: vi.fn(), agentFetch: vi.fn(), artifacts: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  task: { findFirst: h.task },
  artifact: { findMany: h.artifacts, findFirst: vi.fn() },
  reamonObservation: { findMany: h.observations, findFirst: h.findReceipt, upsert: h.receipt },
  reamonMaintainedSource: { findMany: h.sources },
  reamonCodeReview: { findMany: h.reviews },
} }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccess: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/agentFetch', () => ({ agentFetch: h.agentFetch }))

import { GET, POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }
const sourceCode = 'package main\nfunc main() {}\n'
const sourceHash = createHash('sha256').update(sourceCode).digest('hex')
const sourceSetHash = createHash('sha256').update('main.go').update('\0').update(sourceHash).update('\n').digest('hex')
const emptyDependencyHash = createHash('sha256').digest('hex')
let artifactRoot = ''

beforeEach(async () => {
  vi.clearAllMocks()
  artifactRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-go-project-build-'))
  vi.stubEnv('REAMON_ARTIFACTS_PATH', artifactRoot)
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.access.mockResolvedValue({ projectId: 'project-1' })
  h.selection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  h.task.mockResolvedValue({ id: 'task-1', artifactId: 'artifact-1' })
  h.observations.mockResolvedValue([{ id: 'unit-1', attributes: { language: 'Go' } }])
  h.sources.mockResolvedValue([{ codeUnitId: 'unit-1', sourceCode, sourceHash, acceptedReviewId: 'review-1', relativePath: 'main.go' }])
  h.reviews.mockResolvedValue([{ id: 'review-1', codeUnitId: 'unit-1', maintainedSourceHash: sourceHash }])
  h.receipt.mockResolvedValue({ id: 'receipt-1' })
  h.findReceipt.mockResolvedValue(null)
  h.artifacts.mockResolvedValue([])
  h.agentFetch.mockResolvedValue(new Response(JSON.stringify({
    source_sha256: sourceSetHash,
    dependency_sha256: emptyDependencyHash,
    validation_status: 'PASSED',
    validation_method: 'go-1.24-project-build',
    validation_message: 'Compiled one accepted file without executing it.',
    compiler_version: '1.24.4',
    compiled_sha256: 'c'.repeat(64),
    package_count: 1,
    file_count: 1,
    files: [{ relative_path: 'main.go', source_sha256: sourceHash }],
    dependencies: [],
  }), { status: 200 }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true })
})

describe('POST Go project build', () => {
  it('compiles accepted Go sources and persists hash-bound evidence', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'task-1' }),
    }), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ receipt: {
      version: 'reamon-go-project-build-v1',
      validationStatus: 'PASSED',
      sourceSha256: sourceSetHash,
      dependencySha256: emptyDependencyHash,
      files: [{ codeUnitId: 'unit-1', acceptedReviewId: 'review-1', relativePath: 'main.go', buildPath: 'main.go', sourceSha256: sourceHash }],
    } })
    expect(h.agentFetch).toHaveBeenCalledWith('/reamon/code/compile-project', expect.objectContaining({
      method: 'POST',
      body: expect.any(String),
    }), { timeoutMs: 40_000 })
    expect(JSON.parse(h.agentFetch.mock.calls[0][1].body)).toMatchObject({
      language: 'go',
      files: [{ relative_path: 'main.go', expected_sha256: sourceHash }],
      go_mod: '',
    })
    expect(h.receipt).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ taskId: 'task-1', artifactId: 'artifact-1', type: 'project_build_receipt' }),
      update: expect.objectContaining({ isPending: false }),
    }))
  })

  it('rejects sources that no longer match the accepted review', async () => {
    h.sources.mockResolvedValue([{ codeUnitId: 'unit-1', sourceCode, sourceHash: '0'.repeat(64), acceptedReviewId: 'review-1', relativePath: 'main.go' }])
    const response = await POST(new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'task-1' }),
    }), params)

    expect(response.status).toBe(409)
    expect(h.agentFetch).not.toHaveBeenCalled()
    expect(h.receipt).not.toHaveBeenCalled()
  })

  it('binds an imported go.mod manifest hash into the build receipt', async () => {
    const goModContent = 'module example.local/project\n\ngo 1.24\n'
    const moduleHash = createHash('sha256').update(goModContent).digest('hex')
    const dependencyHash = createHash('sha256').update('go.mod').update('\0').update(moduleHash).update('\n').digest('hex')
    await writeFile(path.join(artifactRoot, 'go.mod'), goModContent)
    h.artifacts.mockResolvedValue([{
      id: 'go-mod-1', relativePath: 'go.mod', storagePath: 'go.mod', sha256: moduleHash, sizeBytes: BigInt(Buffer.byteLength(goModContent)),
    }])
    h.agentFetch.mockResolvedValue(new Response(JSON.stringify({
      source_sha256: sourceSetHash,
      dependency_sha256: dependencyHash,
      validation_status: 'PASSED',
      validation_method: 'go-1.24-project-build',
      validation_message: 'Compiled without executing.',
      compiler_version: '1.24.4',
      compiled_sha256: 'c'.repeat(64),
      package_count: 1,
      file_count: 1,
      files: [{ relative_path: 'main.go', source_sha256: sourceHash }],
      dependencies: [{ path: 'go.mod', source_sha256: moduleHash }],
    }), { status: 200 }))

    const response = await POST(new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'task-1' }),
    }), params)

    expect(response.status).toBe(200)
    expect(JSON.parse(h.agentFetch.mock.calls[0][1].body)).toMatchObject({
      go_mod: goModContent,
      go_mod_sha256: moduleHash,
    })
    expect(h.receipt).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ attributes: expect.objectContaining({
        dependencySha256: dependencyHash,
        dependencies: [{ artifactId: 'go-mod-1', relativePath: 'go.mod', buildPath: 'go.mod', sourceSha256: moduleHash }],
      }) }),
    }))
  })

  it('preserves authentication denials', async () => {
    h.user.mockResolvedValue(NextResponse.json({ error: 'Unauthenticated' }, { status: 401 }))
    const response = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ taskId: 'task-1' }) }), params)

    expect(response.status).toBe(401)
    expect(h.task).not.toHaveBeenCalled()
  })
})

describe('GET Go project build receipt', () => {
  it('returns the verified receipt for the active run', async () => {
    h.findReceipt.mockResolvedValue({
      stableKey: `go-build:task-1:${sourceSetHash}:${emptyDependencyHash}`,
      attributes: {
        version: 'reamon-go-project-build-v1', taskId: 'task-1', artifactId: 'artifact-1',
        sourceSha256: sourceSetHash, dependencySha256: emptyDependencyHash,
        validationStatus: 'PASSED', validationMethod: 'go-1.24-project-build', validationMessage: 'Compiled.',
        compilerVersion: '1.24.4', compiledSha256: 'c'.repeat(64), packageCount: 1,
        createdAt: new Date().toISOString(),
        files: [{ codeUnitId: 'unit-1', acceptedReviewId: 'review-1', relativePath: 'main.go', buildPath: 'main.go', sourceSha256: sourceHash }],
        dependencies: [],
      },
    })

    const response = await GET(new Request('http://localhost?taskId=task-1'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ receipt: { sourceSha256: sourceSetHash, validationStatus: 'PASSED', files: [{ relativePath: 'main.go' }] } })
  })

  it('hides receipts when another accepted Go file changes the exact project set', async () => {
    h.observations.mockResolvedValue([
      { id: 'unit-1', attributes: { language: 'Go' } },
      { id: 'unit-2', attributes: { language: 'Go' } },
    ])
    h.sources.mockResolvedValue([
      { codeUnitId: 'unit-1', sourceCode, sourceHash, acceptedReviewId: 'review-1', relativePath: 'main.go' },
      { codeUnitId: 'unit-2', sourceCode, sourceHash, acceptedReviewId: 'review-2', relativePath: 'extra.go' },
    ])
    h.reviews.mockResolvedValue([
      { id: 'review-1', codeUnitId: 'unit-1', maintainedSourceHash: sourceHash },
      { id: 'review-2', codeUnitId: 'unit-2', maintainedSourceHash: sourceHash },
    ])
    h.findReceipt.mockResolvedValue({
      stableKey: `go-build:task-1:${sourceSetHash}:${emptyDependencyHash}`,
      attributes: {
        version: 'reamon-go-project-build-v1', taskId: 'task-1', artifactId: 'artifact-1',
        sourceSha256: sourceSetHash, dependencySha256: emptyDependencyHash, validationStatus: 'PASSED',
        files: [{ codeUnitId: 'unit-1', acceptedReviewId: 'review-1', relativePath: 'main.go', buildPath: 'main.go', sourceSha256: sourceHash }],
        dependencies: [],
      },
    })

    const response = await GET(new Request('http://localhost?taskId=task-1'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ receipt: null })
  })
})
