/** @vitest-environment node */
/**
 * Opt-in PostgreSQL acceptance for Go rename persistence. Synthetic project
 * rows use controlled helper responses; the optional real-helper path is
 * limited to the same-package case and resolves a hash-verified offline module.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import prisma from '@/lib/prisma'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(), getActiveWorkspaceImportSelection: vi.fn(), agentFetch: vi.fn(),
  moduleAliasSelectedSource: 'package sample\nimport val "example.test/dep"\nfunc fn(value int) int { return val.Value + value }\n',
}))

vi.mock('@/lib/access', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/access')>(),
  requireEffectiveUser: mocks.requireEffectiveUser,
}))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: mocks.getActiveWorkspaceImportSelection }))
vi.mock('@/lib/agentFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agentFetch')>()
  return {
    ...actual,
    agentFetch: (...args: Parameters<typeof actual.agentFetch>) => {
      const payload = JSON.parse(String(args[1]?.body ?? '{}')) as { operation?: string; source_code?: string }
      const moduleAliasFixture = payload.source_code === mocks.moduleAliasSelectedSource
      const realHelperOperation = ['project_bindings', 'project_inventory', 'project_rename'].includes(String(payload.operation))
      if (process.env.REAMON_GO_PACKAGE_RENAME_REAL_HELPER === '1'
          && args[0] === '/reamon/code/go/refactor' && realHelperOperation && !moduleAliasFixture) {
        return actual.agentFetch(...args)
      }
      return mocks.agentFetch(...args)
    },
  }
})

import { POST } from './route'
import { GET as getDraft } from '../drafts/[unitId]/route'

const enabled = process.env.REAMON_GO_PACKAGE_RENAME_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL)
const selectedPath = 'pkg/a.go'
const siblingPath = 'pkg/b.go'
const fixtureBindingId = '0123456789abcdef01234567'
const importAliasBindingId = 'abcdef0123456789abcdef02'
const localValueBindingId = 'abcdef0123456789abcdef03'
const moduleSelectedAliasId = '102132435465768798a9bacb'
const moduleSiblingAliasId = '2031425364758697a8b9cadb'
let bindingId = fixtureBindingId
const selectedSource = 'package sample\nimport "example.test/dep"\nfunc fn(value int) int { return dep.Value + value }\n'
const siblingSource = 'package sample\nfunc run() int { return fn(1) }\n'
const selectedOutput = 'package sample\nimport "example.test/dep"\nfunc calculate(value int) int { return dep.Value + value }\n'
const siblingOutput = 'package sample\nfunc run() int { return calculate(1) }\n'
const moduleSelectedSource = mocks.moduleAliasSelectedSource
const moduleSiblingSource = 'package sample\nimport std "strings"\nfunc run() int { _ = std.TrimSpace(" value "); return fn(1) }\n'
const moduleSelectedOutput = 'package sample\nimport dependency "example.test/dep"\nfunc fn(value int) int { return dependency.Value + value }\n'
const moduleSiblingOutput = 'package sample\nimport stringutil "strings"\nfunc run() int { _ = stringutil.TrimSpace(" value "); return fn(1) }\n'
const goMod = 'module example.test/fixture\n\ngo 1.24\n\nrequire example.test/dep v1.0.0\n'
const goSum = 'example.test/dep v1.0.0 h1:aqAPJ79IhFh4gnRvXspeYBDRHGfQu8TL1+Fs8R2fybo=\nexample.test/dep v1.0.0/go.mod h1:yQJCP305QJqh3IcmpZtiFA1MO/Qi1d6SIprKBambzQA=\n'
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const sourceSetHash = (files: Array<{ relativePath: string; sourceCode: string }>) => {
  const digest = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)) {
    digest.update(file.relativePath).update('\0').update(hash(file.sourceCode)).update('\n')
  }
  return digest.digest('hex')
}

let projectId = ''
let ownerUserId = ''
let artifactId = ''
let taskId = ''
let providerId = ''
let selectedUnitId = ''
let siblingUnitId = ''
let siblingReviewId = ''
let artifactsDirectory = ''
let runKey = ''

function params(id = projectId) { return { params: Promise.resolve({ id }) } }

function renameRequest(operation: 'suggest' | 'apply', suggestionAttemptId?: string) {
  const body = operation === 'suggest'
    ? { operation, unitId: selectedUnitId, providerId, sourceCode: selectedSource, expectedSha256: hash(selectedSource), crossFileGo: true }
    : {
        operation, unitId: selectedUnitId, providerId, sourceCode: selectedSource,
        expectedSha256: hash(selectedSource), suggestionAttemptId, crossFileGo: true,
        renames: [{ bindingId, oldName: 'fn', newName: 'calculate', rationale: 'Use the operation name.' }],
      }
  return new Request(`http://localhost/api/projects/${projectId}/visualizer/safe-renames`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

function moduleAliasRequest(operation: 'suggest' | 'apply', suggestionAttemptId?: string) {
  const body = operation === 'suggest'
    ? { operation, unitId: selectedUnitId, providerId, sourceCode: moduleSelectedSource, expectedSha256: hash(moduleSelectedSource), moduleGo: true }
    : {
        operation, unitId: selectedUnitId, providerId, sourceCode: moduleSelectedSource,
        expectedSha256: hash(moduleSelectedSource), suggestionAttemptId, moduleGo: true,
        renames: [
          { bindingId: moduleSelectedAliasId, oldName: 'val', newName: 'dependency', rationale: 'Clarify the external package alias.' },
          { bindingId: moduleSiblingAliasId, oldName: 'std', newName: 'stringutil', rationale: 'Clarify the standard-library alias.' },
        ],
      }
  return new Request(`http://localhost/api/projects/${projectId}/visualizer/safe-renames`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe.skipIf(!enabled)('Go package rename against PostgreSQL', () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: `GoPackageRename-${randomUUID()}`, email: `go-package-rename-${randomUUID()}@example.test` },
      select: { id: true },
    })
    ownerUserId = user.id
    projectId = (await prisma.project.create({
      data: { userId: ownerUserId, name: `GoPackageRename-${randomUUID()}`, projectKind: 'REVERSE_ENGINEERING' },
      select: { id: true },
    })).id
    artifactsDirectory = await mkdtemp(path.join(os.tmpdir(), 'reamon-go-package-rename-db-'))
    vi.stubEnv('REAMON_DERIVED_PATH', artifactsDirectory)
    vi.stubEnv('REAMON_ARTIFACTS_PATH', artifactsDirectory)

    const artifact = await prisma.artifact.create({
      data: {
        projectId, name: 'go-package-fixture', originalName: 'go-package-fixture', relativePath: 'fixture.go',
        storagePath: 'not-read-by-this-route', sha256: hash(selectedSource), sizeBytes: BigInt(Buffer.byteLength(selectedSource)),
        extension: '.go', profile: { format: 'go-source' },
      },
      select: { id: true },
    })
    artifactId = artifact.id
    await writeFile(path.join(artifactsDirectory, 'go.mod'), goMod, 'utf8')
    await writeFile(path.join(artifactsDirectory, 'go.sum'), goSum, 'utf8')
    await prisma.artifact.create({
      data: {
        projectId, name: 'go.mod', originalName: 'go.mod', relativePath: 'go.mod', storagePath: 'go.mod',
        sha256: hash(goMod), sizeBytes: BigInt(Buffer.byteLength(goMod)), extension: '.mod',
      },
    })
    await prisma.artifact.create({
      data: {
        projectId, name: 'go.sum', originalName: 'go.sum', relativePath: 'go.sum', storagePath: 'go.sum',
        sha256: hash(goSum), sizeBytes: BigInt(Buffer.byteLength(goSum)), extension: '.sum',
      },
    })
    taskId = (await prisma.task.create({
      data: { projectId, artifactId, capability: 'decompile', title: 'Go package rename acceptance', status: 'COMPLETED' },
      select: { id: true },
    })).id
    runKey = `${projectId}/${artifactId}/${taskId}/run-1`

    const provider = await prisma.userLlmProvider.create({
      data: { userId: ownerUserId, providerType: 'openai_compatible', name: `GoPackageRename-${randomUUID()}`, modelIdentifier: 'test/rename-model' },
      select: { id: true },
    })
    providerId = provider.id

    const sourceRows = [
      { relativePath: selectedPath, source: selectedSource, stableKey: `selected-${randomUUID()}` },
      { relativePath: siblingPath, source: siblingSource, stableKey: `sibling-${randomUUID()}` },
    ]
    const unitIds: string[] = []
    for (const row of sourceRows) {
      const observation = await prisma.reamonObservation.create({
        data: {
          projectId, taskId, artifactId, kind: 'entity', type: 'code_unit',
          stableKey: row.stableKey, canonicalKey: row.stableKey, label: row.relativePath,
          source: `go-package-rename-integration-${randomUUID()}`,
          attributes: {
            language: 'Go', relativePath: row.relativePath, qualifiedName: row.relativePath,
            codeArtifactId: `${runKey}/sources/${row.relativePath}`,
          },
        },
        select: { id: true },
      })
      unitIds.push(observation.id)
      const sourceFile = path.join(artifactsDirectory, runKey, 'sources', row.relativePath)
      await mkdir(path.dirname(sourceFile), { recursive: true })
      await writeFile(sourceFile, row.source, 'utf8')
    }
    ;[selectedUnitId, siblingUnitId] = unitIds

    const review = await prisma.reamonCodeReview.create({
      data: {
        projectId, artifactId, codeUnitId: siblingUnitId, reviewerId: ownerUserId,
        decision: 'ACCEPTED', rationale: 'Synthetic accepted source for package rename acceptance.',
        maintainedSourceHash: hash(siblingSource),
      },
      select: { id: true },
    })
    siblingReviewId = review.id
    await prisma.reamonMaintainedSource.create({
      data: {
        projectId, artifactId, codeUnitId: siblingUnitId, unitName: siblingPath, language: 'Go',
        sourceCode: siblingSource, sourceHash: hash(siblingSource), acceptedReviewId: siblingReviewId, relativePath: siblingPath,
      },
    })

    mocks.requireEffectiveUser.mockResolvedValue({ userId: ownerUserId })
    mocks.getActiveWorkspaceImportSelection.mockResolvedValue({ artifactWhere: { projectId } })
    mocks.agentFetch.mockImplementation(async (url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>
      if (url === '/reamon/code/suggest-renames') {
        const candidates = Array.isArray(request.bindings) ? request.bindings as Array<Record<string, unknown>> : []
        const dependencyAlias = candidates.find((item) => item.id === moduleSelectedAliasId)
        const stringAlias = candidates.find((item) => item.id === moduleSiblingAliasId)
        if (dependencyAlias && stringAlias) {
          return jsonResponse({ renames: [
            { bindingId: moduleSelectedAliasId, oldName: 'val', newName: 'dependency', rationale: 'Clarify the external package alias.' },
            { bindingId: moduleSiblingAliasId, oldName: 'std', newName: 'stringutil', rationale: 'Clarify the standard-library alias.' },
          ] })
        }
        const candidate = candidates.find((item) => item.name === 'fn')
        const selectedBindingId = typeof candidate?.id === 'string' ? candidate.id : fixtureBindingId
        return jsonResponse({ renames: [{ bindingId: selectedBindingId, oldName: 'fn', newName: 'calculate', rationale: 'Use the operation name.' }] })
      }
      const files = Array.isArray(request.files) ? request.files as Array<Record<string, string>> : []
      const inputs = files.map((file) => ({ relativePath: file.relative_path, sourceCode: file.source_code }))
      if (request.operation === 'project_module_bindings') {
        return jsonResponse({
          scope: 'verified-go-module-source-snapshot', source_sha256: hash(moduleSelectedSource),
          source_set_sha256: sourceSetHash(inputs), selected_path: selectedPath,
          inventory_scope_sha256: 'a'.repeat(64), truncated: false, parser_version: 'go1.25.0',
          files: inputs.map((file) => ({ relative_path: file.relativePath, source_sha256: hash(file.sourceCode) })),
          bindings: [
            { id: moduleSelectedAliasId, name: 'val', kind: 'file import alias', scopeType: 'file', relativePath: selectedPath, importPath: 'example.test/dep', declarationStart: moduleSelectedSource.indexOf('val "'), referenceCount: 1, exported: false },
            { id: moduleSiblingAliasId, name: 'std', kind: 'file import alias', scopeType: 'file', relativePath: siblingPath, importPath: 'strings', declarationStart: moduleSiblingSource.indexOf('std "'), referenceCount: 1, exported: false },
          ],
        })
      }
      if (request.operation === 'project_inventory') {
        const entries = [
          { id: moduleSelectedAliasId, name: 'val', kind: 'file import alias', scope: 'file', relativePath: selectedPath, declarationStart: moduleSelectedSource.indexOf('val "'), referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'file-import-alias-with-resolved-references', nameAssessment: 'unassessed' },
          { id: moduleSiblingAliasId, name: 'std', kind: 'file import alias', scope: 'file', relativePath: siblingPath, declarationStart: moduleSiblingSource.indexOf('std "'), referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'file-import-alias-with-resolved-references', nameAssessment: 'unassessed' },
        ]
        return jsonResponse({
          source_sha256: hash(moduleSelectedSource), source_set_sha256: sourceSetHash(inputs), selected_path: selectedPath,
          module_path: request.module_path, module_root: request.module_root,
          go_mod_sha256: request.go_mod_sha256, go_sum_sha256: request.go_sum_sha256,
          files: inputs.map((file) => ({ relative_path: file.relativePath, source_sha256: hash(file.sourceCode) })),
          packages: [{ directory: 'pkg', package_name: 'sample', source_file_count: 2, source_set_sha256: sourceSetHash(inputs) }],
          parser_version: 'go1.25.0',
          inventory: {
            scope: 'verified-whole-project-go-source-snapshot', complete: true,
            source_file_count: 2, package_count: 1, private_package_symbol_count: 0,
            referenced_private_package_symbols: 0, unreferenced_private_symbols: 0,
            exported_package_symbol_count: 0, unsupported_package_symbol_count: 0,
            file_scope_symbol_count: 2, referenced_file_scope_symbols: 2,
            unreferenced_file_scope_symbols: 0, unsupported_file_scope_symbol_count: 0,
            local_symbol_count: 0, referenced_local_symbols: 0, unreferenced_local_symbols: 0,
            unsupported_local_symbol_count: 0, member_symbol_count: 0, unsupported_member_symbol_count: 0,
            entry_count: 2, entries_truncated: false, entries,
          },
        })
      }
      if (request.operation === 'project_module_rename') {
        const aliasMetadata = new Map([
          [moduleSelectedAliasId, { relativePath: selectedPath, oldName: 'val', newName: 'dependency', sourceCode: moduleSelectedSource, output: moduleSelectedOutput }],
          [moduleSiblingAliasId, { relativePath: siblingPath, oldName: 'std', newName: 'stringutil', sourceCode: moduleSiblingSource, output: moduleSiblingOutput }],
        ])
        const renames = Array.isArray(request.renames) ? request.renames as Array<Record<string, string>> : []
        const editedFiles = renames.map((rename) => {
          const alias = aliasMetadata.get(rename.binding_id)
          if (!alias) throw new Error(`Unexpected module alias binding ${rename.binding_id}`)
          const file = inputs.find((item) => item.relativePath === alias.relativePath)
          if (!file || file.sourceCode !== alias.sourceCode || rename.new_name !== alias.newName) throw new Error('Module alias edit does not match its reviewed source')
          const edits: Array<{ start: number; end: number; old_text: string; new_text: string }> = []
          for (const match of file.sourceCode.matchAll(new RegExp(`\\b${alias.oldName}\\b`, 'g'))) {
            const start = match.index ?? -1
            edits.push({ start, end: start + alias.oldName.length, old_text: alias.oldName, new_text: alias.newName })
          }
          if (edits.length !== 2) throw new Error('Module alias fixture should contain its declaration and one resolved use')
          return {
            relative_path: alias.relativePath, input_sha256: hash(file.sourceCode), output_sha256: hash(alias.output),
            source_code: alias.output, edits,
          }
        })
        const renamed = renames.map((rename) => ({
          bindingId: rename.binding_id, oldName: aliasMetadata.get(rename.binding_id)!.oldName,
          newName: rename.new_name, kind: 'file import alias', referenceCount: 1, scopeType: 'file',
        }))
        const outputSources = new Map(editedFiles.map((file) => [file.relative_path, file.source_code]))
        return jsonResponse({
          scope: 'module', source_sha256: hash(moduleSelectedSource), source_set_sha256: sourceSetHash(inputs),
          output_source_set_sha256: sourceSetHash(inputs.map((file) => ({ relativePath: file.relativePath, sourceCode: outputSources.get(file.relativePath) ?? file.sourceCode }))),
          output_sha256: hash(moduleSelectedOutput), source_code: moduleSelectedOutput,
          parser_version: 'go1.25.0', inventory_scope_sha256: 'a'.repeat(64), output_inventory_scope_sha256: 'b'.repeat(64),
          renamed_bindings: renamed, files: editedFiles,
        })
      }
      const outputFiles = [
        { relative_path: selectedPath, input_sha256: hash(selectedSource), output_sha256: hash(selectedOutput), source_code: selectedOutput, edits: [{ start: selectedSource.indexOf('fn'), end: selectedSource.indexOf('fn') + 2, old_text: 'fn', new_text: 'calculate' }] },
        { relative_path: siblingPath, input_sha256: hash(siblingSource), output_sha256: hash(siblingOutput), source_code: siblingOutput, edits: [{ start: siblingSource.indexOf('fn'), end: siblingSource.indexOf('fn') + 2, old_text: 'fn', new_text: 'calculate' }] },
      ]
      if (request.operation === 'project_bindings') {
        return jsonResponse({
          source_sha256: hash(selectedSource), source_set_sha256: sourceSetHash(inputs), selected_path: selectedPath,
          files: inputs.map((file) => ({ relative_path: file.relativePath, source_sha256: hash(file.sourceCode) })),
          bindings: [{
            id: fixtureBindingId, name: 'fn', kind: 'package function', scopeType: 'package',
            declarationStart: selectedSource.indexOf('fn'), referenceCount: 1, relativePath: selectedPath, exported: false,
          }],
          truncated: false, parser_version: 'go1.24.4',
          inventory: {
            scope: 'reviewed-same-directory-go-package-source-snapshot', source_file_count: 2,
            private_package_symbol_count: 2, referenced_private_package_symbols: 1, unreferenced_private_symbols: 1,
            exported_package_symbol_count: 0, unsupported_package_symbol_count: 0, rename_binding_catalog_truncated: false,
            file_scope_symbol_count: 1, referenced_file_scope_symbols: 1, unreferenced_file_scope_symbols: 0, unsupported_file_scope_symbol_count: 0,
            local_symbol_count: 1, referenced_local_symbols: 1, unreferenced_local_symbols: 0, unsupported_local_symbol_count: 0,
            entry_count: 4, entries_truncated: false,
            entries: [
              { id: importAliasBindingId, name: 'dep', kind: 'file import alias', scope: 'file', relativePath: selectedPath, declarationStart: selectedSource.indexOf('"example.test/dep"'), referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'file-import-alias-with-resolved-references', nameAssessment: 'unassessed' },
              { id: fixtureBindingId, name: 'fn', kind: 'package function', scope: 'package', relativePath: selectedPath, declarationStart: selectedSource.indexOf('func fn') + 5, referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'private-package-symbol-with-resolved-references', nameAssessment: 'unassessed' },
              { id: localValueBindingId, name: 'value', kind: 'local variable', scope: 'local', relativePath: selectedPath, declarationStart: selectedSource.indexOf('value'), referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'local-symbol-with-resolved-references', nameAssessment: 'unassessed' },
              { id: 'abcdef0123456789abcdef01', name: 'run', kind: 'package function', scope: 'package', relativePath: siblingPath, declarationStart: 20, referenceCount: 0, exported: false, classification: 'excluded', classificationReason: 'unreferenced-package-symbol', nameAssessment: 'unassessed' },
            ],
          },
        })
      }
      if (request.operation === 'project_inventory') {
        const inventoryFiles = inputs.map((file) => ({ relative_path: file.relativePath, source_sha256: hash(file.sourceCode) }))
        const projectSourceSet = sourceSetHash(inputs)
        return jsonResponse({
          source_sha256: hash(selectedSource), source_set_sha256: projectSourceSet, selected_path: selectedPath,
          module_path: request.module_path, module_root: request.module_root,
          go_mod_sha256: request.go_mod_sha256, go_sum_sha256: request.go_sum_sha256,
          files: inventoryFiles,
          packages: [{ directory: 'pkg', package_name: 'sample', source_file_count: 2, source_set_sha256: projectSourceSet }],
          parser_version: 'go1.24.4',
          inventory: {
            scope: 'verified-whole-project-go-source-snapshot', complete: true, source_file_count: 2, package_count: 1,
            private_package_symbol_count: 2, referenced_private_package_symbols: 1, unreferenced_private_symbols: 1,
            exported_package_symbol_count: 0, unsupported_package_symbol_count: 0,
            file_scope_symbol_count: 1, referenced_file_scope_symbols: 1, unreferenced_file_scope_symbols: 0, unsupported_file_scope_symbol_count: 0,
            local_symbol_count: 1, referenced_local_symbols: 1, unreferenced_local_symbols: 0, unsupported_local_symbol_count: 0,
            entry_count: 4, entries_truncated: false,
            entries: [
              { id: importAliasBindingId, name: 'dep', kind: 'file import alias', scope: 'file', relativePath: selectedPath, declarationStart: selectedSource.indexOf('"example.test/dep"'), referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'file-import-alias-with-resolved-references', nameAssessment: 'unassessed' },
              { id: fixtureBindingId, name: 'fn', kind: 'package function', scope: 'package', relativePath: selectedPath, declarationStart: selectedSource.indexOf('func fn') + 5, referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'private-package-symbol-with-resolved-references', nameAssessment: 'unassessed' },
              { id: localValueBindingId, name: 'value', kind: 'local variable', scope: 'local', relativePath: selectedPath, declarationStart: selectedSource.indexOf('value'), referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'local-symbol-with-resolved-references', nameAssessment: 'unassessed' },
              { id: 'abcdef0123456789abcdef01', name: 'run', kind: 'package function', scope: 'package', relativePath: siblingPath, declarationStart: 20, referenceCount: 0, exported: false, classification: 'excluded', classificationReason: 'unreferenced-package-symbol', nameAssessment: 'unassessed' },
            ],
          },
        })
      }
      if (request.operation === 'project_rename') {
        return jsonResponse({
          scope: 'project', source_sha256: hash(selectedSource), source_set_sha256: sourceSetHash(inputs),
          output_source_set_sha256: sourceSetHash([
            { relativePath: selectedPath, sourceCode: selectedOutput }, { relativePath: siblingPath, sourceCode: siblingOutput },
          ]),
          output_sha256: hash(selectedOutput), source_code: selectedOutput, parser_version: 'go1.24.4',
          renamed_bindings: [{ bindingId, oldName: 'fn', newName: 'calculate', kind: 'package function', referenceCount: 1, scopeType: 'package' }],
          files: outputFiles,
        })
      }
      throw new Error(`Unexpected agent route or operation: ${url} ${String(request.operation)}`)
    })
  }, 60_000)

  afterAll(async () => {
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId, userId: ownerUserId } })
    if (providerId) await prisma.userLlmProvider.deleteMany({ where: { id: providerId, userId: ownerUserId } })
    if (ownerUserId) await prisma.user.deleteMany({ where: { id: ownerUserId } })
    if (artifactsDirectory) await rm(artifactsDirectory, { recursive: true, force: true })
    vi.unstubAllEnvs()
    await prisma.$disconnect()
  })

  it('rejects stale receipts, rolls back a failed multi-file transaction, then reloads both drafts', async () => {
    const proposalResponse = await POST(renameRequest('suggest'), params())
    expect(proposalResponse.status).toBe(200)
    const proposal = await proposalResponse.json()
    expect(proposal).toMatchObject({ scope: 'project', candidates: 1, sourceSetSha256: expect.stringMatching(/^[a-f0-9]{64}$/), projectInventory: { sourceFileCount: 2, privatePackageSymbolCount: 2, referencedPrivatePackageSymbols: 1, unreferencedPrivateSymbols: 1, fileScopeSymbolCount: 1, referencedFileScopeSymbols: 1, localSymbolCount: 1, referencedLocalSymbols: 1, entryCount: 4, entries: expect.arrayContaining([expect.objectContaining({ name: 'dep', scope: 'file', classification: 'eligible' }), expect.objectContaining({ name: 'fn', classification: 'eligible' }), expect.objectContaining({ name: 'value', scope: 'local', classification: 'eligible' }), expect.objectContaining({ name: 'run', classification: 'excluded' })]) } })
    bindingId = proposal.renames[0].bindingId
    const savedProposal = await prisma.reamonCodeAttempt.findUnique({ where: { id: proposal.attemptId } })
    expect(savedProposal?.scope).toBe('rename-suggestions')
    expect(savedProposal?.requestPayload).toMatchObject({ goProjectScope: true, goSelectedPath: selectedPath, goProjectModulePath: 'example.test/fixture', goProjectModuleManifestSha256: hash(goMod), goProjectModuleSumSha256: hash(goSum), goProjectInventory: { sourceFileCount: 2, privatePackageSymbolCount: 2, unreferencedPrivateSymbols: 1, fileScopeSymbolCount: 1, referencedFileScopeSymbols: 1, localSymbolCount: 1, referencedLocalSymbols: 1, entryCount: 4 }, renames: [{ bindingId, oldName: 'fn', newName: 'calculate' }] })

    await writeFile(path.join(artifactsDirectory, 'go.mod'), 'module example.test/changed\n\ngo 1.24\n', 'utf8')
    const changedModuleResponse = await POST(renameRequest('apply', proposal.attemptId), params())
    expect(changedModuleResponse.status).toBe(409)
    expect(await prisma.reamonCodeDraft.count({ where: { projectId, artifactId } })).toBe(0)
    await writeFile(path.join(artifactsDirectory, 'go.mod'), goMod, 'utf8')

    await writeFile(path.join(artifactsDirectory, 'go.sum'), `${goSum}example.test/other v1.0.0 h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=\n`, 'utf8')
    const changedSumResponse = await POST(renameRequest('apply', proposal.attemptId), params())
    expect(changedSumResponse.status).toBe(409)
    expect(await prisma.reamonCodeDraft.count({ where: { projectId, artifactId } })).toBe(0)
    await writeFile(path.join(artifactsDirectory, 'go.sum'), goSum, 'utf8')

    await prisma.reamonCodeReview.update({ where: { id: siblingReviewId }, data: { maintainedSourceHash: 'f'.repeat(64) } })
    const staleResponse = await POST(renameRequest('apply', proposal.attemptId), params())
    expect(staleResponse.status).toBe(409)
    expect(await prisma.reamonCodeDraft.count({ where: { projectId, artifactId } })).toBe(0)
    expect(await prisma.reamonCodeAttempt.count({ where: { projectId, artifactId, scope: 'file' } })).toBe(0)
    await prisma.reamonCodeReview.update({ where: { id: siblingReviewId }, data: { maintainedSourceHash: hash(siblingSource) } })

    const realTransaction = prisma.$transaction.bind(prisma)
    const transactionSpy = vi.spyOn(prisma, '$transaction').mockImplementation((async (callback: unknown) => {
      if (typeof callback !== 'function') throw new Error('Expected interactive transaction in integration fixture')
      return realTransaction(async (tx) => {
        await (callback as (transaction: typeof tx) => Promise<unknown>)(tx)
        throw new Error('Injected failure after both per-file drafts were written')
      })
    }) as typeof prisma.$transaction)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const rollbackResponse = await POST(renameRequest('apply', proposal.attemptId), params())
      expect(rollbackResponse.status, await rollbackResponse.clone().text()).toBe(500)
      expect(await prisma.reamonCodeDraft.count({ where: { projectId, artifactId } })).toBe(0)
      expect(await prisma.reamonCodeAttempt.count({ where: { projectId, artifactId, scope: 'file' } })).toBe(0)
    } finally {
      transactionSpy.mockRestore()
      consoleError.mockRestore()
    }

    const applyResponse = await POST(renameRequest('apply', proposal.attemptId), params())
    expect(applyResponse.status).toBe(200)
    const applied = await applyResponse.json()
    expect(applied).toMatchObject({ sourceCode: selectedOutput, validationStatus: 'PASSED' })
    expect(applied.projectChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ unitId: selectedUnitId, relativePath: selectedPath, outputSha256: hash(selectedOutput) }),
      expect.objectContaining({ unitId: siblingUnitId, relativePath: siblingPath, outputSha256: hash(siblingOutput) }),
    ]))

    const drafts = await prisma.reamonCodeDraft.findMany({ where: { projectId, artifactId }, orderBy: { codeUnitId: 'asc' } })
    expect(drafts).toHaveLength(2)
    expect(drafts.map((draft) => [draft.codeUnitId, draft.sourceCode, draft.scope, draft.draftHash])).toEqual(expect.arrayContaining([
      [selectedUnitId, selectedOutput, 'file', hash(selectedOutput)],
      [siblingUnitId, siblingOutput, 'file', hash(siblingOutput)],
    ]))
    expect(await prisma.reamonCodeAttempt.count({ where: { projectId, artifactId, scope: 'file', status: 'SUCCEEDED' } })).toBe(2)
    expect(await prisma.reamonMaintainedSource.findUnique({ where: { projectId_codeUnitId: { projectId, codeUnitId: siblingUnitId } } })).toMatchObject({ sourceCode: siblingSource, acceptedReviewId: siblingReviewId })

    for (const [unitId, expectedSource] of [[selectedUnitId, selectedOutput], [siblingUnitId, siblingOutput]] as const) {
      const response = await getDraft(new Request(`http://localhost/api/projects/${projectId}/visualizer/drafts/${unitId}`), {
        params: Promise.resolve({ id: projectId, unitId }),
      })
      expect(response.status).toBe(200)
      expect((await response.json()).draft).toMatchObject({ sourceCode: expectedSource, validationStatus: 'PASSED', syntaxValidated: true })
    }
  }, 60_000)

  it('persists and reloads a Go module import-alias batch across files', async () => {
    await prisma.reamonCodeDraft.deleteMany({ where: { projectId, artifactId } })
    await writeFile(path.join(artifactsDirectory, runKey, 'sources', selectedPath), moduleSelectedSource, 'utf8')
    await writeFile(path.join(artifactsDirectory, runKey, 'sources', siblingPath), moduleSiblingSource, 'utf8')
    await prisma.reamonCodeReview.update({ where: { id: siblingReviewId }, data: { maintainedSourceHash: hash(moduleSiblingSource) } })
    await prisma.reamonMaintainedSource.update({
      where: { projectId_codeUnitId: { projectId, codeUnitId: siblingUnitId } },
      data: { sourceCode: moduleSiblingSource, sourceHash: hash(moduleSiblingSource) },
    })

    const proposalResponse = await POST(moduleAliasRequest('suggest'), params())
    expect(proposalResponse.status, await proposalResponse.clone().text()).toBe(200)
    const proposal = await proposalResponse.json()
    expect(proposal).toMatchObject({
      scope: 'module', candidates: 2,
      renames: expect.arrayContaining([
        expect.objectContaining({ bindingId: moduleSelectedAliasId, oldName: 'val', relativePath: selectedPath }),
        expect.objectContaining({ bindingId: moduleSiblingAliasId, oldName: 'std', relativePath: siblingPath }),
      ]),
    })
    const savedProposal = await prisma.reamonCodeAttempt.findUnique({ where: { id: proposal.attemptId } })
    expect(savedProposal?.requestPayload).toMatchObject({
      goProjectScope: true, goModuleScope: true,
      renames: expect.arrayContaining([
        expect.objectContaining({ bindingId: moduleSelectedAliasId, oldName: 'val', relativePath: selectedPath }),
        expect.objectContaining({ bindingId: moduleSiblingAliasId, oldName: 'std', relativePath: siblingPath }),
      ]),
    })

    const applyResponse = await POST(moduleAliasRequest('apply', proposal.attemptId), params())
    expect(applyResponse.status, await applyResponse.clone().text()).toBe(200)
    const applied = await applyResponse.json()
    expect(applied).toMatchObject({ sourceCode: moduleSelectedOutput, validationStatus: 'PASSED' })
    expect(applied.projectChanges.map((change: { relativePath: string }) => change.relativePath).sort()).toEqual([selectedPath, siblingPath])
    const drafts = await prisma.reamonCodeDraft.findMany({ where: { projectId, artifactId } })
    expect(drafts).toHaveLength(2)
    expect(drafts.map((draft) => [draft.codeUnitId, draft.sourceCode, draft.scope, draft.draftHash])).toEqual(expect.arrayContaining([
      [selectedUnitId, moduleSelectedOutput, 'file', hash(moduleSelectedOutput)],
      [siblingUnitId, moduleSiblingOutput, 'file', hash(moduleSiblingOutput)],
    ]))
    for (const [unitId, expectedSource] of [[selectedUnitId, moduleSelectedOutput], [siblingUnitId, moduleSiblingOutput]] as const) {
      const response = await getDraft(new Request(`http://localhost/api/projects/${projectId}/visualizer/drafts/${unitId}`), {
        params: Promise.resolve({ id: projectId, unitId }),
      })
      expect(response.status).toBe(200)
      expect((await response.json()).draft).toMatchObject({ sourceCode: expectedSource, validationStatus: 'PASSED', syntaxValidated: true })
    }
  }, 60_000)
})
