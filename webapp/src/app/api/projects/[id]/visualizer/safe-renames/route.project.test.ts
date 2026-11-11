/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), observationFindFirst: vi.fn(), observationFindMany: vi.fn(),
  artifactFindFirst: vi.fn(), artifactFindMany: vi.fn(), maintainedFindMany: vi.fn(), reviewFindMany: vi.fn(), attemptFindFirst: vi.fn(),
  providerFindFirst: vi.fn(), agentFetch: vi.fn(), root: vi.fn(), resolvePath: vi.fn(), transaction: vi.fn(), attemptCreate: vi.fn(), attemptFindMany: vi.fn(),
  txAttemptCreate: vi.fn(), txDraftCreate: vi.fn(),
}))

vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccessStrict: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/reamon/derived-storage', () => ({ derivedArtifactRoot: h.root, resolveDerivedArtifactPath: h.resolvePath }))
vi.mock('@/lib/reamon/artifact-storage', () => ({ resolveArtifactStoragePath: (value: string) => value }))
vi.mock('@/lib/agentFetch', () => ({ agentFetch: h.agentFetch }))
vi.mock('@/lib/prisma', () => ({ default: {
  reamonObservation: { findFirst: h.observationFindFirst, findMany: h.observationFindMany },
  artifact: { findFirst: h.artifactFindFirst, findMany: h.artifactFindMany },
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
const methodBindingId = 'fedcba9876543210fedcba98'
const importAliasBindingId = '1234567890abcdef12345678'
const inventoryPayload = {
  scope: 'reviewed-same-directory-go-package-source-snapshot', source_file_count: 2,
  private_package_symbol_count: 2, referenced_private_package_symbols: 1, unreferenced_private_symbols: 1,
  exported_package_symbol_count: 0, unsupported_package_symbol_count: 0, rename_binding_catalog_truncated: false,
  file_scope_symbol_count: 1, referenced_file_scope_symbols: 1, unreferenced_file_scope_symbols: 0, unsupported_file_scope_symbol_count: 0,
  local_symbol_count: 2, referenced_local_symbols: 2, unreferenced_local_symbols: 0, unsupported_local_symbol_count: 0,
  member_symbol_count: 1, unsupported_member_symbol_count: 1,
  entry_count: 6, entries_truncated: false,
  entries: [
    { id: bindingId, name: 'normalize', kind: 'package function', scope: 'package', relativePath: selectedPath, declarationStart: 20, referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'private-package-symbol-with-resolved-references', nameAssessment: 'unassessed' },
    { id: 'abcdef0123456789abcdef01', name: 'run', kind: 'package function', scope: 'package', relativePath: siblingPath, declarationStart: 20, referenceCount: 0, exported: false, classification: 'excluded', classificationReason: 'unreferenced-package-symbol', nameAssessment: 'unassessed' },
    { id: '102132435465768798a9bacb', name: 'formatter', kind: 'file import alias', scope: 'file', relativePath: selectedPath, declarationStart: 0, referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'file-import-alias-with-resolved-references', nameAssessment: 'unassessed' },
    { id: '00112233445566778899aabb', name: 'value', kind: 'local variable', scope: 'local', relativePath: selectedPath, declarationStart: selectedSource.indexOf('value int'), referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'local-symbol-with-resolved-references', nameAssessment: 'unassessed' },
    { id: '8899aabbccddeeff00112233', name: 'item', kind: 'local type-switch variable', scope: 'local', relativePath: selectedPath, declarationStart: selectedSource.indexOf('func normalize'), referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'local-symbol-with-resolved-references', nameAssessment: 'unassessed' },
    { id: 'fedcba9876543210fedcba98', name: 'field', kind: 'struct field', scope: 'member', relativePath: selectedPath, declarationStart: 20, referenceCount: 1, exported: false, classification: 'unsupported', classificationReason: 'go-member-not-offered-by-project-inventory', nameAssessment: 'unassessed' },
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
const inventoryScopeHash = (files: Array<{ relativePath: string; sourceCode: string }>, module = { moduleRoot: '', modulePath: '', manifestSha256: '', sumSha256: '' }) => createHash('sha256')
  .update('reamon-go-project-inventory-v2\0').update(setHash(files)).update('\0')
  .update(module.moduleRoot).update('\0').update(module.modulePath).update('\0').update(module.manifestSha256).update('\0').update(module.sumSha256).digest('hex')
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
  h.artifactFindMany.mockResolvedValue([])
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
      ]), goProjectInventorySourceSetSha256: inventoryScopeHash([
        { relativePath: selectedPath, sourceCode: selectedSource }, { relativePath: siblingPath, sourceCode: siblingSource },
      ]), goProjectModulePath: '', goProjectModuleRoot: '', goProjectModuleManifestSha256: '', goProjectModuleSumSha256: '', goSelectedPath: selectedPath,
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
        bindings: [
          { id: bindingId, name: 'normalize', kind: 'package function', scopeType: 'package', declarationStart: 20, referenceCount: 1, relativePath: selectedPath, exported: false },
          { id: methodBindingId, name: 'execute', kind: 'method', scopeType: 'member', declarationStart: 30, referenceCount: 1, relativePath: selectedPath, exported: false },
        ],
        truncated: false, parser_version: 'go1.24.4',
        inventory: inventoryPayload,
      })
    }
    if (body.operation === 'project_inventory') {
      const files = [{ relativePath: selectedPath, sourceCode: selectedSource }, { relativePath: siblingPath, sourceCode: siblingSource }]
      return jsonResponse({
        source_sha256: inputHash(selectedSource), source_set_sha256: setHash(files), selected_path: selectedPath,
        module_path: body.module_path, module_root: body.module_root,
        go_mod_sha256: body.go_mod_sha256, go_sum_sha256: body.go_sum_sha256,
        files: files.map((file) => ({ relative_path: file.relativePath, source_sha256: inputHash(file.sourceCode) })),
        packages: [{ directory: 'pkg', package_name: 'sample', source_file_count: 2, source_set_sha256: setHash(files) }],
        parser_version: 'go1.24.4',
        inventory: { ...inventoryPayload, scope: 'verified-whole-project-go-source-snapshot', complete: true, package_count: 1, rename_binding_catalog_truncated: undefined },
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
  it('accepts and proposes a referenced explicit import alias from the Go helper catalog', async () => {
    const baseImplementation = h.agentFetch.getMockImplementation()
    if (!baseImplementation) throw new Error('Expected the Go project helper fixture')
    h.agentFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>
      if (url === '/reamon/code/go/refactor' && request.operation === 'project_bindings') {
        const response = await baseImplementation(url, init)
        const payload = await response.json() as Record<string, unknown>
        return jsonResponse({ ...payload, bindings: [
          ...(payload.bindings as Array<Record<string, unknown>>),
          { id: importAliasBindingId, name: 'f', kind: 'file import alias', scopeType: 'file', declarationStart: 20, referenceCount: 1, relativePath: selectedPath, exported: false },
        ] })
      }
      if (url === '/reamon/code/suggest-renames') {
        const requestBindings = (request.bindings as Array<Record<string, unknown>>) || []
        expect(requestBindings).toContainEqual(expect.objectContaining({ id: importAliasBindingId, name: 'f', kind: 'file import alias', scopeType: 'file' }))
        return jsonResponse({ renames: [{ bindingId: importAliasBindingId, oldName: 'f', newName: 'format', rationale: 'clarify the formatter package alias' }] })
      }
      return baseImplementation(url, init)
    })

    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'suggest', unitId: 'unit-a', providerId: 'provider-1', sourceCode: selectedSource, crossFileGo: true }),
    }), routeParams)

    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.renames).toEqual([expect.objectContaining({ bindingId: importAliasBindingId, oldName: 'f', newName: 'format', kind: 'file import alias' })])
  })

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
      scope: 'verified-whole-project-go-source-snapshot', complete: true, packageCount: 1, sourceFileCount: 2,
      privatePackageSymbolCount: 2, referencedPrivatePackageSymbols: 1, unreferencedPrivateSymbols: 1,
      fileScopeSymbolCount: 1, referencedFileScopeSymbols: 1, unreferencedFileScopeSymbols: 0, unsupportedFileScopeSymbolCount: 0,
      localSymbolCount: 2, referencedLocalSymbols: 2, unreferencedLocalSymbols: 0, unsupportedLocalSymbolCount: 0,
      memberSymbolCount: 1, unsupportedMemberSymbolCount: 1,
      exportedPackageSymbolCount: 0, unsupportedPackageSymbolCount: 0, renameBindingCatalogTruncated: false,
      entryCount: 6, entriesTruncated: false,
      entries: expect.arrayContaining([
        expect.objectContaining({ name: 'normalize', scope: 'package', classification: 'eligible', nameAssessment: 'unassessed' }),
        expect.objectContaining({ name: 'run', scope: 'package', classification: 'excluded', classificationReason: 'unreferenced-package-symbol' }),
        expect.objectContaining({ name: 'formatter', scope: 'file', kind: 'file import alias', classification: 'eligible' }),
        expect.objectContaining({ name: 'value', scope: 'local', classification: 'eligible', classificationReason: 'local-symbol-with-resolved-references' }),
        expect.objectContaining({ name: 'item', kind: 'local type-switch variable', scope: 'local', classification: 'eligible' }),
        expect.objectContaining({ name: 'field', kind: 'struct field', scope: 'member', classification: 'unsupported', classificationReason: 'go-member-not-offered-by-project-inventory' }),
      ]),
    })
    expect(h.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ requestPayload: expect.objectContaining({
        goProjectInventory: body.projectInventory,
      }) }),
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

  it('keeps package rename available when a wider project inventory cannot be verified', async () => {
    const baseImplementation = h.agentFetch.getMockImplementation()
    if (!baseImplementation) throw new Error('Expected the Go project helper fixture')
    h.agentFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>
      if (request.operation === 'project_inventory') {
        return new Response(JSON.stringify({ error: 'cannot inventory Go package cmd: unresolved import' }), { status: 422 })
      }
      return baseImplementation(url, init)
    })

    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'suggest', unitId: 'unit-a', providerId: 'provider-1', sourceCode: selectedSource, crossFileGo: true }),
    }), routeParams)

    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.projectInventory).toMatchObject({ scope: 'reviewed-same-directory-go-package-source-snapshot', sourceFileCount: 2 })
    expect(body.projectInventoryError).toContain('unresolved import')
    expect(h.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ requestPayload: expect.objectContaining({ goProjectInventoryError: expect.stringContaining('unresolved import') }) }),
    }))
  })

  it('uses the hash-verified workspace go.mod to resolve the project module path', async () => {
    const goMod = 'module example.test/project\n\ngo 1.24\n'
    const goSum = 'example.test/dep v1.0.0 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n'
    const manifestPath = path.join(root, 'pkg', 'go.mod')
    const sumPath = path.join(root, 'pkg', 'go.sum')
    await mkdir(path.dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, goMod)
    await writeFile(sumPath, goSum)
    h.artifactFindMany.mockResolvedValue([{
      relativePath: 'pkg/go.mod', storagePath: manifestPath, sizeBytes: BigInt(Buffer.byteLength(goMod)), sha256: inputHash(goMod),
    }])
    h.artifactFindFirst.mockResolvedValueOnce({ id: 'artifact-1', sha256: 'a'.repeat(64) }).mockResolvedValueOnce({
      storagePath: sumPath, sizeBytes: BigInt(Buffer.byteLength(goSum)), sha256: inputHash(goSum),
    })

    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'suggest', unitId: 'unit-a', providerId: 'provider-1', sourceCode: selectedSource, crossFileGo: true }),
    }), routeParams)

    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    const inventoryRequest = h.agentFetch.mock.calls
      .map((call: Array<unknown>) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>)
      .find((request) => request.operation === 'project_inventory')
    expect(inventoryRequest).toMatchObject({
      module_path: 'example.test/project', module_root: 'pkg', go_mod: goMod, go_mod_sha256: inputHash(goMod), go_sum: goSum, go_sum_sha256: inputHash(goSum),
    })
    expect(h.attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ requestPayload: expect.objectContaining({
        goProjectModulePath: 'example.test/project', goProjectModuleRoot: 'pkg', goProjectModuleManifestSha256: inputHash(goMod), goProjectModuleSumSha256: inputHash(goSum),
      }) }),
    }))
  })

  it('aggregates the verified project inventory across separate Go package directories', async () => {
    const cmdSource = 'package cmd\nfunc runCmd() int { return 1 }\n'
    const cmdPath = 'cmd/run.go'
    const cmdCodeArtifactId = `project-1/artifact-1/task-1/run-1/sources/${cmdPath}`
    await mkdir(path.dirname(path.join(root, cmdCodeArtifactId)), { recursive: true })
    await writeFile(path.join(root, cmdCodeArtifactId), cmdSource)
    h.observationFindMany.mockResolvedValue([
      { id: 'unit-a', label: 'pkg.a', attributes: { language: 'Go', relativePath: selectedPath, qualifiedName: 'pkg.a', codeArtifactId: selectedCodeArtifactId } },
      { id: 'unit-b', label: 'pkg.b', attributes: { language: 'Go', relativePath: siblingPath, qualifiedName: 'pkg.b', codeArtifactId: siblingCodeArtifactId } },
      { id: 'unit-c', label: 'cmd.run', attributes: { language: 'Go', relativePath: cmdPath, qualifiedName: 'cmd.run', codeArtifactId: cmdCodeArtifactId } },
    ])
    h.maintainedFindMany.mockResolvedValue([
      { codeUnitId: 'unit-b', sourceCode: siblingSource, sourceHash: inputHash(siblingSource), acceptedReviewId: 'review-b', relativePath: siblingPath },
      { codeUnitId: 'unit-c', sourceCode: cmdSource, sourceHash: inputHash(cmdSource), acceptedReviewId: 'review-c', relativePath: cmdPath },
    ])
    h.reviewFindMany.mockResolvedValue([
      { id: 'review-b', codeUnitId: 'unit-b', artifactId: 'artifact-1', maintainedSourceHash: inputHash(siblingSource), decision: 'ACCEPTED' },
      { id: 'review-c', codeUnitId: 'unit-c', artifactId: 'artifact-1', maintainedSourceHash: inputHash(cmdSource), decision: 'ACCEPTED' },
    ])
    const baseImplementation = h.agentFetch.getMockImplementation()
    if (!baseImplementation) throw new Error('Expected the Go project helper fixture')
    h.agentFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>
      if (request.operation !== 'project_inventory') return baseImplementation(url, init)
      const files = request.files as Array<{ relative_path: string; source_code: string }>
      const allFiles = files.map((file) => ({ relativePath: file.relative_path, sourceCode: file.source_code }))
      const packageFiles = allFiles.filter((file) => file.relativePath.startsWith('pkg/'))
      const cmdFiles = allFiles.filter((file) => file.relativePath.startsWith('cmd/'))
      return jsonResponse({
        source_sha256: inputHash(selectedSource), source_set_sha256: setHash(allFiles), selected_path: selectedPath,
        module_path: request.module_path, module_root: request.module_root,
        go_mod_sha256: request.go_mod_sha256, go_sum_sha256: request.go_sum_sha256,
        files: allFiles.map((file) => ({ relative_path: file.relativePath, source_sha256: inputHash(file.sourceCode) })),
        packages: [
          { directory: 'cmd', package_name: 'cmd', source_file_count: 1, source_set_sha256: setHash(cmdFiles) },
          { directory: 'pkg', package_name: 'sample', source_file_count: 2, source_set_sha256: setHash(packageFiles) },
        ],
        parser_version: 'go1.24.4',
        inventory: {
          ...inventoryPayload,
          scope: 'verified-whole-project-go-source-snapshot', complete: true,
          source_file_count: 3, package_count: 2, private_package_symbol_count: 3,
          unreferenced_private_symbols: 2, entry_count: 7,
          entries: [...inventoryPayload.entries, {
            id: 'ffeeddccbbaa998877665544', name: 'runCmd', kind: 'package function', scope: 'package', relativePath: cmdPath,
            declarationStart: 20, referenceCount: 0, exported: false, classification: 'excluded',
            classificationReason: 'unreferenced-package-symbol', nameAssessment: 'unassessed',
          }],
        },
      })
    })

    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'suggest', unitId: 'unit-a', providerId: 'provider-1', sourceCode: selectedSource, crossFileGo: true }),
    }), routeParams)

    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.projectInventory).toMatchObject({
      scope: 'verified-whole-project-go-source-snapshot', complete: true, sourceFileCount: 3, packageCount: 2,
      privatePackageSymbolCount: 3, unreferencedPrivateSymbols: 2, entryCount: 7,
      entries: expect.arrayContaining([expect.objectContaining({ name: 'runCmd', relativePath: cmdPath, classification: 'excluded' })]),
    })
    expect(body.projectInventorySourceSetSha256).toBe(inventoryScopeHash([
      { relativePath: selectedPath, sourceCode: selectedSource },
      { relativePath: siblingPath, sourceCode: siblingSource },
      { relativePath: cmdPath, sourceCode: cmdSource },
    ]))
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

  it('suggests and applies an exported method rename across a verified module snapshot', async () => {
    const moduleGoMod = 'module example.test/app\n\ngo 1.25\n'
    const moduleGoSum = 'example.test/dep v1.0.0 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n'
    const moduleSelectedSource = 'package pkg\nimport tx "strings"\ntype Worker struct{}\nfunc (Worker) Do() int { return len(tx.TrimSpace(tx.Join([]string{"a", "b"}, "-"))) }\n'
    const moduleSiblingSource = 'package pkg\nfunc local() int { return Worker{}.Do() }\n'
    const commandSource = 'package main\nimport "example.test/app/pkg"\nfunc Run() int { return pkg.Worker{}.Do() }\nfunc Expr() func(pkg.Worker) int { return pkg.Worker.Do }\n'
    const largeProjectSource = `package pkg\n//${'x'.repeat(512 * 1024 + 1)}\n`
    const commandPath = 'cmd/main.go'
    const largeProjectPath = 'pkg/generated.go'
    const commandCodeArtifactId = `project-1/artifact-1/task-1/run-1/sources/${commandPath}`
    const largeProjectCodeArtifactId = `project-1/artifact-1/task-1/run-1/sources/${largeProjectPath}`
    const moduleFiles = [
      { relativePath: selectedPath, sourceCode: moduleSelectedSource },
      { relativePath: siblingPath, sourceCode: moduleSiblingSource },
      { relativePath: commandPath, sourceCode: commandSource },
      { relativePath: largeProjectPath, sourceCode: largeProjectSource },
    ]
    const manifestPath = path.join(root, 'go.mod')
    const sumPath = path.join(root, 'go.sum')
    await mkdir(path.dirname(path.join(root, commandCodeArtifactId)), { recursive: true })
    await writeFile(path.join(root, selectedCodeArtifactId), moduleSelectedSource)
    await writeFile(path.join(root, siblingCodeArtifactId), moduleSiblingSource)
    await writeFile(path.join(root, commandCodeArtifactId), commandSource)
    await mkdir(path.dirname(path.join(root, largeProjectCodeArtifactId)), { recursive: true })
    await writeFile(path.join(root, largeProjectCodeArtifactId), largeProjectSource)
    await writeFile(manifestPath, moduleGoMod)
    await writeFile(sumPath, moduleGoSum)
    h.observationFindMany.mockResolvedValueOnce([
      { id: 'unit-a', label: 'pkg.a', attributes: { language: 'Go', relativePath: selectedPath, qualifiedName: 'pkg.a', codeArtifactId: selectedCodeArtifactId } },
      { id: 'unit-b', label: 'pkg.b', attributes: { language: 'Go', relativePath: siblingPath, qualifiedName: 'pkg.b', codeArtifactId: siblingCodeArtifactId } },
      { id: 'unit-c', label: 'cmd.main', attributes: { language: 'Go', relativePath: commandPath, qualifiedName: 'cmd.main', codeArtifactId: commandCodeArtifactId } },
      { id: 'unit-d', label: 'pkg.generated', attributes: { language: 'Go', relativePath: largeProjectPath, qualifiedName: 'pkg.generated', codeArtifactId: largeProjectCodeArtifactId } },
    ])
    h.maintainedFindMany.mockResolvedValueOnce([
      { codeUnitId: 'unit-b', sourceCode: moduleSiblingSource, sourceHash: inputHash(moduleSiblingSource), acceptedReviewId: 'review-b', relativePath: siblingPath },
      { codeUnitId: 'unit-c', sourceCode: commandSource, sourceHash: inputHash(commandSource), acceptedReviewId: 'review-c', relativePath: commandPath },
      { codeUnitId: 'unit-d', sourceCode: largeProjectSource, sourceHash: inputHash(largeProjectSource), acceptedReviewId: 'review-d', relativePath: largeProjectPath },
    ])
    h.reviewFindMany.mockResolvedValueOnce([
      { id: 'review-b', codeUnitId: 'unit-b', artifactId: 'artifact-1', maintainedSourceHash: inputHash(moduleSiblingSource), decision: 'ACCEPTED' },
      { id: 'review-c', codeUnitId: 'unit-c', artifactId: 'artifact-1', maintainedSourceHash: inputHash(commandSource), decision: 'ACCEPTED' },
      { id: 'review-d', codeUnitId: 'unit-d', artifactId: 'artifact-1', maintainedSourceHash: inputHash(largeProjectSource), decision: 'ACCEPTED' },
    ])
    h.artifactFindMany.mockResolvedValueOnce([{
      relativePath: 'go.mod', storagePath: manifestPath, sizeBytes: BigInt(Buffer.byteLength(moduleGoMod)), sha256: inputHash(moduleGoMod),
    }])
    h.artifactFindFirst.mockResolvedValueOnce({ id: 'artifact-1', sha256: 'a'.repeat(64) }).mockResolvedValueOnce({
      storagePath: sumPath, sizeBytes: BigInt(Buffer.byteLength(moduleGoSum)), sha256: inputHash(moduleGoSum),
    })

    const moduleInventory = {
      scope: 'verified-whole-project-go-source-snapshot', complete: true,
      source_file_count: 4, package_count: 2,
      private_package_symbol_count: 0, referenced_private_package_symbols: 0, unreferenced_private_symbols: 0,
      exported_package_symbol_count: 0, unsupported_package_symbol_count: 0,
      file_scope_symbol_count: 2, referenced_file_scope_symbols: 2, unreferenced_file_scope_symbols: 0, unsupported_file_scope_symbol_count: 0,
      local_symbol_count: 0, referenced_local_symbols: 0, unreferenced_local_symbols: 0, unsupported_local_symbol_count: 0,
      member_symbol_count: 1, unsupported_member_symbol_count: 1, entry_count: 3, entries_truncated: false,
      entries: [
        { id: importAliasBindingId, name: 'tx', kind: 'file import alias', scope: 'file', relativePath: selectedPath,
          declarationStart: moduleSelectedSource.indexOf('tx'), referenceCount: 2, exported: false,
          classification: 'eligible', classificationReason: 'file-import-alias-with-resolved-references', nameAssessment: 'unassessed' },
        { id: 'acbd1234567890efacbd1234', name: 'pkg', kind: 'file import alias', scope: 'file', relativePath: commandPath,
          declarationStart: commandSource.indexOf('pkg'), referenceCount: 3, exported: false,
          classification: 'eligible', classificationReason: 'file-import-alias-with-resolved-references', nameAssessment: 'unassessed' },
        { id: methodBindingId, name: 'Do', kind: 'method', scope: 'member', relativePath: selectedPath,
        declarationStart: moduleSelectedSource.indexOf('Do'), referenceCount: 3, exported: true,
        classification: 'unsupported', classificationReason: 'go-member-not-offered-by-project-inventory', nameAssessment: 'unassessed' },
      ],
    }
    const outputFiles = moduleFiles.map((file) => {
      const sourceCode = file.sourceCode.replaceAll('Do', 'Serve')
      const edits: Array<{ start: number; end: number; old_text: string; new_text: string }> = []
      let offset = 0
      while ((offset = file.sourceCode.indexOf('Do', offset)) >= 0) {
        edits.push({ start: offset, end: offset + 2, old_text: 'Do', new_text: 'Serve' })
        offset += 2
      }
      return { ...file, sourceCode, edits }
    })
    const inventoryScope = inventoryScopeHash(moduleFiles, {
      moduleRoot: '', modulePath: 'example.test/app', manifestSha256: inputHash(moduleGoMod), sumSha256: inputHash(moduleGoSum),
    })
    const baseImplementation = h.agentFetch.getMockImplementation()
    const receivedLargeProjectSnapshot = { value: false }
    if (!baseImplementation) throw new Error('Expected the Go project helper fixture')
    h.agentFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, any>
      const files = (request.files as Array<{ relative_path: string; source_code: string }> | undefined) ?? []
      const parsedFiles = files.map((file) => ({ relativePath: file.relative_path, sourceCode: file.source_code }))
      if (request.operation === 'project_module_bindings') return jsonResponse({
        scope: 'verified-go-module-source-snapshot', selected_path: selectedPath,
        source_sha256: inputHash(moduleSelectedSource), source_set_sha256: setHash(moduleFiles), inventory_scope_sha256: inventoryScope,
        files: [...moduleFiles].sort((left, right) => left.relativePath.localeCompare(right.relativePath)).map((file) => ({ relative_path: file.relativePath, source_sha256: inputHash(file.sourceCode) })),
        bindings: [
          { id: methodBindingId, name: 'Do', kind: 'method', scopeType: 'member', relativePath: selectedPath,
            declarationStart: moduleSelectedSource.indexOf('Do'), referenceCount: 3, exported: true },
          { id: importAliasBindingId, name: 'tx', kind: 'file import alias', scopeType: 'file', relativePath: selectedPath,
            declarationStart: moduleSelectedSource.indexOf('tx'), referenceCount: 2, exported: false },
        ],
        truncated: false, parser_version: 'go1.25.0',
      })
      if (request.operation === 'project_inventory') {
        receivedLargeProjectSnapshot.value = parsedFiles.some((file) => file.relativePath === largeProjectPath && file.sourceCode === largeProjectSource)
        const packageFiles = (directory: string) => parsedFiles.filter((file) => file.relativePath.startsWith(`${directory}/`))
        return jsonResponse({
          source_sha256: inputHash(moduleSelectedSource), source_set_sha256: setHash(moduleFiles), selected_path: selectedPath,
          module_path: request.module_path, module_root: request.module_root,
          go_mod_sha256: request.go_mod_sha256, go_sum_sha256: request.go_sum_sha256,
          files: [...moduleFiles].sort((left, right) => left.relativePath.localeCompare(right.relativePath)).map((file) => ({ relative_path: file.relativePath, source_sha256: inputHash(file.sourceCode) })),
          packages: [
            { directory: 'cmd', package_name: 'main', source_file_count: 1, source_set_sha256: setHash(packageFiles('cmd')) },
            { directory: 'pkg', package_name: 'pkg', source_file_count: 3, source_set_sha256: setHash(packageFiles('pkg')) },
          ], inventory: moduleInventory, parser_version: 'go1.25.0',
        })
      }
      if (request.operation === 'project_module_rename') return jsonResponse({
        scope: 'module', source_sha256: inputHash(moduleSelectedSource), source_set_sha256: setHash(moduleFiles),
        inventory_scope_sha256: inventoryScope, output_inventory_scope_sha256: 'c'.repeat(64),
        output_source_set_sha256: setHash(outputFiles), output_sha256: inputHash(outputFiles[0].sourceCode),
        source_code: outputFiles[0].sourceCode, parser_version: 'go1.25.0',
        renamed_bindings: [{ bindingId: methodBindingId, oldName: 'Do', newName: 'Serve', kind: 'method', referenceCount: 3, scopeType: 'member', exported: true }],
        files: outputFiles.filter((file) => file.edits.length > 0).map((file) => {
          const original = moduleFiles.find((item) => item.relativePath === file.relativePath)!
          return {
            relative_path: file.relativePath, input_sha256: inputHash(original.sourceCode), output_sha256: inputHash(file.sourceCode),
            source_code: file.sourceCode, edits: file.edits,
          }
        }),
      })
      if (url === '/reamon/code/suggest-renames') {
        expect(request.allow_exported_go_methods).toBe(true)
        expect(request.bindings).toContainEqual(expect.objectContaining({ id: methodBindingId, exported: true }))
        expect(request.bindings).toContainEqual(expect.objectContaining({ id: importAliasBindingId, name: 'tx', kind: 'file import alias', scopeType: 'file' }))
        return jsonResponse({ renames: [
          { bindingId: methodBindingId, oldName: 'Do', newName: 'Serve', rationale: 'clear public method name' },
          { bindingId: importAliasBindingId, oldName: 'tx', newName: 'textutil', rationale: 'clarify package alias' },
        ] })
      }
      return baseImplementation(url, init)
    })

    const suggestResponse = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'suggest', unitId: 'unit-a', providerId: 'provider-1', sourceCode: moduleSelectedSource, moduleGo: true }),
    }), routeParams)
    const suggestions = await suggestResponse.json()
    expect(suggestResponse.status, JSON.stringify(suggestions)).toBe(200)
    expect(receivedLargeProjectSnapshot.value).toBe(true)
    expect(suggestions).toMatchObject({ scope: 'module', sourceSetSha256: setHash(moduleFiles), projectInventory: { sourceFileCount: 4, packageCount: 2 }, renames: [
      { oldName: 'Do', newName: 'Serve' }, { oldName: 'tx', newName: 'textutil', kind: 'file import alias' },
    ] })
    const savedProposal = h.attemptCreate.mock.calls[0]?.[0].data.requestPayload
    expect(savedProposal).toMatchObject({ goProjectScope: true, goModuleScope: true, goModuleInventoryScopeSha256: inventoryScope })

    // Apply must reload current source and module receipts independently of the proposal request.
    h.observationFindMany.mockResolvedValue([
      { id: 'unit-a', label: 'pkg.a', attributes: { language: 'Go', relativePath: selectedPath, qualifiedName: 'pkg.a', codeArtifactId: selectedCodeArtifactId } },
      { id: 'unit-b', label: 'pkg.b', attributes: { language: 'Go', relativePath: siblingPath, qualifiedName: 'pkg.b', codeArtifactId: siblingCodeArtifactId } },
      { id: 'unit-c', label: 'cmd.main', attributes: { language: 'Go', relativePath: commandPath, qualifiedName: 'cmd.main', codeArtifactId: commandCodeArtifactId } },
      { id: 'unit-d', label: 'pkg.generated', attributes: { language: 'Go', relativePath: largeProjectPath, qualifiedName: 'pkg.generated', codeArtifactId: largeProjectCodeArtifactId } },
    ])
    h.maintainedFindMany.mockResolvedValue([
      { codeUnitId: 'unit-b', sourceCode: moduleSiblingSource, sourceHash: inputHash(moduleSiblingSource), acceptedReviewId: 'review-b', relativePath: siblingPath },
      { codeUnitId: 'unit-c', sourceCode: commandSource, sourceHash: inputHash(commandSource), acceptedReviewId: 'review-c', relativePath: commandPath },
      { codeUnitId: 'unit-d', sourceCode: largeProjectSource, sourceHash: inputHash(largeProjectSource), acceptedReviewId: 'review-d', relativePath: largeProjectPath },
    ])
    h.reviewFindMany.mockResolvedValue([
      { id: 'review-b', codeUnitId: 'unit-b', artifactId: 'artifact-1', maintainedSourceHash: inputHash(moduleSiblingSource), decision: 'ACCEPTED' },
      { id: 'review-c', codeUnitId: 'unit-c', artifactId: 'artifact-1', maintainedSourceHash: inputHash(commandSource), decision: 'ACCEPTED' },
      { id: 'review-d', codeUnitId: 'unit-d', artifactId: 'artifact-1', maintainedSourceHash: inputHash(largeProjectSource), decision: 'ACCEPTED' },
    ])
    h.artifactFindMany.mockResolvedValue([{
      relativePath: 'go.mod', storagePath: manifestPath, sizeBytes: BigInt(Buffer.byteLength(moduleGoMod)), sha256: inputHash(moduleGoMod),
    }])
    h.artifactFindFirst.mockResolvedValueOnce({ id: 'artifact-1', sha256: 'a'.repeat(64) }).mockResolvedValueOnce({
      storagePath: sumPath, sizeBytes: BigInt(Buffer.byteLength(moduleGoSum)), sha256: inputHash(moduleGoSum),
    })
    h.attemptFindFirst.mockResolvedValue({ id: 'suggestion-attempt-1', requestPayload: savedProposal })
    const applyResponse = await POST(new Request('http://localhost/api/projects/project-1/visualizer/safe-renames', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'apply', unitId: 'unit-a', providerId: 'provider-1', sourceCode: moduleSelectedSource,
        expectedSha256: inputHash(moduleSelectedSource), suggestionAttemptId: 'suggestion-attempt-1', moduleGo: true,
        renames: [{ bindingId: methodBindingId, oldName: 'Do', newName: 'Serve', rationale: 'clear public method name' }],
      }),
    }), routeParams)
    const applied = await applyResponse.json()
    expect(applyResponse.status, JSON.stringify(applied)).toBe(200)
    expect(applied).toMatchObject({ sourceCode: outputFiles[0].sourceCode, sourceSetSha256: setHash(moduleFiles), outputSourceSetSha256: setHash(outputFiles) })
    expect(applied.projectChanges.map((change: { relativePath: string }) => change.relativePath).sort()).toEqual([selectedPath, siblingPath, commandPath].sort())
    expect(h.txDraftCreate).toHaveBeenCalledTimes(3)
    expect(h.txDraftCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      codeUnitId: 'unit-c', sourceCode: outputFiles[2].sourceCode, validationMethod: 'go1.25.0+go-types-module-binding-identity',
    }) }))
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
      inventory: { ...inventoryPayload, local_symbol_count: 3 },
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
