/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(), selection: vi.fn(), unit: vi.fn(), tasks: vi.fn(),
  currentTask: vi.fn(), observations: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  task: { findMany: h.tasks, findFirst: h.currentTask },
  reamonObservation: { findMany: h.observations, findFirst: h.unit },
} }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccess: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))

import { GET } from './route'

const artifactHash = 'a'.repeat(64)
const routeParams = { params: Promise.resolve({ id: 'project-1' }) }
let derivedRoot = ''
const priorDerivedRoot = process.env.REAMON_DERIVED_PATH

async function arrangeProviderOutputs(count: number) {
  const outputs = Array.from({ length: count }, (_, index) => {
    const taskId = `provider-task-${index}`
    const runToken = `run-${index}`
    const source = `reamon-provider-${String(index).padStart(2, '0')}`
    const sourceText = `int function_${index}(void) { return ${index}; }\n`
    const codeArtifactId = `project-1/artifact-1/${taskId}/${runToken}/sources/module.c`
    return {
      task: { id: taskId, runToken, completedAt: new Date(`2026-10-28T00:${String(index).padStart(2, '0')}:00Z`), provider: { pluginId: source } },
      observation: {
        id: `observation-${index}`, taskId, source, label: `function_${index}`,
        attributes: {
          codeArtifactId,
          codeArtifactSha256: createHash('sha256').update(sourceText).digest('hex'),
          inputArtifactSha256: artifactHash,
          relativePath: 'sources/module.c', language: 'C', address: '0x401000',
          qualifiedName: `function_${index}`,
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
  h.tasks.mockResolvedValue(outputs.map(({ task }) => task))
  h.observations.mockResolvedValue(outputs.map(({ observation }) => observation))
}

beforeEach(async () => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.access.mockResolvedValue({ projectId: 'project-1' })
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
    expect(h.tasks).toHaveBeenCalledWith(expect.objectContaining({ take: 501 }))
    expect(h.observations).toHaveBeenCalledWith(expect.objectContaining({ take: 501 }))
  })

  it('marks the comparison truncated when the provider-output bound is reached', async () => {
    await arrangeProviderOutputs(34)

    const response = await GET(new Request('http://localhost?unitId=selected-unit'), routeParams)
    const result = await response.json() as { alternates: Array<{ providerId: string }>; truncated: boolean }

    expect(response.status).toBe(200)
    expect(result.alternates).toHaveLength(32)
    expect(result.truncated).toBe(true)
  })
})
