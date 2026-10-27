import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), provider: vi.fn(), observation: vi.fn(), observations: vi.fn(), observationCreateMany: vi.fn(), artifact: vi.fn(),
  artifacts: vi.fn(), maintainedSource: vi.fn(), drafts: vi.fn(), draft: vi.fn(), agentFetch: vi.fn(), root: vi.fn(), resolvePath: vi.fn(),
  evidenceFindMany: vi.fn(),
  functionMatches: vi.fn(),
  attemptsFindMany: vi.fn(), attemptsCreate: vi.fn(), attemptsUpdateMany: vi.fn(),
  reviewsFindMany: vi.fn(), reviewsFindFirst: vi.fn(), leaseCreate: vi.fn(), leaseDeleteMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  userLlmProvider: { findFirst: h.provider },
  reamonObservation: { findFirst: h.observation, findMany: h.observations, createMany: h.observationCreateMany },
  artifact: { findFirst: h.artifact, findMany: h.artifacts },
  reamonMaintainedSource: { findMany: h.maintainedSource },
  reamonCodeDraft: { findMany: h.drafts, findFirst: h.draft },
  reamonCodeAttempt: { findMany: h.attemptsFindMany, create: h.attemptsCreate, updateMany: h.attemptsUpdateMany },
  reamonCodeReview: { findMany: h.reviewsFindMany, findFirst: h.reviewsFindFirst },
  reamonFunctionMatch: { findMany: h.functionMatches },
  reamonCodeUnitLease: { create: h.leaseCreate, deleteMany: h.leaseDeleteMany },
  evidence: { findMany: h.evidenceFindMany },
} }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccess: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/reamon/derived-storage', () => ({ derivedArtifactRoot: h.root, resolveDerivedArtifactPath: h.resolvePath }))
vi.mock('@/lib/agentFetch', () => ({
  AgentUnreachableError: class AgentUnreachableError extends Error {},
  agentFetch: h.agentFetch,
}))

import { POST } from './route'
import { POST as deobfuscate } from '../deobfuscate/route'

const routeParams = { params: Promise.resolve({ id: 'project-1' }) }

function request(body: unknown) {
  return new NextRequest('http://localhost/api/projects/project-1/visualizer/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let testRoot = ''

beforeEach(async () => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.access.mockResolvedValue({ projectId: 'project-1' })
  h.selection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  h.provider.mockResolvedValue({ id: 'provider-1', name: 'Local Qwen', modelIdentifier: 'Qwen3.5-0.8B', timeout: 90 })
  h.observation.mockResolvedValue({
    id: 'unit-1', artifactId: 'artifact-1', taskId: 'task-1', stableKey: 'unit-1', source: 'reamon-jadx', label: 'MainActivity.onCreate',
    attributes: { qualifiedName: 'MainActivity.onCreate', language: 'Java', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/MainActivity.java' },
  })
  h.artifact.mockResolvedValue({ id: 'artifact-1' })
  h.artifacts.mockResolvedValue([])
  h.observations.mockResolvedValue([])
  h.observationCreateMany.mockResolvedValue({ count: 1 })
  h.maintainedSource.mockResolvedValue([])
  h.drafts.mockResolvedValue([])
  h.draft.mockResolvedValue(null)
  h.evidenceFindMany.mockResolvedValue([])
  h.attemptsFindMany.mockResolvedValue([])
  h.attemptsCreate.mockResolvedValue({ id: 'attempt-1' })
  h.attemptsUpdateMany.mockResolvedValue({ count: 0 })
  h.reviewsFindMany.mockResolvedValue([])
  h.reviewsFindFirst.mockResolvedValue(null)
  h.functionMatches.mockResolvedValue([])
  h.leaseCreate.mockResolvedValue({ id: 'lease-1' })
  h.leaseDeleteMany.mockResolvedValue({ count: 0 })
  testRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-explain-'))
  h.root.mockReturnValue(testRoot)
  h.resolvePath.mockImplementation((relativePath: string) => path.join(testRoot, relativePath))
  const codePath = path.join(testRoot, 'project-1/artifact-1/task-1/run-1/sources/MainActivity.java')
  await mkdir(path.dirname(codePath), { recursive: true })
  await writeFile(codePath, 'return state.value;')
  h.agentFetch.mockResolvedValue(new Response(JSON.stringify({ explanation: 'Reads the stored value.', source_truncated: false }), { status: 200 }))
})

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true })
})

