import { describe, expect, test } from 'vitest'
import { buildWorkspaceAnalysisPlan } from './analysis-plan'
import type { WorkspaceFileQueryResult } from './inventory-query'
import type { TargetProfile } from './types'

const profile: TargetProfile = {
  targetType: 'FILE',
  format: 'pe',
  mimeType: 'application/vnd.microsoft.portable-executable',
  extension: 'dll',
  architecture: 'x86-64',
  platform: 'windows',
  runtimes: ['native'],
  embeddedArtifacts: [],
  entropy: null,
  metadata: {},
}

const inventory: WorkspaceFileQueryResult = {
  artifacts: [
    {
      id: 'artifact-1', name: 'engine.dll', relativePath: 'bin/engine.dll', parentPath: 'bin',
      targetId: 'target-1', importId: 'import-1', sizeBytes: 10, sha256: 'hash-1', extension: 'dll',
      status: 'IDENTIFIED', profile,
      capabilities: [{
        pluginId: 'ghidra', pluginName: 'Ghidra', category: 'static_analysis', integration: 'process',
        acceptsTargetTypes: ['FILE'], acceptsFormats: ['pe'],
        capabilities: ['disassemble', 'decompile'], produces: ['Function'], requirements: [],
      }],
    },
    {
      id: 'artifact-2', name: 'settings.json', relativePath: 'config/settings.json', parentPath: 'config',
      targetId: null, importId: 'import-1', sizeBytes: 12, sha256: 'hash-2', extension: 'json',
      status: 'DISCOVERED', profile: { ...profile, format: 'json', extension: 'json' }, capabilities: [],
    },
  ],
  total: 2,
  limit: 100,
  offset: 0,
  hasMore: false,
}

describe('workspace analysis planning', () => {
  test('expands compatible provider capabilities without executing them', () => {
    const plan = buildWorkspaceAnalysisPlan('project-1', inventory)

    expect(plan).toMatchObject({
      projectId: 'project-1',
      source: 'ACTIVE_WORKSPACE_INVENTORY',
      candidateArtifacts: 2,
      returnedArtifacts: 2,
      proposedSteps: 2,
      hasMoreArtifacts: false,
      hasMoreSteps: false,
    })
    expect(plan.steps).toEqual([
      expect.objectContaining({
        id: 'artifact-1:ghidra:disassemble',
        status: 'PROPOSED',
        artifactId: 'artifact-1',
        relativePath: 'bin/engine.dll',
        capability: 'disassemble',
        provider: expect.objectContaining({ pluginId: 'ghidra' }),
      }),
      expect.objectContaining({ id: 'artifact-1:ghidra:decompile', capability: 'decompile' }),
    ])
  })

  test('filters by capability and preserves paging state', () => {
    const page = { ...inventory, artifacts: inventory.artifacts.slice(0, 1), total: 3, hasMore: true }
    const plan = buildWorkspaceAnalysisPlan('project-1', page, {
      capability: ' DISASSEMBLE ', search: 'engine', limit: 1, offset: 2,
    })

    expect(plan.requestedCapability).toBe('disassemble')
    expect(plan.query).toEqual({ capability: ' DISASSEMBLE ', search: 'engine', limit: 1, offset: 2 })
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({ capability: 'disassemble', relativePath: 'bin/engine.dll' })
    expect(plan.hasMoreArtifacts).toBe(true)
    expect(plan.hasMoreSteps).toBe(true)
  })
})
