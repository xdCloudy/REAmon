/** @vitest-environment node */
/**
 * Opt-in PostgreSQL acceptance for Go build receipts. Run against the stack DB
 * with REAMON_GO_PROJECT_BUILD_INTEGRATION=1 and a writable artifact directory.
 * Add REAMON_GO_PROJECT_BUILD_REAL_AGENT=1 to send the synthetic multi-package
 * project to the live isolated agent compiler instead of the response fixture.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import prisma from '@/lib/prisma'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  agentFetch: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: mocks.getActiveWorkspaceImportSelection }))
vi.mock('@/lib/agentFetch', () => ({ agentFetch: mocks.agentFetch }))

import { GET, POST } from './route'

const enabled = process.env.REAMON_GO_PROJECT_BUILD_INTEGRATION === '1'
  && Boolean(process.env.DATABASE_URL)
  && Boolean(process.env.REAMON_ARTIFACTS_PATH)
const goMod = 'module example.local/reamon-integration\n\ngo 1.24\n'
const goSources = [
  {
    unitName: 'main',
    relativePath: 'service/app/main.go',
    sourceCode: 'package main\nimport "example.local/reamon-integration/core"\nfunc main() { _ = core.Value() }\n',
  },
  {
    unitName: 'Value',
    relativePath: 'service/core/value.go',
    sourceCode: 'package core\nfunc Value() int { return 42 }\n',
  },
]
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const setHash = (entries: Array<{ path: string; hash: string }>) => {
  const digest = createHash('sha256')
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(entry.path).update('\0').update(entry.hash).update('\n')
  }
  return digest.digest('hex')
}

let projectId = ''
let projectOwnerId = ''
let taskId = ''
let artifactId = ''
let moduleArtifactId = ''
let codeUnitIds: string[] = []
let reviewIds: string[] = []
let artifactsDirectory = ''
let moduleHash = ''

function params() { return { params: Promise.resolve({ id: projectId }) } }
function buildRequest() {
  return new Request('http://localhost/api/projects/go-project-build/visualizer/maintained/go-project-build', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }),
  })
}
function receiptRequest() {
  return new Request(`http://localhost/api/projects/${projectId}/visualizer/maintained/go-project-build?taskId=${taskId}`)
}

describe.skipIf(!enabled)('Go build receipt against PostgreSQL', () => {
  beforeAll(async () => {
    const user = await prisma.user.findFirst({ select: { id: true } })
    if (!user) throw new Error('Go build receipt integration requires an existing database user')
    projectOwnerId = user.id
    const project = await prisma.project.create({
      data: { userId: user.id, name: `GoBuildReceipt-${randomUUID()}`, projectKind: 'REVERSE_ENGINEERING' },
      select: { id: true },
    })
    projectId = project.id
    artifactsDirectory = await mkdtemp(path.join(os.tmpdir(), 'reamon-go-receipt-db-'))
    await mkdir(path.join(artifactsDirectory, 'service'), { recursive: true })
    await writeFile(path.join(artifactsDirectory, 'service', 'go.mod'), goMod)
    vi.stubEnv('REAMON_ARTIFACTS_PATH', artifactsDirectory)

    const mainSource = goSources[0].sourceCode
    const artifact = await prisma.artifact.create({
      data: {
        projectId,
        name: 'main.go',
        originalName: 'main.go',
        relativePath: goSources[0].relativePath,
        storagePath: 'not-read-by-this-route',
        sha256: hash(mainSource),
        sizeBytes: BigInt(Buffer.byteLength(mainSource)),
        extension: '.go',
        profile: { format: 'go-source' },
      },
      select: { id: true },
    })
    artifactId = artifact.id
    const moduleArtifact = await prisma.artifact.create({
      data: {
        projectId,
        name: 'go.mod',
        originalName: 'go.mod',
        relativePath: 'service/go.mod',
        storagePath: 'service/go.mod',
        sha256: hash(goMod),
        sizeBytes: BigInt(Buffer.byteLength(goMod)),
        extension: '.mod',
      },
      select: { id: true },
    })
    moduleArtifactId = moduleArtifact.id
    const task = await prisma.task.create({
      data: { projectId, artifactId, capability: 'decompile', title: 'Go project receipt acceptance', status: 'COMPLETED' },
      select: { id: true },
    })
    taskId = task.id
    codeUnitIds = []
    reviewIds = []
    for (const source of goSources) {
      const sourceHash = hash(source.sourceCode)
      const observation = await prisma.reamonObservation.create({
        data: {
          projectId, taskId, artifactId,
          kind: 'entity', type: 'code_unit', stableKey: source.unitName, canonicalKey: source.unitName,
          source: 'go-project-build-integration', attributes: { language: 'Go' },
        },
        select: { id: true },
      })
      codeUnitIds.push(observation.id)
      const review = await prisma.reamonCodeReview.create({
        data: {
          projectId, artifactId, codeUnitId: observation.id, reviewerId: user.id, decision: 'ACCEPTED',
          rationale: 'Integration fixture acceptance', maintainedSourceHash: sourceHash,
        },
        select: { id: true },
      })
      reviewIds.push(review.id)
      await prisma.reamonMaintainedSource.create({
        data: {
          projectId, artifactId, codeUnitId: observation.id, unitName: source.unitName, language: 'Go',
          sourceCode: source.sourceCode, sourceHash, acceptedReviewId: review.id, relativePath: source.relativePath,
        },
      })
    }

    mocks.requireEffectiveUser.mockResolvedValue({ userId: user.id })
    mocks.requireProjectAccess.mockResolvedValue({ project: { id: projectId, userId: user.id } })
    mocks.getActiveWorkspaceImportSelection.mockResolvedValue({ artifactWhere: { projectId } })
    moduleHash = hash(goMod)
    if (process.env.REAMON_GO_PROJECT_BUILD_REAL_AGENT === '1') {
      const agentBase = (process.env.AGENT_API_URL || 'http://agent:8080').replace(/\/+$/, '')
      mocks.agentFetch.mockImplementation(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers)
        headers.set('x-internal-key', process.env.INTERNAL_API_KEY || '')
        return fetch(`${agentBase}${url}`, { ...init, headers })
      })
    } else mocks.agentFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { files: Array<{ relative_path: string; expected_sha256: string }>; go_mod: string }
      const sourceSha256 = setHash(body.files.map((file) => ({ path: file.relative_path, hash: file.expected_sha256 })))
      const dependencySha256 = setHash([{ path: 'go.mod', hash: hash(body.go_mod) }])
      return new Response(JSON.stringify({
        source_sha256: sourceSha256,
        dependency_sha256: dependencySha256,
        validation_status: 'PASSED',
        validation_method: 'go-1.24.4-project-build',
        validation_message: 'PostgreSQL integration compile receipt.',
        compiler_version: '1.24.4',
        compiled_sha256: 'a'.repeat(64),
        package_count: 2,
        file_count: body.files.length,
        files: body.files.map((file) => ({ relative_path: file.relative_path, source_sha256: file.expected_sha256 })),
        dependencies: [{ path: 'go.mod', source_sha256: hash(body.go_mod) }],
      }), { status: 200 })
    })
  })

  afterAll(async () => {
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId, userId: projectOwnerId } })
    if (artifactsDirectory) await rm(artifactsDirectory, { recursive: true, force: true })
    vi.unstubAllEnvs()
    await prisma.$disconnect()
  })

  it('persists, reloads, and invalidates the receipt against actual source and manifest rows', async () => {
    const buildResponse = await POST(buildRequest(), params())
    expect(buildResponse.status).toBe(200)
    const build = await buildResponse.json()
    expect(build.receipt).toMatchObject({
      validationStatus: 'PASSED',
      validationMethod: expect.stringMatching(/^go-\d+\.\d+(?:\.\d+)?-project-build$/),
      packageCount: 2,
      files: [
        { codeUnitId: codeUnitIds[0], acceptedReviewId: reviewIds[0], relativePath: goSources[0].relativePath, buildPath: 'app/main.go' },
        { codeUnitId: codeUnitIds[1], acceptedReviewId: reviewIds[1], relativePath: goSources[1].relativePath, buildPath: 'core/value.go' },
      ],
      dependencies: [{ artifactId: moduleArtifactId, relativePath: 'service/go.mod', buildPath: 'go.mod', sourceSha256: moduleHash }],
    })
    if (process.env.REAMON_GO_PROJECT_BUILD_REAL_AGENT === '1') {
      expect(build.receipt.validationMessage).toMatch(/^Go \d+\.\d+(?:\.\d+)? compiled 2 accepted files across 2 packages without executing the output\./)
    }

    const loadedResponse = await GET(receiptRequest(), params())
    expect(loadedResponse.status).toBe(200)
    expect((await loadedResponse.json()).receipt).toMatchObject({ validationStatus: 'PASSED', sourceSha256: build.receipt.sourceSha256 })
    expect(await prisma.reamonObservation.count({ where: { projectId, taskId, type: 'project_build_receipt', isPending: false } })).toBe(1)

    await writeFile(path.join(artifactsDirectory, 'service', 'go.mod'), `${goMod}// changed after the receipt was saved\n`)
    const staleManifestBytes = await GET(receiptRequest(), params())
    expect((await staleManifestBytes.json()).receipt).toBeNull()
    await writeFile(path.join(artifactsDirectory, 'service', 'go.mod'), goMod)

    await prisma.artifact.update({ where: { id: moduleArtifactId }, data: { sha256: 'b'.repeat(64) } })
    const staleManifest = await GET(receiptRequest(), params())
    expect((await staleManifest.json()).receipt).toBeNull()
    await prisma.artifact.update({ where: { id: moduleArtifactId }, data: { sha256: moduleHash } })

    await prisma.reamonMaintainedSource.update({
      where: { projectId_codeUnitId: { projectId, codeUnitId: codeUnitIds[0] } },
      data: { sourceCode: goSources[0].sourceCode + '// changed\n' },
    })
    const staleSource = await GET(receiptRequest(), params())
    expect((await staleSource.json()).receipt).toBeNull()
  }, 60_000)
})
