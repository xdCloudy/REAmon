/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), observationFindFirst: vi.fn(), observationFindMany: vi.fn(),
  artifactFindFirst: vi.fn(), maintainedFindMany: vi.fn(), reviewFindMany: vi.fn(), attemptFindFirst: vi.fn(),
  providerFindFirst: vi.fn(), agentFetch: vi.fn(), root: vi.fn(), resolvePath: vi.fn(), transaction: vi.fn(), attemptCreate: vi.fn(), attemptFindMany: vi.fn(),
  txAttemptCreate: vi.fn(), txDraftCreate: vi.fn(),
}))

vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccessStrict: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/reamon/derived-storage', () => ({ derivedArtifactRoot: h.root, resolveDerivedArtifactPath: h.resolvePath }))
vi.mock('@/lib/agentFetch', () => ({ agentFetch: h.agentFetch }))
vi.mock('@/lib/prisma', () => ({ default: {
  reamonObservation: { findFirst: h.observationFindFirst, findMany: h.observationFindMany },
  artifact: { findFirst: h.artifactFindFirst },
  reamonMaintainedSource: { findMany: h.maintainedFindMany },
  reamonCodeReview: { findMany: h.reviewFindMany },
  reamonCodeAttempt: { findFirst: h.attemptFindFirst, findMany: h.attemptFindMany, create: h.attemptCreate },
  userLlmProvider: { findFirst: h.providerFindFirst },
  $transaction: h.transaction,
} }))

import { POST } from './route'

const selectedPath = 'pkg/a.go'
const siblingPath = 'pkg/b.go'
const selectedCodeArtifactId = 'project-1/artifact-1/task-1/run-1/sources/pkg/a.go'
const siblingCodeArtifactId = 'project-1/artifact-1/task-1/run-1/sources/pkg/b.go'
const selectedSource = 'package sample\nfunc normalize(value int) int { return value }\n'
const siblingSource = 'package sample\nfunc run() int { return normalize(1) }\n'
const selectedOutput = 'package sample\nfunc scale(value int) int { return value }\n'
const siblingOutput = 'package sample\nfunc run() int { return scale(1) }\n'
const bindingId = '0123456789abcdef01234567'
const inventoryPayload = {
  scope: 'reviewed-same-directory-go-package-source-snapshot', source_file_count: 2,
  private_package_symbol_count: 2, referenced_private_package_symbols: 1, unreferenced_private_symbols: 1,
  exported_package_symbol_count: 0, unsupported_package_symbol_count: 0, rename_binding_catalog_truncated: false,
  local_symbol_count: 1, referenced_local_symbols: 1, unreferenced_local_symbols: 0, unsupported_local_symbol_count: 0,
  entry_count: 3, entries_truncated: false,
  entries: [
    { id: bindingId, name: 'normalize', kind: 'package function', scope: 'package', relativePath: selectedPath, declarationStart: 20, referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'private-package-symbol-with-resolved-references', nameAssessment: 'unassessed' },
    { id: 'abcdef0123456789abcdef01', name: 'run', kind: 'package function', scope: 'package', relativePath: siblingPath, declarationStart: 20, referenceCount: 0, exported: false, classification: 'excluded', classificationReason: 'unreferenced-package-symbol', nameAssessment: 'unassessed' },
    { id: '00112233445566778899aabb', name: 'value', kind: 'local variable', scope: 'local', relativePath: selectedPath, declarationStart: selectedSource.indexOf('value int'), referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'local-symbol-with-resolved-references', nameAssessment: 'unassessed' },
  ],
}
const inputHash = (source: string) => createHash('sha256').update(source, 'utf8').digest('hex')
const setHash = (files: Array<{ relativePath: string; sourceCode: string }>) => {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath).update('\0').update(inputHash(file.sourceCode)).update('\n')
  }
  return hash.digest('hex')
}
const routeParams = { params: Promise.resolve({ id: 'project-1' }) }
let root = ''

function jsonResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(async () => {
  vi.clearAllMocks()
  root = await mkdtemp(path.join(os.tmpdir(), 'reamon-go-project-rename-'))
  h.user.mockResolvedValue({ userId: 'owner-1' })
  h.access.mockResolvedValue({ projectId: 'project-1' })
  h.selection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  h.observationFindFirst.mockResolvedValue({
    id: 'unit-a', artifactId: 'artifact-1', taskId: 'task-1', label: 'pkg.a',
    attributes: { language: 'Go', relativePath: selectedPath, qualifiedName: 'pkg.a', codeArtifactId: selectedCodeArtifactId },
  })
  h.observationFindMany.mockResolvedValue([
    { id: 'unit-a', label: 'pkg.a', attributes: { language: 'Go', relativePath: selectedPath, qualifiedName: 'pkg.a', codeArtifactId: selectedCodeArtifactId } },
    { id: 'unit-b', label: 'pkg.b', attributes: { language: 'Go', relativePath: siblingPath, qualifiedName: 'pkg.b', codeArtifactId: siblingCodeArtifactId } },
  ])
  h.artifactFindFirst.mockResolvedValue({ id: 'artifact-1', sha256: 'a'.repeat(64) })
  h.maintainedFindMany.mockResolvedValue([{
    codeUnitId: 'unit-b', sourceCode: siblingSource, sourceHash: inputHash(siblingSource),
    acceptedReviewId: 'review-b', relativePath: siblingPath,
  }])
  h.reviewFindMany.mockResolvedValue([{
    id: 'review-b', codeUnitId: 'unit-b', artifactId: 'artifact-1',
    maintainedSourceHash: inputHash(siblingSource), decision: 'ACCEPTED',
  }])
  h.attemptFindFirst.mockResolvedValue({
    id: 'proposal-1', requestPayload: {
      operation: 'scope-safe-rename-suggestions', providerId: 'provider-1', modelIdentifier: 'model-1',
      inputSha256: inputHash(selectedSource), projectSymbolContext: '', projectSymbolContextSha256: inputHash(''),
      goProjectScope: true, goSourceSetSha256: setHash([
        { relativePath: selectedPath, sourceCode: selectedSource }, { relativePath: siblingPath, sourceCode: siblingSource },
      ]), goSelectedPath: selectedPath,
      renames: [{ bindingId, oldName: 'normalize', newName: 'scale', kind: 'package function', rationale: 'clearer name' }],
    },
  })
  h.providerFindFirst.mockResolvedValue({ id: 'provider-1', name: 'Provider', modelIdentifier: 'model-1' })
  h.attemptCreate.mockResolvedValue({ id: 'suggestion-attempt-1' })
  h.attemptFindMany.mockResolvedValue([])
  h.root.mockReturnValue(root)
  h.resolvePath.mockImplementation((relative: string) => path.join(root, relative))
  await mkdir(path.dirname(path.join(root, selectedCodeArtifactId)), { recursive: true })
  await mkdir(path.dirname(path.join(root, siblingCodeArtifactId)), { recursive: true })
  await writeFile(path.join(root, selectedCodeArtifactId), selectedSource)
  await writeFile(path.join(root, siblingCodeArtifactId), siblingSource)
  h.agentFetch.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    if (url === '/reamon/code/go/refactor' && body.operation === 'bindings') {
      const sourceCode = String(body.source_code)
      return jsonResponse({
        source_sha256: inputHash(sourceCode), parser_version: 'go1.24.4', truncated: false,
        bindings: [{ id: bindingId, name: 'a', kind: 'parameter', scopeType: 'local', declarationStart: sourceCode.indexOf('a int'), referenceCount: 1, exported: false }],
      })
    }
    if (url === '/reamon/code/suggest-renames') {
      return jsonResponse({ renames: [{ bindingId, oldName: 'a', newName: 'value', rationale: 'clearer name' }] })
    }
    if (body.operation === 'project_bindings') {
      return jsonResponse({
        source_sha256: inputHash(selectedSource), source_set_sha256: setHash([
          { relativePath: selectedPath, sourceCode: selectedSource }, { relativePath: siblingPath, sourceCode: siblingSource },
        ]), selected_path: selectedPath,
        files: [
          { relative_path: selectedPath, source_sha256: inputHash(selectedSource) },
          { relative_path: siblingPath, source_sha256: inputHash(siblingSource) },
        ],
        bindings: [{ id: bindingId, name: 'normalize', kind: 'package function', scopeType: 'package', declarationStart: 20, referenceCount: 1, relativePath: selectedPath, exported: false }],
        truncated: false, parser_version: 'go1.24.4',
        inventory: inventoryPayload,
      })
    }
    return jsonResponse({
      scope: 'project', source_sha256: inputHash(selectedSource),
      source_set_sha256: setHash([{ relativePath: selectedPath, sourceCode: selectedSource }, { relativePath: siblingPath, sourceCode: siblingSource }]),
      output_source_set_sha256: setHash([{ relativePath: selectedPath, sourceCode: selectedOutput }, { relativePath: siblingPath, sourceCode: siblingOutput }]),
      output_sha256: inputHash(selectedOutput), source_code: selectedOutput, parser_version: 'go1.24.4',
      renamed_bindings: [{ bindingId, oldName: 'normalize', newName: 'scale', kind: 'package function', referenceCount: 1, scopeType: 'package' }],
      files: [
        { relative_path: selectedPath, input_sha256: inputHash(selectedSource), output_sha256: inputHash(selectedOutput), source_code: selectedOutput, edits: [{ start: selectedSource.indexOf('normalize'), end: selectedSource.indexOf('normalize') + 'normalize'.length, old_text: 'normalize', new_text: 'scale' }] },
        { relative_path: siblingPath, input_sha256: inputHash(siblingSource), output_sha256: inputHash(siblingOutput), source_code: siblingOutput, edits: [{ start: siblingSource.indexOf('normalize'), end: siblingSource.indexOf('normalize') + 'normalize'.length, old_text: 'normalize', new_text: 'scale' }] },
      ],
    })
  })
  h.txAttemptCreate.mockImplementation(async ({ data }) => ({ id: `attempt-${data.codeUnitId}` }))
  h.txDraftCreate.mockImplementation(async ({ data }) => ({ id: `draft-${data.codeUnitId}`, updatedAt: new Date('2026-11-10T12:00:00Z') }))
  h.transaction.mockImplementation(async (callback) => callback({
    reamonCodeAttempt: { create: h.txAttemptCreate },
    reamonCodeDraft: { create: h.txDraftCreate },
  }))
})

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

