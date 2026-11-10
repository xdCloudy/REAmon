// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), observation: vi.fn(), artifact: vi.fn(), root: vi.fn(), resolvePath: vi.fn(),
  findFirst: vi.fn(), create: vi.fn(), update: vi.fn(),
  attemptFindFirst: vi.fn(), attemptFindMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  reamonObservation: { findFirst: h.observation },
  artifact: { findFirst: h.artifact },
  reamonCodeDraft: { findFirst: h.findFirst, create: h.create, update: h.update },
  reamonCodeAttempt: { findFirst: h.attemptFindFirst, findMany: h.attemptFindMany },
} }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccessStrict: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/reamon/derived-storage', () => ({ derivedArtifactRoot: h.root, resolveDerivedArtifactPath: h.resolvePath }))
vi.mock('@/lib/reamon/code-attempts', () => ({ failExpiredCodeAttemptsForHistory: vi.fn() }))

import { GET, PATCH, POST } from './route'

const routeParams = { params: Promise.resolve({ id: 'project-1', unitId: 'unit-1' }) }
let testRoot = ''
const originalSource = 'class Main { void run() {} }'
const sourceHash = createHash('sha256').update(originalSource).digest('hex')
const draftSource = 'class Main { void execute() {} }'
const draftHash = createHash('sha256').update(draftSource).digest('hex')

async function request(method: string, body?: unknown) {
  return new Request('http://localhost', {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.access.mockResolvedValue({ projectId: 'project-1' })
  h.selection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  h.observation.mockResolvedValue({
    id: 'unit-1', artifactId: 'artifact-1', label: 'app.Main',
    attributes: { language: 'Java', qualifiedName: 'app.Main', codeArtifactId: 'project-1/artifact-1/run/source/Main.java' },
  })
  h.artifact.mockResolvedValue({ id: 'artifact-1' })
  h.findFirst.mockResolvedValue(null)
  h.attemptFindFirst.mockResolvedValue(null)
  h.attemptFindMany.mockResolvedValue([])
  h.create.mockImplementation(async ({ data }) => ({ id: 'draft-1', updatedAt: new Date('2026-10-05T10:00:00Z'), data }))
  h.update.mockResolvedValue({ id: 'draft-1', updatedAt: new Date('2026-10-05T11:00:00Z') })
  testRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-drafts-'))
  h.root.mockReturnValue(testRoot)
  h.resolvePath.mockImplementation((relativePath: string) => path.join(testRoot, relativePath))
  const originalPath = path.join(testRoot, 'project-1/artifact-1/run/source/Main.java')
  await mkdir(path.dirname(originalPath), { recursive: true })
  await writeFile(originalPath, originalSource)
})

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
})

