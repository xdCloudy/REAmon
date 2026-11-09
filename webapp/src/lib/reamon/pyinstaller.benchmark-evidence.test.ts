import { describe, expect, it } from 'vitest'

import {
  createPyInstallerBenchmarkEvidence,
  matchesPyInstallerFixtureSource,
  matchesPyInstallerSource,
  matchesPyInstallerStructuredFixtureSource,
  mutatePyInstallerStructuredFixtureSource,
  PYINSTALLER_STRUCTURED_SOURCE_FIXTURE_ID,
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
    expect(matchesPyInstallerSource('LABEL = "same"', "LABEL = 'same'")).toBe(true)
    expect(matchesPyInstallerSource('VALUE = 1\n+ 2', 'VALUE = 1 + 2')).toBe(false)
    expect(matchesPyInstallerSource('def f():\n    returnvalue', 'def f():\n    return value')).toBe(false)
    expect(matchesPyInstallerSource('def f():\n        return 1', 'def f():\n    return 1')).toBe(false)
  })

  it('matches control flow from the pinned pycdc output without erasing string changes', () => {
    const expected = [
      'def normalize_items(items):',
      '    result = []',
      '    for item in items:',
      '        if item is not None:',
      '            result.append(str(item).strip().lower())',
      '    return result',
      '',
      'def classify(value):',
      '    try:',
      '        score = int(value)',
      '    except (TypeError, ValueError):',
      '        return "invalid"',
      '    if score < 0:',
      '        return f"negative:{-score}"',
      '    if score == 0:',
      '        return "zero"',
      '    return "positive"',
    ].join('\n')
    const recovered = [
      'def normalize_items(items):',
      '    result = []',
      '    for item in items:',
      '        if item is not None:',
      '            result.append(str(item).strip().lower())',
      '    return result',
      '',
      'def classify(value):',
      '    try:',
      '        score = int(value)',
      '    except (TypeError, ValueError):',
      "        return 'invalid'",
      '    if score < 0:',
      '        return f"negative:{-score}"',
      '    if score == 0:',
      "        return 'zero'",
      "    return 'positive'",
    ].join('\n')

    expect(matchesPyInstallerSource(recovered, expected)).toBe(true)
    expect(matchesPyInstallerSource(recovered.replace("'invalid'", "'not invalid'"), expected)).toBe(false)
  })

  it('matches the versioned structured fixture source and keeps its identity stable', () => {
    expect(PYINSTALLER_STRUCTURED_SOURCE_FIXTURE_ID).toBe('pyinstaller-module-structured-source-linux-amd64')
    expect(matchesPyInstallerStructuredFixtureSource(
      'VALUE = 12\ndef classify(candidate):\n    if candidate < VALUE:\n        return \'below\'\n    return \'at-or-above\'\n',
      12,
    )).toBe(true)
    expect(matchesPyInstallerStructuredFixtureSource(
      'VALUE = 12\ndef classify(candidate):\n    if candidate <= VALUE:\n        return \'below\'\n    return \'at-or-above\'\n',
      12,
    )).toBe(false)
  })

  it('mutates exactly one structured return value as a behavior-changing negative control', () => {
    const source = 'VALUE = 12\ndef classify(candidate):\n    if candidate < VALUE:\n        return "below"\n    return "at-or-above"\n'
    const mutated = mutatePyInstallerStructuredFixtureSource(source)

    expect(mutated).toContain('return "under"')
    expect(matchesPyInstallerStructuredFixtureSource(mutated!, 12)).toBe(false)
    expect(mutatePyInstallerStructuredFixtureSource(source.replace('"below"', '"already-mutated"'))).toBeUndefined()
    expect(mutatePyInstallerStructuredFixtureSource(source.replace('"below"', '"below"\n        return "below"'))).toBeUndefined()
  })

  it('records complete structured mutation-control denominators without changing legacy fixtures', () => {
    const evidence = createPyInstallerBenchmarkEvidence({
      ...input,
      fixtureId: PYINSTALLER_STRUCTURED_SOURCE_FIXTURE_ID,
      structuredMutationRejectedCount: 70,
      structuredMutationFalseAcceptanceCount: 0,
    })
    const metrics = evidence.fixtures[PYINSTALLER_STRUCTURED_SOURCE_FIXTURE_ID].metrics

    expect(metrics.negative_control_mutation_rejection).toEqual({ state: 'MEASURED', value: 70, denominator: 70 })
    expect(metrics.negative_control_false_acceptance).toEqual({ state: 'MEASURED', value: 0, denominator: 70 })
    expect(() => createPyInstallerBenchmarkEvidence({
      ...input,
      fixtureId: PYINSTALLER_STRUCTURED_SOURCE_FIXTURE_ID,
      structuredMutationRejectedCount: 69,
      structuredMutationFalseAcceptanceCount: 0,
    })).toThrow('cover all 70 source modules')
  })
})