describe('POST safe-renames Go package scope', () => {
  it('returns and persists inventory counts for the verified same-directory Go snapshot', async () => {
    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'suggest', unitId: 'unit-a', providerId: 'provider-1', sourceCode: selectedSource,
        crossFileGo: true,
      }),
    }), routeParams)

    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.projectInventory).toMatchObject({
      scope: 'reviewed-same-directory-go-package-source-snapshot', sourceFileCount: 2,
      privatePackageSymbolCount: 2, referencedPrivatePackageSymbols: 1, unreferencedPrivateSymbols: 1,
      localSymbolCount: 1, referencedLocalSymbols: 1, unreferencedLocalSymbols: 0, unsupportedLocalSymbolCount: 0,
      exportedPackageSymbolCount: 0, unsupportedPackageSymbolCount: 0, renameBindingCatalogTruncated: false,
      entryCount: 3, entriesTruncated: false,
      entries: expect.arrayContaining([
        expect.objectContaining({ name: 'normalize', scope: 'package', classification: 'eligible', nameAssessment: 'unassessed' }),
        expect.objectContaining({ name: 'run', scope: 'package', classification: 'excluded', classificationReason: 'unreferenced-package-symbol' }),
        expect.objectContaining({ name: 'value', scope: 'local', classification: 'eligible', classificationReason: 'local-symbol-with-resolved-references' }),
      ]),
    })
    expect(h.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ requestPayload: expect.objectContaining({ goProjectInventory: body.projectInventory }) }),
    }))
  })

  it('returns and persists when bounded accepted-symbol context was truncated', async () => {
    const truncatedSource = 'package sample\nfunc normalize(a int) int { return a }\n'
    await writeFile(path.join(root, selectedCodeArtifactId), truncatedSource)
    h.maintainedFindMany.mockResolvedValueOnce(Array.from({ length: 4_097 }, (_, index) => ({
      codeUnitId: `truncated-unit-${index}`, sourceCode: siblingSource, sourceHash: inputHash(siblingSource),
      acceptedReviewId: null, relativePath: siblingPath,
    })))

    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'suggest', unitId: 'unit-a', providerId: 'provider-1', sourceCode: truncatedSource,
        crossFileGo: false,
      }),
    }), routeParams)

    const responseBody = await response.json()
    expect(response.status, JSON.stringify(responseBody)).toBe(200)
    expect(responseBody).toMatchObject({ scope: 'file', projectSymbolScanTruncated: true, candidates: 1 })
    expect(h.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ requestPayload: expect.objectContaining({ projectSymbolScanTruncated: true }) }),
    }))
  })

  it('type-checks and stores all cross-file changes as reviewable drafts atomically', async () => {
    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'apply', unitId: 'unit-a', providerId: 'provider-1', sourceCode: selectedSource,
        expectedSha256: inputHash(selectedSource), suggestionAttemptId: 'proposal-1', crossFileGo: true,
        renames: [{ bindingId, oldName: 'normalize', newName: 'scale', rationale: 'clearer name' }],
      }),
    }), routeParams)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ sourceCode: selectedOutput, attemptId: 'attempt-unit-a', draftId: 'draft-unit-a', validationStatus: 'PASSED' })
    expect(body.projectChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ unitId: 'unit-a', relativePath: selectedPath, draftId: 'draft-unit-a' }),
      expect.objectContaining({ unitId: 'unit-b', relativePath: siblingPath, draftId: 'draft-unit-b' }),
    ]))
    expect(h.transaction).toHaveBeenCalledTimes(1)
    expect(h.txAttemptCreate).toHaveBeenCalledTimes(2)
    expect(h.txDraftCreate).toHaveBeenCalledTimes(2)
    expect(h.txDraftCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ codeUnitId: 'unit-b', sourceHash: inputHash(siblingSource), sourceCode: siblingOutput, syntaxValidated: true, validationStatus: 'PASSED' }) }))
  })

  it('rejects a helper catalog whose source-set hash differs from the reviewed snapshot', async () => {
    h.agentFetch.mockResolvedValueOnce(jsonResponse({
      source_sha256: inputHash(selectedSource), source_set_sha256: 'f'.repeat(64), selected_path: selectedPath,
      files: [
        { relative_path: selectedPath, source_sha256: inputHash(selectedSource) },
        { relative_path: siblingPath, source_sha256: inputHash(siblingSource) },
      ],
      bindings: [{ id: bindingId, name: 'normalize', kind: 'package function', scopeType: 'package', declarationStart: 20, referenceCount: 1, relativePath: selectedPath, exported: false }],
      truncated: false, parser_version: 'go1.24.4',
      inventory: inventoryPayload,
    }))
    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'apply', unitId: 'unit-a', providerId: 'provider-1', sourceCode: selectedSource,
        expectedSha256: inputHash(selectedSource), suggestionAttemptId: 'proposal-1', crossFileGo: true,
        renames: [{ bindingId, oldName: 'normalize', newName: 'scale', rationale: 'clearer name' }],
      }),
    }), routeParams)

    expect(response.status).toBe(500)
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.txAttemptCreate).not.toHaveBeenCalled()
  })

  it('rejects a local inventory whose aggregate totals do not reconcile', async () => {
    h.agentFetch.mockResolvedValueOnce(jsonResponse({
      source_sha256: inputHash(selectedSource), source_set_sha256: setHash([
        { relativePath: selectedPath, sourceCode: selectedSource }, { relativePath: siblingPath, sourceCode: siblingSource },
      ]), selected_path: selectedPath,
      files: [
        { relative_path: selectedPath, source_sha256: inputHash(selectedSource) },
        { relative_path: siblingPath, source_sha256: inputHash(siblingSource) },
      ],
      bindings: [{ id: bindingId, name: 'normalize', kind: 'package function', scopeType: 'package', declarationStart: 20, referenceCount: 1, relativePath: selectedPath, exported: false }],
      truncated: false, parser_version: 'go1.24.4',
      inventory: { ...inventoryPayload, local_symbol_count: 2 },
    }))
    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'suggest', unitId: 'unit-a', providerId: 'provider-1', sourceCode: selectedSource, crossFileGo: true }),
    }), routeParams)

    expect(response.status).toBe(500)
    expect(h.attemptCreate).not.toHaveBeenCalled()
  })

  it('rejects edit manifests that do not reconstruct the helper output from exact input bytes', async () => {
    const validAgentFetch = h.agentFetch.getMockImplementation()
    if (!validAgentFetch) throw new Error('Expected the Go project helper fixture')
    h.agentFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await validAgentFetch(url, init)
      const payload = await response.json() as Record<string, unknown>
      if (url === '/reamon/code/go/refactor' && JSON.parse(String(init.body)).operation === 'project_rename') {
        const files = payload.files as Array<{ edits: Array<{ start: number; end: number; old_text: string }> }>
        files[0].edits[0] = { ...files[0].edits[0], start: 0 }
      }
      return jsonResponse(payload)
    })
    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'apply', unitId: 'unit-a', providerId: 'provider-1', sourceCode: selectedSource,
        expectedSha256: inputHash(selectedSource), suggestionAttemptId: 'proposal-1', crossFileGo: true,
        renames: [{ bindingId, oldName: 'normalize', newName: 'scale', rationale: 'clearer name' }],
      }),
    }), routeParams)

    expect(response.status).toBe(500)
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.txAttemptCreate).not.toHaveBeenCalled()
  })
})
