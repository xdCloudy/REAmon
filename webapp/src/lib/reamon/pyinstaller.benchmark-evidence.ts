type MetricMeasurement =
  | { state: 'MEASURED'; value: number; denominator: number }
  | { state: 'UNAVAILABLE'; value: null; denominator: number; reason: string }

type PyInstallerBenchmarkEvidenceInput = {
  fixtureId: string
  artifactSha256: string
  extractedModuleCount: number
  knownSourceMatchedCount: number
  reconstructionMatchedCount: number
  workerTerminalPage: boolean
}

export function matchesPyInstallerFixtureSource(source: string, expectedValue: number): boolean {
  if (!Number.isSafeInteger(expectedValue) || expectedValue < 1 || expectedValue > 70) return false
  const code = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .join('')
    .replace(/\s+/g, '')
  return code === `VALUE=${expectedValue}`
}

export function createPyInstallerBenchmarkEvidence(input: PyInstallerBenchmarkEvidenceInput) {
  if (!/^[a-f0-9]{64}$/.test(input.artifactSha256)) {
    throw new Error('PyInstaller benchmark evidence requires a lowercase artifact SHA-256')
  }
  if (!Number.isSafeInteger(input.extractedModuleCount) || input.extractedModuleCount < 0) {
    throw new Error('PyInstaller extracted module count must be a nonnegative integer')
  }
  if (!Number.isSafeInteger(input.knownSourceMatchedCount)
    || input.knownSourceMatchedCount < 0
    || input.knownSourceMatchedCount > 70) {
    throw new Error('PyInstaller known-source match count must be between 0 and 70')
  }
  if (!Number.isSafeInteger(input.reconstructionMatchedCount)
    || input.reconstructionMatchedCount < 0
    || input.reconstructionMatchedCount > 70) {
    throw new Error('PyInstaller source reconstruction match count must be between 0 and 70')
  }

  const workerMetric: MetricMeasurement = input.workerTerminalPage
    ? { state: 'MEASURED', value: 1, denominator: 1 }
    : {
        state: 'UNAVAILABLE',
        value: null,
        denominator: 1,
        reason: 'The queued worker integration was not enabled or did not reach its terminal page.',
      }

  return {
    schemaVersion: 1,
    producer: 'webapp/src/lib/reamon/pyinstaller.task.database.integration.test.ts',
    fixtures: {
      [input.fixtureId]: {
        artifactSha256: input.artifactSha256,
        metrics: {
          runtime_oracle: {
            state: 'UNAVAILABLE',
            value: null,
            denominator: 1,
            reason: 'This PostgreSQL integration test does not execute the fixture runtime oracle.',
          } satisfies MetricMeasurement,
          extracted_module_count: {
            state: 'MEASURED',
            value: input.extractedModuleCount,
            denominator: 1,
          } satisfies MetricMeasurement,
          known_source_value_recall: {
            state: 'MEASURED',
            value: input.knownSourceMatchedCount,
            denominator: 70,
          } satisfies MetricMeasurement,
          reconstruction_match: {
            state: 'MEASURED',
            value: input.reconstructionMatchedCount,
            denominator: 70,
          } satisfies MetricMeasurement,
          worker_terminal_page: workerMetric,
        },
      },
    },
  }
}
