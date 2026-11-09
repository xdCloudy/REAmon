import { describe, expect, it } from 'vitest'

import { createPyInstallerBenchmarkEvidence } from './pyinstaller.benchmark-evidence'

describe('PyInstaller benchmark evidence', () => {
  const input = {
    fixtureId: 'pyinstaller-module-paging-linux-amd64',
    artifactSha256: 'a'.repeat(64),
    extractedModuleCount: 180,
    knownSourceMatchedCount: 70,
    workerTerminalPage: false,
  }

  it('preserves measured denominators and labels unmeasured gates unavailable', () => {
    const evidence = createPyInstallerBenchmarkEvidence(input)
    const metrics = evidence.fixtures[input.fixtureId].metrics

    expect(metrics.extracted_module_count).toEqual({ state: 'MEASURED', value: 180, denominator: 1 })
    expect(metrics.known_source_value_recall).toEqual({ state: 'MEASURED', value: 70, denominator: 70 })
    expect(metrics.runtime_oracle.state).toBe('UNAVAILABLE')
    expect(metrics.reconstruction_match.state).toBe('UNAVAILABLE')
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
  })
})
