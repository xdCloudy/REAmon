import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), provider: vi.fn(), observation: vi.fn(), artifact: vi.fn(),
  maintainedSource: vi.fn(), agentFetch: vi.fn(), root: vi.fn(), resolvePath: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  userLlmProvider: { findFirst: h.provider },
  reamonObservation: { findFirst: h.observation },
  artifact: { findFirst: h.artifact },
  reamonMaintainedSource: { findMany: h.maintainedSource },
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
    id: 'unit-1', artifactId: 'artifact-1', label: 'MainActivity.onCreate',
    attributes: { qualifiedName: 'MainActivity.onCreate', language: 'Java', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/MainActivity.java' },
  })
  h.artifact.mockResolvedValue({ id: 'artifact-1' })
  h.maintainedSource.mockResolvedValue([])
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
