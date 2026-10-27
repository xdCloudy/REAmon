/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const priorRows = vi.hoisted(() => [] as Array<{
  id: string
  stableKey: string
  attributes: Record<string, unknown>
  createdAt: Date
}>)

vi.mock('@/lib/prisma', () => ({
  default: { reamonObservation: { findMany: vi.fn(async () => priorRows) } },
}))

import { executePyInstaller } from './pyinstaller'
import type { ToolExecutionInput, ToolObservation } from './types'

const liveConfig = {
  analyzerUrl: process.env.REAMON_PYINSTALLER_URL,
  artifactPath: process.env.REAMON_PYINSTALLER_FIXTURE_PATH,
}
const canRunLive = Boolean(liveConfig.analyzerUrl && liveConfig.artifactPath && process.env.REAMON_PYCDC_URL)

describe('live PyInstaller extraction and pycdc paging', () => {
  beforeEach(() => {
    priorRows.splice(0)
  })

  it.skipIf(!canRunLive)('continues across the 64-module page boundary using saved project observations', async () => {
    const ids = { projectId: 'qa-project', artifactId: 'qa-pyi-fixture' }
    const commonInput: Omit<ToolExecutionInput, 'taskId' | 'runToken'> = {
      targetProfile: {
        targetType: 'FILE',
        format: 'elf',
        mimeType: 'application/x-executable',
        extension: 'elf',
        architecture: null,
        platform: 'linux',
        runtimes: ['python'],
        embeddedArtifacts: [],
        entropy: null,
        metadata: { containerFormat: 'pyinstaller' },
      },
      ...ids,
      artifactPath: liveConfig.artifactPath,
      artifactRelativePath: 'qa/pagination_fixture',
    }

    let lastResult: Awaited<ReturnType<typeof executePyInstaller>> | undefined
    let lastInput: ToolExecutionInput | undefined
    for (let run = 0; run < 17; run += 1) {
      const input: ToolExecutionInput = {
        ...commonInput,
        taskId: `qa-pagination-${run}`,
        runToken: `run-${run}`,
      }
      lastInput = input
      lastResult = await executePyInstaller(input)
      expect(lastResult.status, lastResult.status === 'failed' ? lastResult.error : undefined).toBe('completed')
      for (const observation of lastResult.data.observations as ToolObservation[]) {
        const existing = priorRows.find((row) => row.stableKey === observation.key)
        if (existing) {
          existing.attributes = observation.attributes
          existing.createdAt = new Date(Date.now() + run)
        } else {
          priorRows.push({
            id: `qa-observation-${priorRows.length}`,
            stableKey: observation.key,
            attributes: observation.attributes,
            createdAt: new Date(Date.now() + run),
          })
        }
      }
    }

    expect(lastInput?.taskId).toBe('qa-pagination-16')
    expect(lastResult?.data.extractedModuleCount).toBeGreaterThan(64)
    expect(lastResult?.data.modulePageOffset).toBe(64)
    expect(lastResult?.data.nextModulePageOffset).toBe(128)
    expect(lastResult?.data.decompiledModuleCount).toBeGreaterThan(0)
  }, 180_000)
})
