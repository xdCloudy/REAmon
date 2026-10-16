import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), provider: vi.fn(), observation: vi.fn(), observations: vi.fn(), artifact: vi.fn(),
  artifacts: vi.fn(), maintainedSource: vi.fn(), drafts: vi.fn(), draft: vi.fn(), agentFetch: vi.fn(), root: vi.fn(), resolvePath: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  userLlmProvider: { findFirst: h.provider },
  reamonObservation: { findFirst: h.observation, findMany: h.observations },
  artifact: { findFirst: h.artifact, findMany: h.artifacts },
  reamonMaintainedSource: { findMany: h.maintainedSource },
  reamonCodeDraft: { findMany: h.drafts, findFirst: h.draft },
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
  h.maintainedSource.mockResolvedValue([])
  h.drafts.mockResolvedValue([])
  h.draft.mockResolvedValue(null)
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
})

describe('POST /api/projects/[id]/visualizer/deobfuscate', () => {
  it('builds a Java method outline without requiring a provider', async () => {
    const source = 'class Example { int value() { return 1; } }'
    await writeFile(path.join(testRoot, 'project-1/artifact-1/task-1/run-1/sources/MainActivity.java'), source)
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ members: [{ name: 'value' }], truncated: false }), { status: 200 }))

    const response = await deobfuscate(request({ unitId: 'unit-1', scope: 'outline' }), routeParams)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ members: [{ name: 'value' }], truncated: false })
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
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ source_code: method, syntax_validated: true }), { status: 200 }))

    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1', scope: 'member', startByte, endByte, memberName: 'label' }), routeParams)

    expect(response.status).toBe(200)
    expect(String(h.agentFetch.mock.calls.at(-1)?.[1]?.body)).toContain(`"source_code":${JSON.stringify(method)}`)
    expect(String(h.agentFetch.mock.calls.at(-1)?.[1]?.body)).toContain('"scope":"member"')
    expect(String(h.agentFetch.mock.calls.at(-1)?.[1]?.body)).toContain('"member_name":"label"')
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
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ source_code: 'int main(void) { return helper(); }' }), { status: 200 }))

    const response = await deobfuscate(request({ unitId: 'unit-main', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(200)
    const payload = JSON.parse(String(h.agentFetch.mock.calls.at(-1)?.[1]?.body))
    expect(payload.context_sources).toEqual([
      { unit_name: 'caller', language: 'C', source_code: 'int caller(void) { return main(); }' },
      { unit_name: 'helper', language: 'C', source_code: 'int helper(void) { return 1; }' },
    ])
    expect(h.observations).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        taskId: 'task-1', artifactId: 'artifact-1', source: 'reamon-ghidra', type: 'calls',
        OR: [{ fromKey: 'ghidra:function:main' }, { toKey: 'ghidra:function:main' }],
      }),
    }))
  })

  it('sends the selected source to the exact saved provider for a source transformation', async () => {
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ source_code: 'return currentAccountName;' }), { status: 200 }))
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1', question: 'Use names based on actual behavior.' }), routeParams)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sourceCode: 'return currentAccountName;', providerName: 'Local Qwen', model: 'Qwen3.5-0.8B' })
    expect(h.agentFetch).toHaveBeenCalledWith('/reamon/code/deobfuscate', expect.objectContaining({
      method: 'POST', body: expect.stringContaining('"model":"custom/provider-1"'),
    }), { timeoutMs: 90_000 })
    expect(String(h.agentFetch.mock.calls.at(-1)?.[1]?.body)).toContain('"source_code":"return state.value;"')
    expect(String(h.agentFetch.mock.calls.at(-1)?.[1]?.body)).not.toContain('apiKey')
  })

  it('bounds project memory reads and still supplies saved symbol names to the model', async () => {
    h.maintainedSource.mockResolvedValueOnce([
      { unitName: 'example.ProductStore', language: 'Java', symbolIndex: ['loadProduct', 'persistProduct'] },
    ])
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ source_code: 'return productStore.loadProduct();' }), { status: 200 }))

    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(200)
    expect(h.maintainedSource).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1' },
      take: 256,
      orderBy: { updatedAt: 'desc' },
    }))
    const payload = JSON.parse(String(h.agentFetch.mock.calls.at(-1)?.[1]?.body))
    expect(payload.project_symbol_context).toContain('example.ProductStore (Java): loadProduct, persistProduct')
  })

  it('preserves artifact identity for same-named project memory entries', async () => {
    h.maintainedSource.mockResolvedValueOnce([
      { codeUnitId: 'unit-v1', artifactId: 'artifact-v1', unitName: 'example.ProductStore', language: 'Java', symbolIndex: ['loadProduct'] },
      { codeUnitId: 'unit-v2', artifactId: 'artifact-v2', unitName: 'example.ProductStore', language: 'Java', symbolIndex: ['fetchProduct'] },
    ])
    h.artifacts.mockResolvedValueOnce([
      { id: 'artifact-v1', originalName: 'app.apk', sha256: '111111111111aaaaaaaa' },
      { id: 'artifact-v2', originalName: 'app.apk', sha256: '222222222222bbbbbbbb' },
    ])
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ source_code: 'return productStore.fetchProduct();' }), { status: 200 }))

    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(200)
    const payload = JSON.parse(String(h.agentFetch.mock.calls.at(-1)?.[1]?.body))
    expect(payload.project_symbol_context).toContain('example.ProductStore (Java; artifact app.apk #111111111111): loadProduct')
    expect(payload.project_symbol_context).toContain('example.ProductStore (Java; artifact app.apk #222222222222): fetchProduct')
  })

  it('explains when a draft belongs to a different Java type', async () => {
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'wrong_target' }), { status: 422 }))
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: 'The model still returned a different Java type after retrying with the selected file only. Choose a stronger model.',
    })
  })

  it('explains when a draft removes executable Java logic', async () => {
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'behavior_dropped' }), { status: 422 }))
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: 'The model removed executable Java logic. Choose a stronger model or retry with a narrower transformation.',
    })
  })

  it('shows a helpful error when the model context window is too small', async () => {
    h.agentFetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'context_exceeded' }), { status: 413 }))
    const response = await deobfuscate(request({ unitId: 'unit-1', providerId: 'provider-1' }), routeParams)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: 'This code unit exceeds the model context window even after related-code context was removed. Choose a larger-context model or a smaller code unit.',
    })
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
