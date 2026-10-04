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

  it('identifies WebAssembly modules from their versioned binary header', () => {
    const profile = profileArtifact(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), 'module.wasm')

    expect(profile).toMatchObject({ targetType: 'FILE', format: 'wasm', mimeType: 'application/wasm', architecture: 'wasm32', platform: 'webassembly', runtimes: ['wasm'] })
  })

  it('identifies standalone Android DEX bytecode', () => {
    const bytes = new Uint8Array([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00])
    const profile = profileArtifact(bytes, 'classes.dex')

    expect(profile).toMatchObject({
      targetType: 'FILE', format: 'dex', mimeType: 'application/vnd.android.dex', platform: 'android',
      runtimes: ['dalvik', 'art'], metadata: { hasMagic: true },
    })
  })

  it('identifies standalone JVM class files from their class-file magic', () => {
    const profile = profileArtifact(new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x3d]), 'Main.class')

    expect(profile).toMatchObject({
      targetType: 'FILE', format: 'class', mimeType: 'application/java-vm', platform: 'jvm',
      runtimes: ['jvm'], metadata: { hasMagic: true },
    })
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

  it('classifies JSON configuration separately from source code', () => {
    const profile = profileArtifact(new TextEncoder().encode('{"enabled":true}'), 'settings.json')
    expect(profile).toMatchObject({ format: 'json', mimeType: 'application/json', targetType: 'FILE' })
  })
})
