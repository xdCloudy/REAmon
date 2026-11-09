type MetricMeasurement =
  | { state: 'MEASURED'; value: number; denominator: number }
  | { state: 'UNAVAILABLE'; value: null; denominator: number; reason: string }

type PyInstallerBenchmarkEvidenceInput = {
  fixtureId: string
  artifactSha256: string
  extractedModuleCount: number
  knownSourceMatchedCount: number
  reconstructionMatchedCount: number
  structuredMutationRejectedCount?: number
  structuredMutationFalseAcceptanceCount?: number
  originalSourceFalseAcceptanceCount?: number
  workerTerminalPage: boolean
}

export const PYINSTALLER_STRUCTURED_SOURCE_FIXTURE_ID = 'pyinstaller-module-structured-source-linux-amd64'
export const PYINSTALLER_MUTATED_SOURCE_CONTROL_FIXTURE_ID = 'pyinstaller-module-mutated-source-control-linux-amd64'

export function matchesPyInstallerFixtureSource(source: string, expectedValue: number): boolean {
  if (!Number.isSafeInteger(expectedValue) || expectedValue < 1 || expectedValue > 70) return false
  return matchesPyInstallerSource(source, `VALUE = ${expectedValue}`)
}

export function matchesPyInstallerStructuredFixtureSource(
  source: string,
  expectedValue: number,
  belowResult: 'below' | 'under' = 'below',
): boolean {
  if (!Number.isSafeInteger(expectedValue) || expectedValue < 1 || expectedValue > 70) return false
  if (belowResult !== 'below' && belowResult !== 'under') return false
  const expectedSource = [
    `VALUE = ${expectedValue}`,
    'def classify(candidate):',
    '    if candidate < VALUE:',
    `        return "${belowResult}"`,
    '    return "at-or-above"',
  ].join('\n')
  return matchesPyInstallerSource(source, expectedSource)
}

