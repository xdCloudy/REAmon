import { describe, expect, it } from 'vitest'
import { resolveCapabilities } from './capabilities'
import type { TargetProfile, ToolPlugin } from './types'

const profile = (overrides: Partial<TargetProfile> = {}): TargetProfile => ({
  targetType: 'FILE',
  format: 'elf',
  mimeType: 'application/x-executable',
  extension: 'so',
  architecture: 'x86_64',
  platform: 'unix-like',
  runtimes: ['native-library'],
  embeddedArtifacts: [],
  entropy: 4.2,
  metadata: {},
  ...overrides,
})

describe('REAmon capability resolution', () => {
  it('matches generic profiling and rejects format-specific tools', () => {
    const plugin: ToolPlugin = {
      manifest: {
        id: 'elf-test-tool',
        name: 'ELF test tool',
        category: 'static_analysis',
        integration: 'process',
        acceptsTargetTypes: ['FILE'],
        acceptsFormats: ['elf'],
        capabilities: ['disassemble'],
        produces: ['Instruction'],
        requirements: [{ key: 'runtime', value: false }],
      },
      async analyze(input) {
        return { status: 'completed', toolId: 'elf-test-tool', capabilities: ['disassemble'], produced: ['Instruction'], data: { input } }
      },
    }

    const matches = resolveCapabilities(profile(), [plugin])
    expect(matches).toHaveLength(1)
    expect(matches[0].capabilities).toEqual(['disassemble'])
    expect(resolveCapabilities(profile({ format: 'unknown', targetType: 'UNKNOWN' }), [plugin])).toEqual([])
  })
})
