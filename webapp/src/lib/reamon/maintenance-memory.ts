export interface MaintainedSymbolRecord {
  unitName: string
  language: string
  symbolIndex: unknown
}

const declarationPatterns = [
  /\b(?:class|interface|enum|record|struct|trait|type|function|func|def|fn)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:public|protected|private|internal|static|final|abstract|async|virtual|override|synchronized|inline|export|default|readonly|extern|unsafe)\s+(?:[\w$<>?,.[\]]+\s+)+([A-Za-z_$][\w$]*)\s*\(/g,
  /\b(?:public|protected|private|internal|static|final|readonly|volatile|const|let|var)\s+(?:[\w$<>?,.[\]]+\s+)+([A-Za-z_$][\w$]*)\s*(?:=|;|,)/g,
]

export function extractMaintainedSymbols(sourceCode: string): string[] {
  const symbols = new Set<string>()
  for (const pattern of declarationPatterns) {
    pattern.lastIndex = 0
    for (const match of sourceCode.matchAll(pattern)) {
      const name = match[1]
      if (name && name.length > 1) symbols.add(name)
    }
  }
  return [...symbols].sort((left, right) => left.localeCompare(right)).slice(0, 128)
}

export function buildProjectSymbolContext(
  records: MaintainedSymbolRecord[],
  relatedNames: Set<string>,
  maxChars = 8_000,
): string {
  const ranked = [...records].sort((left, right) => Number(relatedNames.has(right.unitName)) - Number(relatedNames.has(left.unitName)))
  const lines: string[] = []
  const includedUnits = new Set<string>()
  let length = 0
  for (const record of ranked) {
    if (includedUnits.has(record.unitName)) continue
    if (!Array.isArray(record.symbolIndex)) continue
    const symbols = [...new Set(record.symbolIndex.filter((value): value is string => typeof value === 'string' && value.length <= 128))]
    if (!symbols.length) continue
    const line = `${record.unitName} (${record.language}): ${symbols.join(', ')}`
    if (length + line.length + 1 > maxChars) continue
    lines.push(line)
    includedUnits.add(record.unitName)
    length += line.length + 1
  }
  return lines.join('\n')
}