export function mutatePyInstallerStructuredFixtureSource(source: string): string | undefined {
  let replacements = 0
  const mutated = source.replace(/^([ \t]*return[ \t]+)(['"])below\2([ \t]*(?:#.*)?)(\r?)$/gm,
    (_match, prefix: string, quote: string, suffix: string, carriageReturn: string) => {
      replacements += 1
      return `${prefix}${quote}under${quote}${suffix}${carriageReturn}`
    })
  return replacements === 1 ? mutated : undefined
}

export function matchesPyInstallerSource(source: string, expectedSource: string): boolean {
  return normalizePyInstallerSource(source) === normalizePyInstallerSource(expectedSource)
}

function normalizePyInstallerSource(source: string): string {
  let normalized = ''
  let index = 0
  let atLineStart = true

  while (index < source.length) {
    const character = source[index]
    if (character === '#') {
      if (atLineStart) normalized = normalized.replace(/[ \t\f\v]+$/, '')
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (character === '\r' || character === '\n') {
      if (atLineStart) {
        normalized = normalized.replace(/[ \t\f\v]+$/, '')
      } else if (normalized.length > 0 && !normalized.endsWith('\n')) {
        normalized += '\n'
      }
      atLineStart = true
      index += 1
      if (character === '\r' && source[index] === '\n') index += 1
      continue
    }
    if (character === ' ' || character === '\t' || character === '\f' || character === '\v') {
      if (atLineStart) {
        normalized += character
      } else if (/[\p{L}\p{N}_.'"]/u.test(normalized.at(-1) ?? '')
        && /[\p{L}\p{N}_.'"]/u.test(source[index + 1] ?? '')) {
        normalized += ' '
        while (source[index + 1] === ' ' || source[index + 1] === '\t'
          || source[index + 1] === '\f' || source[index + 1] === '\v') index += 1
      }
      index += 1
      continue
    }
    if (character !== "'" && character !== '"') {
      normalized += character
      atLineStart = false
      index += 1
      continue
    }

    const delimiter = source.startsWith(character.repeat(3), index) ? character.repeat(3) : character
    normalized += '\u0000S'
    atLineStart = false
    index += delimiter.length
    while (index < source.length) {
      if (source[index] === '\\') {
        normalized += source[index]
        index += 1
        if (index < source.length) {
          normalized += source[index]
          index += 1
        }
        continue
      }
      if (source.startsWith(delimiter, index)) {
        normalized += '\u0000E'
        index += delimiter.length
        break
      }
      normalized += source[index]
      index += 1
    }
  }

  return normalized.replace(/\n+$/, '')
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
  const isStructuredFixture = input.fixtureId === PYINSTALLER_STRUCTURED_SOURCE_FIXTURE_ID
  const isMutatedArtifactFixture = input.fixtureId === PYINSTALLER_MUTATED_SOURCE_CONTROL_FIXTURE_ID
  if (isStructuredFixture) {
    const rejected = input.structuredMutationRejectedCount
    const accepted = input.structuredMutationFalseAcceptanceCount
    if (!Number.isSafeInteger(rejected) || rejected! < 0 || rejected! > 70
      || !Number.isSafeInteger(accepted) || accepted! < 0 || accepted! > 70
      || rejected! + accepted! !== 70) {
      throw new Error('PyInstaller structured mutation controls must cover all 70 source modules')
    }
  } else if (input.structuredMutationRejectedCount !== undefined
    || input.structuredMutationFalseAcceptanceCount !== undefined) {
    throw new Error('PyInstaller structured mutation controls require the structured-source fixture')
  }
  if (isMutatedArtifactFixture) {
    const falseAcceptances = input.originalSourceFalseAcceptanceCount
    if (!Number.isSafeInteger(falseAcceptances) || falseAcceptances! < 0 || falseAcceptances! > 70) {
      throw new Error('PyInstaller mutated-artifact false-acceptance count must be between 0 and 70')
    }
  } else if (input.originalSourceFalseAcceptanceCount !== undefined) {
    throw new Error('Original-source false-acceptance controls require the mutated-source fixture')
  }

  const workerMetric: MetricMeasurement = input.workerTerminalPage
    ? { state: 'MEASURED', value: 1, denominator: 1 }
    : {
        state: 'UNAVAILABLE',
        value: null,
        denominator: 1,
        reason: 'The queued worker integration was not enabled or did not reach its terminal page.',
      }

  const metrics: Record<string, MetricMeasurement> = {
    runtime_oracle: {
      state: 'UNAVAILABLE',
      value: null,
      denominator: 1,
      reason: 'This PostgreSQL integration test does not execute the fixture runtime oracle.',
    },
    extracted_module_count: {
      state: 'MEASURED',
      value: input.extractedModuleCount,
      denominator: 1,
    },
    known_source_value_recall: {
      state: 'MEASURED',
      value: input.knownSourceMatchedCount,
      denominator: 70,
    },
    reconstruction_match: {
      state: 'MEASURED',
      value: input.reconstructionMatchedCount,
      denominator: 70,
    },
    worker_terminal_page: workerMetric,
  }
  if (isStructuredFixture) {
    metrics.negative_control_mutation_rejection = {
      state: 'MEASURED',
      value: input.structuredMutationRejectedCount!,
      denominator: 70,
    }
    metrics.negative_control_false_acceptance = {
      state: 'MEASURED',
      value: input.structuredMutationFalseAcceptanceCount!,
      denominator: 70,
    }
  }
  if (isMutatedArtifactFixture) {
    metrics.negative_control_original_source_false_acceptance = {
      state: 'MEASURED',
      value: input.originalSourceFalseAcceptanceCount!,
      denominator: 70,
    }
  }

  return {
    schemaVersion: 1,
    producer: 'webapp/src/lib/reamon/pyinstaller.task.database.integration.test.ts',
    fixtures: {
      [input.fixtureId]: {
        artifactSha256: input.artifactSha256,
        metrics,
      },
    },
  }
}
