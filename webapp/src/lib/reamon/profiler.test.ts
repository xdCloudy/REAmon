import { describe, expect, it } from 'vitest'
import { profileArtifact } from './profiler'

describe('REAmon target profiler', () => {
  it('identifies ELF architecture without requiring a platform-specific tool', () => {
    const bytes = new Uint8Array(32)
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2], 0)
    bytes[18] = 0x3e

    const profile = profileArtifact(bytes, 'libsample.so')

    expect(profile.targetType).toBe('FILE')
    expect(profile.format).toBe('elf')
    expect(profile.architecture).toBe('x86_64')
    expect(profile.runtimes).toContain('native-library')
  })

  it('keeps an unrecognised input valid as an UNKNOWN target', () => {
    const profile = profileArtifact(new Uint8Array([1, 2, 3, 4]), 'mystery.dat')

    expect(profile.targetType).toBe('UNKNOWN')
    expect(profile.format).toBe('unknown')
    expect(profile.metadata.hasMagic).toBe(false)
  })

  it('uses a source extension as a low-confidence format hint', () => {
    const profile = profileArtifact(new TextEncoder().encode('int main() {}'), 'main.c')

    expect(profile.targetType).toBe('FILE')
    expect(profile.format).toBe('source')
    expect(profile.mimeType).toBe('text/plain')
  })
})
