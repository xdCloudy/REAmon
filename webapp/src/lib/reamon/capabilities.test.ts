/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { resolveCapabilities, resolveWorkspaceCapabilities } from './capabilities'
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
  it('offers JADX decompilation for an identified Android APK', () => {
    expect(resolveCapabilities(profile({
      format: 'apk',
      extension: 'apk',
      mimeType: 'application/vnd.android.package-archive',
      architecture: null,
      platform: 'android',
      runtimes: ['dalvik', 'art'],
      embeddedArtifacts: ['dex', 'resources'],
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'reamon-jadx', capabilities: ['decompile'] }),
    ]))
  })

  it('offers JADX decompilation for an identified Java archive', () => {
    expect(resolveCapabilities(profile({
      format: 'jar',
      extension: 'jar',
      mimeType: 'application/java-archive',
      architecture: null,
      platform: 'jvm',
      runtimes: ['jvm'],
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'reamon-jadx', capabilities: ['decompile'], acceptsFormats: ['apk', 'jar', 'dex', 'class'] }),
    ]))
  })

  it('offers ILSpy decompilation only for managed PE assemblies', () => {
    const managed = resolveCapabilities(profile({ format: 'pe-dotnet', extension: 'dll', platform: 'windows', runtimes: ['dotnet'] }))
    expect(managed).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'reamon-ilspy', capabilities: ['decompile'], acceptsFormats: ['pe-dotnet'] }),
    ]))
    expect(managed.some((match) => match.pluginId === 'reamon-ghidra')).toBe(false)
    expect(resolveCapabilities(profile({ format: 'pe-dll', extension: 'dll' })).some((match) => match.pluginId === 'reamon-ilspy')).toBe(false)
  })

  it.each([
    { format: 'dex', extension: 'dex', platform: 'android', runtimes: ['dalvik', 'art'] },
    { format: 'class', extension: 'class', platform: 'jvm', runtimes: ['jvm'] },
  ])('offers JADX decompilation for standalone $format bytecode', ({ format, extension, platform, runtimes }) => {
    expect(resolveCapabilities(profile({ format, extension, platform, runtimes }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'reamon-jadx', capabilities: ['decompile'], acceptsFormats: ['apk', 'jar', 'dex', 'class'] }),
    ]))
  })

  it('offers dynamic dependency and symbol extraction for ELF artifacts', () => {
    expect(resolveCapabilities(profile())).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'reamon-elf-dependencies',
        acceptsFormats: ['elf'],
        capabilities: ['extract_dependencies'],
        produces: ['BinaryDependency', 'BinarySymbol', 'Relationship'],
      }),
    ]))
    expect(resolveCapabilities(profile({ format: 'pe' })).some((match) => match.pluginId === 'reamon-elf-dependencies')).toBe(false)
  })

  it('offers the built-in ELF header inspector for ELF artifacts', () => {
    expect(resolveCapabilities(profile())).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'reamon-elf-inspector',
        integration: 'process',
        acceptsFormats: ['elf'],
        capabilities: ['inspect_binary_header'],
      }),
    ]))
  })

  it.each(['apk', 'elf', 'wasm', 'json', 'source', 'unknown'])(
    'offers bounded string extraction for %s artifacts',
    (format) => {
      expect(resolveCapabilities(profile({ format }))).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'reamon-source-inspector',
          pluginName: 'REAmon Strings Inspector',
          acceptsFormats: ['*'],
          capabilities: ['extract_strings'],
        }),
      ]))
    },
  )

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
    expect(matches[0]).toMatchObject({
      category: 'static_analysis',
      acceptsTargetTypes: ['FILE'],
      acceptsFormats: ['elf'],
      capabilities: ['disassemble'],
    })
    expect(resolveCapabilities(profile({ format: 'unknown', targetType: 'UNKNOWN' }), [plugin])).toEqual([])
  })

  it('summarizes providers even before compatible artifacts exist', () => {
    const plugin: ToolPlugin = {
      manifest: {
        id: 'workspace-tool', name: 'Workspace tool', category: 'static_analysis', integration: 'native',
        acceptsTargetTypes: ['FILE'], acceptsFormats: ['elf'], capabilities: ['disassemble'], produces: ['Instruction'], requirements: [],
      },
      async analyze(input) { return { status: 'completed', toolId: 'workspace-tool', capabilities: ['disassemble'], produced: ['Instruction'], data: { input } } },
    }
    expect(resolveWorkspaceCapabilities([], [plugin])).toEqual([{
      pluginId: 'workspace-tool', pluginName: 'Workspace tool', category: 'static_analysis', integration: 'native',
      acceptsTargetTypes: ['FILE'], acceptsFormats: ['elf'], capabilities: ['disassemble'], produces: ['Instruction'],
      requirements: [], compatibleArtifactIds: [],
    }])
    expect(resolveWorkspaceCapabilities([{ id: 'artifact-1', profile: profile() }], [plugin])[0].compatibleArtifactIds).toEqual(['artifact-1'])
  })
})