describe('/api/projects/[id]/visualizer/drafts/[unitId]', () => {
  it('denies foreign draft reads and writes before resolving source or attempts', async () => {
    h.user.mockResolvedValue({ userId: 'foreign-user' })
    h.access.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
    const responses = await Promise.all([
      GET(await request('GET'), routeParams),
      POST(await request('POST', { sourceCode: 'private draft' }), routeParams),
      PATCH(await request('PATCH', { rationale: 'private review' }), routeParams),
    ])

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404])
    expect(h.access).toHaveBeenCalledTimes(3)
    expect(h.access).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    expect(h.observation).not.toHaveBeenCalled()
    expect(h.selection).not.toHaveBeenCalled()
    expect(h.findFirst).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
    expect(h.update).not.toHaveBeenCalled()
    expect(h.attemptFindFirst).not.toHaveBeenCalled()
    expect(h.attemptFindMany).not.toHaveBeenCalled()
  })

  it('loads only the latest draft matching the active source, artifact, and import run', async () => {
    const updatedAt = new Date('2026-10-05T09:00:00Z')
    h.findFirst.mockResolvedValueOnce({
      id: 'draft-1', sourceCode: draftSource, sourceAttemptId: null, draftHash, providerName: 'Local model',
      modelIdentifier: 'qwen-coder', question: 'Recover intent', scope: 'file', syntaxValidated: true, validationStatus: 'PASSED', updatedAt,
    })

    const response = await GET(await request('GET'), routeParams)

    expect(await response.json()).toMatchObject({ exists: true, draft: { id: 'draft-1', syntaxValidated: null, validationStatus: null, updatedAt: updatedAt.toISOString() } })
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1', codeUnitId: 'unit-1', artifactId: 'artifact-1', runKey: 'project-1/artifact-1/run/source', sourceHash },
      orderBy: { updatedAt: 'desc' },
    }))
    expect(response.headers.get('Cache-Control')).toContain('no-store')
  })

  it('reloads validated Go package inventory metadata with saved rename proposals', async () => {
    const inventory = {
      scope: 'reviewed-same-directory-go-package-source-snapshot', sourceFileCount: 2,
      privatePackageSymbolCount: 2, referencedPrivatePackageSymbols: 1, unreferencedPrivateSymbols: 1,
      exportedPackageSymbolCount: 0, unsupportedPackageSymbolCount: 0, renameBindingCatalogTruncated: false,
    }
    h.attemptFindMany.mockResolvedValueOnce([{
      id: 'attempt-1', providerName: 'Provider', modelIdentifier: 'model', question: '', scope: 'rename-suggestions',
      status: 'SUCCEEDED', cancelRequested: false, errorCode: null, errorMessage: null, resultSource: null,
      qualityReview: null, requestPayload: { goProjectInventory: inventory }, rewriteHistory: [],
      syntaxValidated: null, validationStatus: null, validationMethod: null, validationMessage: null,
      createdAt: new Date('2026-11-10T12:00:00Z'), completedAt: null,
    }])

    const response = await GET(await request('GET'), routeParams)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ attempts: [{ id: 'attempt-1', proposalGoProjectInventory: inventory }] })
  })

  it('stores AI output as an unreviewed draft without trusting client-supplied validation', async () => {
    const response = await POST(await request('POST', {
      sourceCode: 'class Main { void execute() {} }', providerName: 'Local model', model: 'qwen-coder', question: 'Recover intent', scope: 'member', syntaxValidated: true,
    }), routeParams)

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ saved: true, draftId: 'draft-1' })
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-1', artifactId: 'artifact-1', runKey: 'project-1/artifact-1/run/source', codeUnitId: 'unit-1',
        unitName: 'app.Main', language: 'Java', sourceHash, sourceCode: 'class Main { void execute() {} }',
        draftHash, providerName: 'Local model', modelIdentifier: 'qwen-coder', question: 'Recover intent', scope: 'member',
        syntaxValidated: null, validationStatus: null, validationMethod: null, validationMessage: null,
      }),
    }))
  })

  it('does not trust malformed client-supplied validation metadata', async () => {
    const response = await POST(await request('POST', {
      sourceCode: 'class Main { void execute() {} }', providerName: 'Local model', model: 'qwen-coder', syntaxValidated: 'yes',
    }), routeParams)

    expect(response.status).toBe(201)
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        syntaxValidated: null, validationStatus: null, validationMethod: null, validationMessage: null,
      }),
    }))
  })

  it('rejects edits after the linked decompilation changes, then updates the matching draft', async () => {
    h.findFirst.mockResolvedValue({ id: 'draft-1', sourceHash: 'old-hash' })
    const stale = await PATCH(await request('PATCH', { draftId: 'draft-1', sourceCode: 'class Main {}' }), routeParams)
    expect(stale.status).toBe(409)
    expect(h.update).not.toHaveBeenCalled()

    h.findFirst.mockResolvedValueOnce({ id: 'draft-1', sourceHash })
    const updated = await PATCH(await request('PATCH', { draftId: 'draft-1', sourceCode: 'class Main { void execute() {} }' }), routeParams)
    expect(updated.status).toBe(200)
    expect(h.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' }, data: {
        sourceCode: draftSource, draftHash, syntaxValidated: null,
        validationStatus: null, validationMethod: null, validationMessage: null,
      }, select: { id: true, updatedAt: true },
    })
  })
})