describe('POST /api/projects/[id]/visualizer/explain', () => {
  it('sends selected source to the caller-owned provider through the internal agent', async () => {
    const response = await POST(request({ unitId: 'unit-1', providerId: 'provider-1', question: 'What does it read?' }), routeParams)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      explanation: 'Reads the stored value.', providerName: 'Local Qwen', model: 'Qwen3.5-0.8B', sourceTruncated: false,
    })
    expect(h.provider).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'provider-1', userId: 'user-1', providerType: 'openai_compatible' } }))
    expect(h.agentFetch).toHaveBeenCalledWith('/reamon/code/explain', expect.objectContaining({
      method: 'POST', body: expect.stringContaining('"model":"custom/provider-1"'),
    }), { timeoutMs: 90_000 })
    expect(String(h.agentFetch.mock.calls[0][1].body)).not.toContain('apiKey')
  })

  it('searches exact-hash shared identity evidence across completed runs without a recent-task window', async () => {
    h.artifact.mockResolvedValueOnce({ id: 'artifact-1', sha256: 'a'.repeat(64) })
    h.observation.mockResolvedValueOnce({
      id: 'unit-1', artifactId: 'artifact-1', taskId: 'task-1', stableKey: 'native:function:0x1000',
      canonicalKey: 'native:artifact-1:0x1000', source: 'reamon-ghidra', label: 'entry',
      attributes: { address: '0x1000', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/entry.c' },
    })
    h.observations.mockImplementation(async (args: { where?: Record<string, unknown> }) => (
      args.where?.task && args.where?.OR ? [{
        id: 'accepted-old-unit', source: 'reamon-other-provider', canonicalKey: 'native:artifact-1:0x1000', attributes: {},
      }] : []
    ))
    h.maintainedSource.mockResolvedValueOnce([{ codeUnitId: 'accepted-old-unit', artifactId: 'artifact-1', acceptedReviewId: 'review-1' }])
    await writeFile(path.join(testRoot, 'project-1/artifact-1/task-1/run-1/sources/entry.c'), 'int entry(void) { return 0; }')

    const response = await POST(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(200)
    const identityLookup = h.observations.mock.calls
      .map(([args]) => args as { where?: Record<string, unknown>; take?: number })
      .find(({ where }) => where?.task && where?.OR)
    expect(identityLookup).toBeDefined()
    expect(identityLookup?.where).toMatchObject({
      projectId: 'project-1', artifactId: 'artifact-1',
      task: { is: { projectId: 'project-1', artifactId: 'artifact-1', capability: 'decompile', status: 'COMPLETED' } },
      AND: [{ attributes: { path: ['inputArtifactSha256'], equals: 'a'.repeat(64) } }],
    })
    expect(identityLookup?.where?.OR).toContainEqual({ canonicalKey: 'native:artifact-1:0x1000' })
    expect(identityLookup?.take).toBe(4_098)
    expect(identityLookup?.where).not.toHaveProperty('id')
    expect(h.maintainedSource).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        projectId: 'project-1', artifactId: 'artifact-1',
        codeUnitId: { in: ['unit-1', 'accepted-old-unit'] }, acceptedReviewId: { not: null },
      }),
    }))
    expect(identityLookup?.where).not.toHaveProperty('taskId')
  })

  it('rejects a provider owned by another user', async () => {
    h.provider.mockResolvedValueOnce(null)
    const response = await POST(request({ unitId: 'unit-1', providerId: 'foreign-provider' }), routeParams)
    expect(response.status).toBe(404)
    expect(h.agentFetch).not.toHaveBeenCalled()
  })

  it('rejects source paths outside the selected artifact', async () => {
    h.observation.mockResolvedValueOnce({
      id: 'unit-1', artifactId: 'artifact-1', attributes: { codeArtifactId: 'project-1/artifact-other/private.java' },
    })
    const response = await POST(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)
    expect(response.status).toBe(404)
    expect(h.resolvePath).not.toHaveBeenCalled()
    expect(h.agentFetch).not.toHaveBeenCalled()
  })

  it('supplies the selected DEX function exact call edges and references to AI explanation', async () => {
    h.observation
      .mockResolvedValueOnce({
        id: 'class-1', artifactId: 'artifact-1', taskId: 'task-1', stableKey: 'dex:class:main', source: 'reamon-dex-decompiler',
        label: 'MainActivity', attributes: { name: 'MainActivity', language: 'Java', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/MainActivity.java' },
      })
      .mockResolvedValueOnce({
        id: 'function-1', stableKey: 'dex:function:main-on-create',
        attributes: { qualifiedName: 'Lapp/MainActivity;->onCreate()V', address: 'dex0:method#77' },
      })
    h.observations.mockImplementation(async (args: { where?: { kind?: string; type?: string | { in?: string[] } } }) => {
      if (args.where?.kind !== 'relationship') return []
      if (args.where.type === 'calls') return [{
        type: 'calls', label: 'onCreate calls\nUserStore#loadProfile', fromKey: 'dex:function:main-on-create', toKey: 'dex:function:load-profile',
        attributes: { fromAddress: 'dex0:method#77', toAddress: 'dex0:method#91' },
      }]
      if (typeof args.where.type === 'object' && args.where.type.in?.includes('references_string')) return [{
        type: 'references_string', label: 'onCreate references "profile_key"', fromKey: 'dex:function:main-on-create', toKey: 'dex:symbol:profile-key',
        attributes: { fromSignature: 'Lapp/MainActivity;->onCreate()V', targetName: 'profile_key', targetSignature: 'Ljava/lang/String;', occurrenceCount: 1 },
      }]
      return []
    })

    const response = await POST(request({ unitId: 'class-1', functionId: 'function-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(200)
    const payload = JSON.parse(String(h.agentFetch.mock.calls[0][1].body)) as { project_context: string }
    expect(payload.project_context).toContain('onCreate calls UserStore#loadProfile')
    expect(payload.project_context).toContain('onCreate()V references_string: profile_key')
    expect(h.observations).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        projectId: 'project-1', artifactId: 'artifact-1', taskId: 'task-1', source: 'reamon-dex-decompiler',
        kind: 'relationship', type: 'calls', OR: [{ fromKey: 'dex:function:main-on-create' }, { toKey: 'dex:function:main-on-create' }],
      }),
      take: 41,
    }))
  })
})

