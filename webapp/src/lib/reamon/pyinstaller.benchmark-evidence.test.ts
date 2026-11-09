import { describe, expect, it } from 'vitest'

import {
  createPyInstallerBenchmarkEvidence,
  matchesPyInstallerFixtureSource,
  matchesPyInstallerSource,
} from './pyinstaller.benchmark-evidence'

describe('PyInstaller benchmark evidence', () => {
  const input = {
    fixtureId: 'pyinstaller-module-paging-linux-amd64',
    artifactSha256: 'a'.repeat(64),
    extractedModuleCount: 180,
    knownSourceMatchedCount: 70,
    reconstructionMatchedCount: 70,
    workerTerminalPage: false,
  }

  it('preserves measured denominators and labels unmeasured gates unavailable', () => {
    const evidence = createPyInstallerBenchmarkEvidence(input)
    const metrics = evidence.fixtures[input.fixtureId].metrics

    expect(metrics.extracted_module_count).toEqual({ state: 'MEASURED', value: 180, denominator: 1 })
    expect(metrics.known_source_value_recall).toEqual({ state: 'MEASURED', value: 70, denominator: 70 })
    expect(metrics.runtime_oracle.state).toBe('UNAVAILABLE')
    expect(metrics.reconstruction_match).toEqual({ state: 'MEASURED', value: 70, denominator: 70 })
    expect(metrics.worker_terminal_page).toMatchObject({ state: 'UNAVAILABLE', value: null, denominator: 1 })
  })

  it('records the queued worker terminal page only when the worker integration passes', () => {
    const evidence = createPyInstallerBenchmarkEvidence({ ...input, workerTerminalPage: true })

    expect(evidence.fixtures[input.fixtureId].metrics.worker_terminal_page)
      .toEqual({ state: 'MEASURED', value: 1, denominator: 1 })
  })

  it('rejects invalid artifact hashes and out-of-range known-source counts', () => {
    expect(() => createPyInstallerBenchmarkEvidence({ ...input, artifactSha256: 'not-a-hash' }))
      .toThrow('lowercase artifact SHA-256')
    expect(() => createPyInstallerBenchmarkEvidence({ ...input, knownSourceMatchedCount: 71 }))
      .toThrow('between 0 and 70')
    expect(() => createPyInstallerBenchmarkEvidence({ ...input, reconstructionMatchedCount: 71 }))
      .toThrow('source reconstruction match count')
  })

  it('matches only the complete known single-assignment source after whitespace and comment normalization', () => {
    expect(matchesPyInstallerFixtureSource('# generated header\r\nVALUE = 8  # expected\r\n', 8)).toBe(true)
    expect(matchesPyInstallerFixtureSource('VALUE = 8\nEXTRA = 1\n', 8)).toBe(false)
    expect(matchesPyInstallerFixtureSource('VALUE = 8 + 0\n', 8)).toBe(false)
    expect(matchesPyInstallerFixtureSource('VALUE = 08\n', 8)).toBe(false)
  })

  it('compares multi-line control flow while preserving string contents and comment markers', () => {
    const expected = [
      'def classify(value):',
      '    if value < 0:',
      '        return "negative # value"',
      '    return "nonnegative"',
    ].join('\n')
    const recovered = [
      '# pycdc generated source',
      'def classify ( value ) :',
      '    if value<0 : # negative branch',
      '        return "negative # value"',
      '    return "nonnegative"',
    ].join('\n')

    expect(matchesPyInstallerSource(recovered, expected)).toBe(true)
    expect(matchesPyInstallerSource(recovered.replace('value<0', 'value<=0'), expected)).toBe(false)
    expect(matchesPyInstallerSource('LABEL = "a# b"', 'LABEL = "a # b"')).toBe(false)
    expect(matchesPyInstallerSource('VALUE = 1\n+ 2', 'VALUE = 1 + 2')).toBe(false)
    expect(matchesPyInstallerSource('def f():\n    returnvalue', 'def f():\n    return value')).toBe(false)
    expect(matchesPyInstallerSource('def f():\n        return 1', 'def f():\n    return 1')).toBe(false)
  })
})
