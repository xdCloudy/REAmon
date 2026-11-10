/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  user: vi.fn(), strictAccess: vi.fn(), selection: vi.fn(), unit: vi.fn(), tasks: vi.fn(),
  currentTask: vi.fn(), observations: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  task: { findMany: h.tasks, findFirst: h.currentTask },
  reamonObservation: { findMany: h.observations, findFirst: h.unit },
} }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccessStrict: h.strictAccess }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))

import { GET } from './route'

const artifactHash = 'a'.repeat(64)
const routeParams = { params: Promise.resolve({ id: 'project-1' }) }
let derivedRoot = ''
const priorDerivedRoot = process.env.REAMON_DERIVED_PATH

async function arrangeProviderOutputs(count: number, providerForIndex = (index: number) => `reamon-provider-${String(index).padStart(2, '0')}`) {
  const outputs = Array.from({ length: count }, (_, index) => {
    const taskId = `provider-task-${index}`
    const runToken = `run-${index}`
    const source = providerForIndex(index)
    const sourceText = `int function_${index}(void) { return ${index}; }\n`
    const codeArtifactId = `project-1/artifact-1/${taskId}/${runToken}/sources/module.c`
    const task = { id: taskId, runToken, completedAt: new Date(`2026-10-28T00:${String(index).padStart(2, '0')}:00Z`), provider: { pluginId: source } }
    return {
      task,
      observation: {
        id: `observation-${index}`, taskId, source, label: `function_${index}`,
        task,
        attributes: {
          codeArtifactId,
          codeArtifactSha256: createHash('sha256').update(sourceText).digest('hex'),
          inputArtifactSha256: artifactHash,
          relativePath: 'sources/module.c', language: 'C', address: '0x401000',
          qualifiedName: `function_${index}`,
          ...(source === 'reamon-arlecchino' ? {
            providerLineageKind: 'derived-composite',
            providerUpstreamProviderIds: 'reamon-vineflower,reamon-cfr,reamon-jadx',
            providerSelectionPolicy: 'per-class compiler-error ranking and source merge',
          } : {}),
        },
      },
      sourceText,
    }
  })

  for (const { observation, sourceText } of outputs) {
    const relative = observation.attributes.codeArtifactId
    const filePath = path.join(derivedRoot, relative)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, sourceText)
  }
  const observations = outputs.map(({ observation }) => observation)
  h.observations.mockImplementation((query: { cursor?: { id: string }; take: number }) => {
    const cursorIndex = query.cursor ? observations.findIndex((row) => row.id === query.cursor?.id) : -1
    return Promise.resolve(observations.slice(cursorIndex + 1, cursorIndex + 1 + query.take))
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.strictAccess.mockResolvedValue({ projectId: 'project-1' })
  h.selection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: 'active-import' } })
  h.unit.mockResolvedValue({
    id: 'selected-unit', taskId: 'selected-task', artifactId: 'artifact-1', source: 'reamon-ghidra',
    attributes: {
      relativePath: 'sources/module.c', language: 'C', address: '0x401000', identity: 'sub_401000',
      inputArtifactSha256: artifactHash,
      codeArtifactSha256: createHash('sha256').update('int selected(void) { return 0; }\n').digest('hex'),
    },
    artifact: { sha256: artifactHash },
  })
  h.currentTask.mockResolvedValue({
    id: 'selected-task', runToken: 'selected-run', completedAt: new Date('2026-10-28T00:00:00Z'),
    provider: { pluginId: 'reamon-ghidra' },
  })
  derivedRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-alternates-'))
  process.env.REAMON_DERIVED_PATH = derivedRoot
})

afterEach(async () => {
  if (derivedRoot) await rm(derivedRoot, { recursive: true, force: true })
  if (priorDerivedRoot === undefined) delete process.env.REAMON_DERIVED_PATH
  else process.env.REAMON_DERIVED_PATH = priorDerivedRoot
})

