import { describe, expect, test } from 'vitest'
import { sourceSyntaxLanguage } from './source-language'

describe('sourceSyntaxLanguage', () => {
  test('recognizes analyzer language labels', () => {
    expect(sourceSyntaxLanguage('Java', 'MainActivity.java')).toBe('java')
    expect(sourceSyntaxLanguage('C++', 'main.cpp')).toBe('cpp')
    expect(sourceSyntaxLanguage('WebAssembly Text (WAT)', 'module.wat')).toBeUndefined()
    expect(sourceSyntaxLanguage('Smali', 'MainActivity.smali')).toBeUndefined()
  })

  test('falls back to the artifact extension when the language is unknown', () => {
    expect(sourceSyntaxLanguage('Custom native output', 'module.rs')).toBe('rust')
    expect(sourceSyntaxLanguage(null, 'module.wat')).toBeUndefined()
    expect(sourceSyntaxLanguage(null, null)).toBeUndefined()
  })
})
