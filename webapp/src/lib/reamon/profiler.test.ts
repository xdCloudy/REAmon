import { describe, expect, it } from 'vitest'
import { profileArtifact } from './profiler'

function peFixture(cliHeaderRva = 0): Uint8Array {
  const bytes = new Uint8Array(0x300)
  bytes.set([0x4d, 0x5a], 0)
  bytes[0x3c] = 0x80
  bytes.set([0x50, 0x45, 0, 0], 0x80)
  bytes[0x94] = 0xf0
  bytes[0x95] = 0
  bytes[0x98] = 0x0b
  bytes[0x99] = 0x02
  bytes[0x98 + 108] = 16
  const clrDirectory = 0x98 + 112 + (14 * 8)
  bytes[clrDirectory] = cliHeaderRva & 0xff
  bytes[clrDirectory + 1] = (cliHeaderRva >>> 8) & 0xff
  bytes[clrDirectory + 2] = (cliHeaderRva >>> 16) & 0xff
  bytes[clrDirectory + 3] = (cliHeaderRva >>> 24) & 0xff
  if (cliHeaderRva > 0) bytes[clrDirectory + 4] = 0x48
  return bytes
}

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

  it('identifies managed PE assemblies and leaves native PE files on the native path', () => {
    expect(profileArtifact(peFixture(0x2000), 'library.dll')).toMatchObject({
      format: 'pe-dotnet', mimeType: 'application/vnd.microsoft.portable-executable', platform: 'windows', runtimes: ['dotnet'],
    })
    expect(profileArtifact(peFixture(), 'native.dll')).toMatchObject({ format: 'pe-dll', runtimes: ['native'] })
  })

  it('does not treat a truncated PE optional header as a managed assembly', () => {
    const bytes = peFixture(0x2000)
    bytes[0x94] = 0x20
    bytes[0x95] = 0
    expect(profileArtifact(bytes, 'truncated.exe').format).toBe('pe')
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