describe('GET /api/projects/[id]/visualizer/alternates', () => {
  it('denies a foreign project before reading selected units or alternate evidence', async () => {
    h.strictAccess.mockResolvedValueOnce(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await GET(new Request('http://localhost?unitId=selected-unit'), routeParams)

    expect(response.status).toBe(404)
    expect(h.selection).not.toHaveBeenCalled()
    expect(h.unit).not.toHaveBeenCalled()
    expect(h.observations).not.toHaveBeenCalled()
  })

  it('returns more than four hash-verified provider outputs for the same source unit', async () => {
    await arrangeProviderOutputs(8)

    const response = await GET(new Request('http://localhost?unitId=selected-unit'), routeParams)
    const result = await response.json() as { alternates: Array<{ providerId: string; source: string }>; truncated: boolean }

    expect(response.status).toBe(200)
    expect(result.alternates).toHaveLength(8)
    expect(result.alternates.map((alternate) => alternate.providerId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `reamon-provider-${String(index).padStart(2, '0')}`),
    )
    expect(result.alternates[7].source).toContain('function_7')
    expect(result.truncated).toBe(false)
    expect(h.tasks).not.toHaveBeenCalled()
    expect(h.observations).toHaveBeenCalledWith(expect.objectContaining({ take: 101 }))
    expect(h.observations.mock.calls[0][0].where.task).toEqual({
      is: { projectId: 'project-1', artifactId: 'artifact-1', capability: 'decompile', status: 'COMPLETED' },
    })
    expect(h.observations.mock.calls[0][0].select.task).toBeDefined()
  })

  it('reports Arlecchino as a derived composite rather than an independent provider', async () => {
    await arrangeProviderOutputs(1, () => 'reamon-arlecchino')

    const response = await GET(new Request('http://localhost?unitId=selected-unit'), routeParams)
    const result = await response.json() as { alternates: Array<{ providerId: string; providerLineage: { kind: string; upstreamProviderIds: string[]; selectionPolicy: string | null } }> }

    expect(response.status).toBe(200)
    expect(result.alternates[0].providerId).toBe('reamon-arlecchino')
    expect(result.alternates[0].providerLineage).toEqual({
      kind: 'derived-composite',
      upstreamProviderIds: ['reamon-vineflower', 'reamon-cfr', 'reamon-jadx'],
      selectionPolicy: 'per-class compiler-error ranking and source merge',
    })
  })

  it('retains ReIPA ancestry on the verified same-run alternate', async () => {
    const sourceText = 'int reipa_function(void) { return 1; }\n'
    const codeArtifactId = 'project-1/artifact-1/selected-task/selected-run/alternates/reipa/function.c'
    const outputHash = createHash('sha256').update(sourceText).digest('hex')
    h.unit.mockResolvedValueOnce({
      id: 'selected-unit', taskId: 'selected-task', artifactId: 'artifact-1', source: 'reamon-ghidra',
      attributes: {
        relativePath: 'functions/main.c', language: 'C', address: '0x401000', identity: 'sub_401000',
        inputArtifactSha256: artifactHash, codeArtifactSha256: 'd'.repeat(64),
        reipaAlternateCodeArtifactId: codeArtifactId,
        reipaAlternateOutputSha256: outputHash,
        reipaAlternateProviderVersion: `ReIPA@${'a'.repeat(40)}`,
        alternateProviderLineageJson: JSON.stringify({
          'reamon-reipa': {
            kind: 'co-run', upstreamProviderIds: [],
            selectionPolicy: 'persisted ReIPA task lineage; provider independence is unmeasured',
          },
        }),
      },
      artifact: { sha256: artifactHash },
    })
    h.observations.mockResolvedValue([])
    await mkdir(path.dirname(path.join(derivedRoot, codeArtifactId)), { recursive: true })
    await writeFile(path.join(derivedRoot, codeArtifactId), sourceText)

    const response = await GET(new Request('http://localhost?unitId=selected-unit'), routeParams)
    const result = await response.json() as { alternates: Array<{ providerId: string; providerLineage: { kind: string; upstreamProviderIds: string[]; selectionPolicy: string | null } }> }

    expect(response.status).toBe(200)
    expect(result.alternates).toContainEqual(expect.objectContaining({
      providerId: 'reamon-reipa',
      providerLineage: {
        kind: 'co-run',
        upstreamProviderIds: [],
        selectionPolicy: 'persisted ReIPA task lineage; provider independence is unmeasured',
      },
    }))
  })

  it('marks ReIPA as a same-task output with unmeasured provider independence', async () => {
    const sourceText = 'int reipa_function(void) { return 1; }\n'
    const codeArtifactId = 'project-1/artifact-1/selected-task/selected-run/alternates/reipa/function.c'
    const outputHash = createHash('sha256').update(sourceText).digest('hex')
    h.unit.mockResolvedValueOnce({
      id: 'selected-unit', taskId: 'selected-task', artifactId: 'artifact-1', source: 'reamon-ghidra',
      attributes: {
        relativePath: 'functions/main.c', language: 'C', address: '0x401000', identity: 'sub_401000',
        inputArtifactSha256: artifactHash, codeArtifactSha256: 'd'.repeat(64),
        reipaAlternateCodeArtifactId: codeArtifactId,
        reipaAlternateOutputSha256: outputHash,
        reipaAlternateProviderVersion: `ReIPA@${'a'.repeat(40)}`,
      },
      artifact: { sha256: artifactHash },
    })
    h.observations.mockResolvedValue([])
    await mkdir(path.dirname(path.join(derivedRoot, codeArtifactId)), { recursive: true })
    await writeFile(path.join(derivedRoot, codeArtifactId), sourceText)

    const response = await GET(new Request('http://localhost?unitId=selected-unit'), routeParams)
    const result = await response.json() as { alternates: Array<{ providerId: string; providerLineage: { kind: string; upstreamProviderIds: string[]; selectionPolicy: string | null } }> }

    expect(response.status).toBe(200)
    expect(result.alternates).toContainEqual(expect.objectContaining({
      providerId: 'reamon-reipa',
      providerLineage: {
        kind: 'co-run',
        upstreamProviderIds: [],
        selectionPolicy: 'ReIPA pseudocode extracted during the Ghidra analysis task; provider independence is unmeasured',
      },
    }))
  })

  it('pages through provider outputs without hiding providers after the per-response bound', async () => {
    await arrangeProviderOutputs(34)

    const response = await GET(new Request('http://localhost?unitId=selected-unit'), routeParams)
    const result = await response.json() as { alternates: Array<{ providerId: string }>; truncated: boolean; nextCursor: string | null }

    expect(response.status).toBe(200)
    expect(result.alternates).toHaveLength(32)
    expect(result.truncated).toBe(true)
    expect(result.nextCursor).toBe('observation-31')

    const nextResponse = await GET(new Request(`http://localhost?unitId=selected-unit&after=${result.nextCursor}`), routeParams)
    const nextPage = await nextResponse.json() as { alternates: Array<{ providerId: string }>; truncated: boolean; nextCursor: string | null }
    expect(nextPage.alternates.map((alternate) => alternate.providerId)).toEqual(['reamon-provider-32', 'reamon-provider-33'])
    expect(nextPage.truncated).toBe(false)
    expect(nextPage.nextCursor).toBeNull()
    expect(h.observations.mock.calls[1][0].cursor).toEqual({ id: 'observation-31' })
  })
})
