import { describe, expect, it } from 'vitest'
import {
  instructionSequencesAreCompatible,
  instructionSequenceFamily,
  rankSimilarInstructionFunctions,
} from './instruction-similarity'

describe('instruction similarity families', () => {
  it('matches Dalvik and Smali sequences across providers', () => {
    expect(instructionSequencesAreCompatible(
      { providerId: 'reamon-dex-decompiler', artifactId: 'apk-a', attributes: { instructionLanguage: 'Dalvik' } },
      { providerId: 'reamon-jadx', artifactId: 'apk-b', attributes: { instructionLanguage: 'Smali' } },
    )).toBe(true)
  })

  it('matches native sequences only within a normalized architecture family', () => {
    expect(instructionSequencesAreCompatible(
      { providerId: 'reamon-ghidra', artifactId: 'binary-a', attributes: { instructionArchitecture: 'x86:LE:64:default' } },
      { providerId: 'reamon-kuna', artifactId: 'binary-b', attributes: { architecture: 'amd64' } },
    )).toBe(true)
    expect(instructionSequencesAreCompatible(
      { providerId: 'reamon-ghidra', artifactId: 'binary-a', attributes: { instructionArchitecture: 'x86:LE:64:default' } },
      { providerId: 'reamon-kuna', artifactId: 'binary-b', attributes: { architecture: 'arm64' } },
    )).toBe(false)
  })

  it('keeps managed IL compatible and Lua bytecode version-specific', () => {
    expect(instructionSequencesAreCompatible(
      { providerId: 'reamon-ilspy', artifactId: 'assembly-a', attributes: { instructionLanguage: 'IL' } },
      { providerId: 'another-il-provider', artifactId: 'assembly-b', attributes: { instructionLanguage: 'CIL' } },
    )).toBe(true)
    expect(instructionSequencesAreCompatible(
      { providerId: 'reamon-unluac-rs', artifactId: 'lua-a', attributes: { dialect: 'lua5.3' } },
      { providerId: 'reamon-unluac-rs', artifactId: 'lua-b', attributes: { dialect: 'lua5.4' } },
    )).toBe(false)
  })

  it('scopes sequences without language metadata to their provider and artifact', () => {
    const sequence = { providerId: 'future-provider', artifactId: 'same-file', attributes: {} }
    expect(instructionSequenceFamily(sequence)).toBe('provider-artifact:future-provider:same-file')
    expect(instructionSequencesAreCompatible(sequence, { ...sequence })).toBe(true)
    expect(instructionSequencesAreCompatible(sequence, { ...sequence, artifactId: 'other-file' })).toBe(false)
    expect(instructionSequencesAreCompatible(sequence, { ...sequence, providerId: 'other-provider' })).toBe(false)
  })

  it('does not treat generic assembly labels as a cross-provider architecture', () => {
    const x86 = { providerId: 'provider-a', artifactId: 'binary-a', attributes: { instructionLanguage: 'Assembly' } }
    const arm = { providerId: 'provider-b', artifactId: 'binary-b', attributes: { instructionLanguage: 'Assembly' } }
    expect(instructionSequencesAreCompatible(x86, arm)).toBe(false)
  })
})

describe('rankSimilarInstructionFunctions', () => {
  it('finds renamed functions from matching ordered instruction sequences', () => {
    expect(rankSimilarInstructionFunctions(
      { key: 'source-a', name: 'old_name', address: '0x1000', mnemonics: ['load', 'store', 'call', 'return'] },
      [{ key: 'source-b', name: 'new_name', address: '0x2000', mnemonics: ['load', 'store', 'call', 'return'] }],
    )).toEqual([expect.objectContaining({ key: 'source-b', name: 'new_name', similarity: 100, instructionSimilarity: 100 })])
  })
})