describe('POST /api/projects/[id]/visualizer/deobfuscate', () => {
  it('builds a Java method outline without requiring a provider', async () => {
    const source = 'class Example { int value() { return 1; } }'
    await writeFile(path.join(testRoot, 'project-1/artifact-1/task-1/run-1/sources/MainActivity.java'), source)
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ members: [{ name: 'value', kind: 'method', start_byte: 20, end_byte: 40, line: 1, source_bytes: 20 }], truncated: false, parserVersion: 'tree-sitter-test' }), { status: 200 }))

    const response = await deobfuscate(request({ unitId: 'unit-1', scope: 'outline' }), routeParams)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ members: [{ name: 'value', kind: 'method', start_byte: 20, end_byte: 40, line: 1, source_bytes: 20 }], truncated: false, parserVersion: 'tree-sitter-test', persistedMemberCount: 1 })
    expect(h.provider).not.toHaveBeenCalled()
    expect(h.agentFetch).toHaveBeenCalledWith('/reamon/code/outline', expect.objectContaining({
      body: JSON.stringify({ language: 'Java', source_code: source }),
    }), { timeoutMs: 30_000 })
  })

  it('sends only the selected UTF-8 Java member for a scoped rewrite', async () => {
    const source = 'class Example { String label() { return "café"; } }'
    const method = 'String label() { return "café"; }'
    const startByte = Buffer.byteLength('class Example { ', 'utf8')
    const endByte = startByte + Buffer.byteLength(method, 'utf8')
    await writeFile(path.join(testRoot, 'project-1/artifact-1/task-1/run-1/sources/MainActivity.java'), source)
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ members: [{ name: 'label', kind: 'method', start_byte: startByte, end_byte: endByte, line: 1, source_bytes: Buffer.byteLength(method, 'utf8') }], truncated: false, parserVersion: 'tree-sitter-test' }), { status: 200 }))

    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1', scope: 'member', startByte, endByte, memberName: 'label' }), routeParams)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ attemptId: 'attempt-1', status: 'QUEUED' })
    const payload = h.attemptsCreate.mock.calls[0][0].data.requestPayload
    expect(payload.source_code).toBe(method)
    expect(payload.scope).toBe('member')
    expect(payload.member_name).toBe('label')
    expect(payload.member_start_byte).toBe(startByte)
    expect(payload.member_end_byte).toBe(endByte)
    expect(String(h.agentFetch.mock.calls[0][1].body)).toContain('"source_code"')
  })

  it('supplies only same-run direct Ghidra callers and callees as code context', async () => {
    const mainPath = 'project-1/artifact-1/task-1/run-1/sources/functions/main.c'
    const callerPath = 'project-1/artifact-1/task-1/run-1/sources/functions/caller.c'
    const helperPath = 'project-1/artifact-1/task-1/run-1/sources/functions/helper.c'
    await mkdir(path.dirname(path.join(testRoot, helperPath)), { recursive: true })
    await writeFile(path.join(testRoot, mainPath), 'int main(void) { return helper(); }')
    await writeFile(path.join(testRoot, callerPath), 'int caller(void) { return main(); }')
    await writeFile(path.join(testRoot, helperPath), 'int helper(void) { return 1; }')
    h.observation.mockResolvedValueOnce({
      id: 'unit-main', artifactId: 'artifact-1', taskId: 'task-1', stableKey: 'ghidra:function:main', source: 'reamon-ghidra', label: 'main',
      attributes: { name: 'main', language: 'C', codeArtifactId: mainPath },
    })
    h.observations.mockImplementation(async (args: { where?: { kind?: string; type?: string } }) => {
      if (args.where?.kind === 'relationship') return [
        { fromKey: 'ghidra:function:caller', toKey: 'ghidra:function:main' },
        { fromKey: 'ghidra:function:main', toKey: 'ghidra:function:helper' },
      ]
      if (args.where?.type === 'code_unit') return [
        { id: 'unit-caller', label: 'caller', attributes: { name: 'caller', language: 'C', codeArtifactId: callerPath } },
        { id: 'unit-helper', label: 'helper', attributes: { name: 'helper', language: 'C', codeArtifactId: helperPath } },
      ]
      return []
    })
    const response = await deobfuscate(request({ unitId: 'unit-main', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(202)
    const payload = h.attemptsCreate.mock.calls[0][0].data.requestPayload
    expect(payload.context_sources).toEqual([
      expect.objectContaining({ unit_name: 'caller', language: 'C', source_code: 'int caller(void) { return main(); }', unit_id: 'unit-caller' }),
      expect.objectContaining({ unit_name: 'helper', language: 'C', source_code: 'int helper(void) { return 1; }', unit_id: 'unit-helper' }),
    ])
    expect(payload.context_sources.every((source: { source_sha256?: string }) => /^[a-f0-9]{64}$/.test(source.source_sha256 ?? ''))).toBe(true)
    expect(h.observations).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        taskId: 'task-1', artifactId: 'artifact-1', source: 'reamon-ghidra', kind: 'relationship', type: 'calls',
      }),
    }))
  })

  it('loads DEX rewrite callees through the selected method keys instead of scanning the run edge prefix', async () => {
    const mainPath = 'project-1/artifact-1/task-1/run-1/sources/MainActivity.java'
    const storePath = 'project-1/artifact-1/task-1/run-1/sources/UserStore.java'
    const source = 'class MainActivity { void onCreate() { UserStore.loadProfile(); } }'
    await writeFile(path.join(testRoot, mainPath), source)
    await writeFile(path.join(testRoot, storePath), 'class UserStore { static void loadProfile() {} }')
    h.artifact.mockResolvedValueOnce({ id: 'artifact-1', sha256: 'a'.repeat(64), originalName: 'app.apk' })
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      members: [{ name: 'onCreate', kind: 'method', start_byte: 0, end_byte: Buffer.byteLength(source), line: 1, source_bytes: Buffer.byteLength(source) }],
      truncated: false,
      parserVersion: 'tree-sitter-test',
    }), { status: 200 }))
    h.observation.mockResolvedValueOnce({
      id: 'unit-main', artifactId: 'artifact-1', taskId: 'task-1', stableKey: 'dex:class:main', source: 'reamon-dex-decompiler',
      label: 'MainActivity',
      attributes: { name: 'MainActivity', language: 'Java', codeArtifactId: mainPath, relativePath: 'MainActivity.java', classReferences: [] },
    })
    h.observations.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
      const where = args.where || {}
      if (where.type === 'function') return [{ stableKey: 'dex:function:main:onCreate' }]
      if (where.type === 'calls') return [{
        fromKey: 'dex:function:main:onCreate', toKey: 'dex:function:store:loadProfile',
        attributes: {
          fromCodeUnitKey: 'dex:class:main', toCodeUnitKey: 'dex:class:store',
          fromSignature: 'Lapp/MainActivity;->onCreate()V', toSignature: 'Lapp/UserStore;->loadProfile()V',
        },
      }]
      if (where.type === 'code_unit' && typeof where.stableKey === 'object' && where.stableKey !== null) return [{
        id: 'unit-store', stableKey: 'dex:class:store', label: 'UserStore',
        attributes: { name: 'UserStore', language: 'Java', codeArtifactId: storePath, relativePath: 'UserStore.java' },
      }]
      return []
    })

    const response = await deobfuscate(request({
      unitId: 'unit-main', providerId: 'provider-1', scope: 'member', memberName: 'onCreate', startByte: 0, endByte: Buffer.byteLength(source),
    }), routeParams)

    expect(response.status).toBe(202)
    const payload = h.attemptsCreate.mock.calls[0][0].data.requestPayload
    expect(payload.context_sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        unit_name: expect.stringContaining('direct callee from this analysis run'),
        source_code: 'class UserStore { static void loadProfile() {} }',
      }),
    ]))
    expect(h.observations).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        type: 'calls',
        OR: [{ fromKey: { in: ['dex:function:main:onCreate'] } }, { toKey: { in: ['dex:function:main:onCreate'] } }],
      }),
      take: 401,
    }))
  })

  it('persists the selected source and exact saved provider for an asynchronous source transformation', async () => {
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1', question: 'Use names based on actual behavior.' }), routeParams)

    expect(response.status).toBe(202)
    const { data } = h.attemptsCreate.mock.calls[0][0]
    expect(data.providerName).toBe('Local Qwen')
    expect(data.modelIdentifier).toBe('Qwen3.5-0.8B')
    expect(data.requestPayload.model).toBe('custom/provider-1')
    expect(data.requestPayload.source_code).toBe('return state.value;')
    expect(data.requestPayload.question).toBe('Use names based on actual behavior.')
    expect(JSON.stringify(data.requestPayload)).not.toContain('apiKey')
  })

  it('bounds project memory reads and still supplies saved symbol names to the model', async () => {
    h.maintainedSource.mockResolvedValueOnce([
      { codeUnitId: 'unit-v1', artifactId: 'artifact-v1', unitName: 'example.ProductStore', language: 'Java', sourceHash: 'a'.repeat(64), acceptedReviewId: 'review-v1', symbolIndex: ['loadProduct', 'persistProduct'] },
    ])
    h.reviewsFindMany.mockResolvedValueOnce([
      { id: 'review-v1', artifactId: 'artifact-v1', codeUnitId: 'unit-v1', maintainedSourceHash: 'a'.repeat(64), symbolIndexSnapshot: ['loadProduct', 'persistProduct'] },
    ])
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(202)
    expect(h.maintainedSource).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 'project-1', artifactId: 'artifact-1' }, take: 4097 }))
    expect(h.maintainedSource).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 'project-1', artifactId: { not: 'artifact-1' } }, take: 1024 }))
    const payload = h.attemptsCreate.mock.calls[0][0].data.requestPayload
    expect(payload.project_symbol_context).toContain('example.ProductStore (Java; other artifact artifact-v1; decompiler-output lineage was not recorded for this accepted source): symbols: loadProduct, persistProduct')
  })

  it('preserves artifact identity for same-named project memory entries', async () => {
    h.maintainedSource.mockResolvedValueOnce([
      { codeUnitId: 'unit-v1', artifactId: 'artifact-v1', unitName: 'example.ProductStore', language: 'Java', sourceHash: 'a'.repeat(64), acceptedReviewId: 'review-v1', symbolIndex: ['loadProduct'] },
      { codeUnitId: 'unit-v2', artifactId: 'artifact-v2', unitName: 'example.ProductStore', language: 'Java', sourceHash: 'b'.repeat(64), acceptedReviewId: 'review-v2', symbolIndex: ['fetchProduct'] },
    ])
    h.reviewsFindMany.mockResolvedValueOnce([
      { id: 'review-v1', artifactId: 'artifact-v1', codeUnitId: 'unit-v1', maintainedSourceHash: 'a'.repeat(64), symbolIndexSnapshot: ['loadProduct'] },
      { id: 'review-v2', artifactId: 'artifact-v2', codeUnitId: 'unit-v2', maintainedSourceHash: 'b'.repeat(64), symbolIndexSnapshot: ['fetchProduct'] },
    ])
    h.artifacts.mockResolvedValueOnce([
      { id: 'artifact-v1', originalName: 'app.apk', sha256: '111111111111aaaaaaaa' },
      { id: 'artifact-v2', originalName: 'app.apk', sha256: '222222222222bbbbbbbb' },
    ])
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(202)
    const payload = h.attemptsCreate.mock.calls[0][0].data.requestPayload
    expect(payload.project_symbol_context).toContain('example.ProductStore (Java; other artifact app.apk #111111111111; decompiler-output lineage was not recorded for this accepted source): symbols: loadProduct')
    expect(payload.project_symbol_context).toContain('example.ProductStore (Java; other artifact app.apk #222222222222; decompiler-output lineage was not recorded for this accepted source): symbols: fetchProduct')
  })

  it('queues rewrites so the worker can validate the returned Java type', async () => {
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ attemptId: 'attempt-1', status: 'QUEUED' })
    expect(h.attemptsCreate.mock.calls[0][0].data.requestPayload.source_code).toBe('return state.value;')
  })

  it('queues rewrites so the worker can validate that executable Java logic is preserved', async () => {
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ attemptId: 'attempt-1', status: 'QUEUED' })
    expect(h.attemptsCreate.mock.calls[0][0].data.status).toBe('QUEUED')
  })

  it('persists the selected source and provider context for asynchronous rewrite processing', async () => {
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(202)
    const { data } = h.attemptsCreate.mock.calls[0][0]
    expect(data.providerName).toBe('Local Qwen')
    expect(data.modelIdentifier).toBe('Qwen3.5-0.8B')
    expect(data.requestPayload.model).toBe('custom/provider-1')
    expect(data.requestPayload.source_code).toBe('return state.value;')
  })

  it('rejects source paths outside the selected artifact before requesting AI', async () => {
    h.observation.mockResolvedValueOnce({
      id: 'unit-1', artifactId: 'artifact-1', attributes: { codeArtifactId: 'project-1/artifact-other/private.java' },
    })
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)
    expect(response.status).toBe(404)
    expect(h.resolvePath).not.toHaveBeenCalled()
    expect(h.agentFetch).not.toHaveBeenCalled()
  })
})
