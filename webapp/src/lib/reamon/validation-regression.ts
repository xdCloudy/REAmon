export interface ValidationEvidence {
  status: string | null | undefined
  method: string | null | undefined
}

function validationStrength(method: string | null | undefined): number {
  if (!method) return 0
  const normalized = method.trim().toLowerCase()
  // Assemblers provide the strongest structural check. Language-specific
  // compilers/parsers outrank the generic Tree-sitter fallback.
  if (normalized === 'smali-assembler') return 3
  if (normalized.includes('tree-sitter')) return 1
  if (
    /^cpython-\d+\.\d+-compile$/.test(normalized)
    || /^php-\d+(?:\.\d+){1,2}-syntax-check$/.test(normalized)
    || /^ruby-\d+(?:\.\d+){1,2}-syntax-check$/.test(normalized)
    || /^gofmt-go\d+\.\d+-syntax-check$/.test(normalized)
    || /^luac-lua5\.\d+(?:\.\d+)?-syntax-check$/.test(normalized)
    || /^luau-compile-\d+(?:\.\d+){1,2}-only-parse$/.test(normalized)
    || /^babel-parser-[a-z0-9.+-]+$/.test(normalized)
    || /^javac(?:-[a-z0-9.+-]+)?-parse$/.test(normalized)
    || /^roslyn-csharp(?:-[a-z0-9.+-]+)?-parse$/.test(normalized)
  ) return 2
  return 0
}

/**
 * Keep a previously accepted source when its passing validator evidence would
 * be replaced by a failed, unavailable, or weaker validation result.
 */
export function isValidationRegression(previous: ValidationEvidence, next: ValidationEvidence): boolean {
  if (previous.status !== 'PASSED') return false
  if (next.status !== 'PASSED') return true
  return validationStrength(next.method) < validationStrength(previous.method)
}
