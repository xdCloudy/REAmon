export interface MaintainedSymbolRecord {
  unitName: string
  language: string
  symbolIndex: unknown
  codeUnitId?: string
  artifactId?: string
  artifactName?: string
  artifactHash?: string
}

const declarationPatterns = [
  /\b(?:class|interface|enum|record|struct|trait|type|function|func|fun|def|fn)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:public|protected|private|internal|static|final|abstract|async|virtual|override|synchronized|inline|export|default|readonly|extern|unsafe)\s+(?:[\w$<>?,.[\]]+\s+)+([A-Za-z_$][\w$]*)\s*\(/g,
  /\b(?:[A-Za-z_$][\w$:<>,.[\]&?]*\s+|[*&]\s*)+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/g,
  /\b(?:public|protected|private|internal|static|final|readonly|volatile|const|let|var)\s+(?:[\w$<>?,.[\]]+\s+)+([A-Za-z_$][\w$]*)\s*(?:=|;|,)/g,
]

function maskNonCode(sourceCode: string, language: string): string {
  const characters = [...sourceCode]
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' '
    }
  }
  const normalizedLanguage = language.trim().toLowerCase()
  const hashComments = new Set(['python', 'ruby', 'php', 'shell', 'bash', 'perl', 'r'])
  let index = 0

  while (index < characters.length) {
    const current = characters[index]
    const next = characters[index + 1]
    if (current === '/' && next === '/') {
      const start = index
      index += 2
      while (index < characters.length && characters[index] !== '\n' && characters[index] !== '\r') index += 1
      blank(start, index)
      continue
    }
    if (current === '/' && next === '*') {
      const start = index
      index += 2
      while (index < characters.length && !(characters[index] === '*' && characters[index + 1] === '/')) index += 1
      index = Math.min(characters.length, index + 2)
      blank(start, index)
      continue
    }
    if (current === '#' && hashComments.has(normalizedLanguage)) {
      const start = index
      while (index < characters.length && characters[index] !== '\n' && characters[index] !== '\r') index += 1
      blank(start, index)
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      const start = index
      const triple = current !== '`' && next === current && characters[index + 2] === current
      const delimiterLength = triple ? 3 : 1
      index += delimiterLength
      while (index < characters.length) {
        if (characters[index] === '\\' && !triple) {
          index += 2
          continue
        }
        if (characters[index] === current
          && (!triple || (characters[index + 1] === current && characters[index + 2] === current))) {
          index += delimiterLength
          break
        }
        index += 1
      }
      blank(start, Math.min(index, characters.length))
      continue
    }
    index += 1
  }

  return characters.join('')
}

export function extractMaintainedSymbols(sourceCode: string, language = ''): string[] {
  const code = maskNonCode(sourceCode, language)
  const symbols = new Set<string>()
  for (const pattern of declarationPatterns) {
    pattern.lastIndex = 0
    for (const match of code.matchAll(pattern)) {
      const name = match[1]
      if (name && name.length > 1) symbols.add(name)
    }
  }
  return [...symbols].sort((left, right) => left.localeCompare(right)).slice(0, 128)
}

export function buildProjectSymbolContext(
  records: MaintainedSymbolRecord[],
  relatedUnitIds: Set<string>,
  maxChars = 8_000,
  currentArtifactHash?: string,
): string {
  const ranked = records.map((record, index) => ({ record, index })).sort((left, right) => {
    const relatedRank = Number(relatedUnitIds.has(right.record.codeUnitId || '')) - Number(relatedUnitIds.has(left.record.codeUnitId || ''))
    if (relatedRank) return relatedRank
    const currentArtifactRank = Number(Boolean(currentArtifactHash && right.record.artifactHash === currentArtifactHash))
      - Number(Boolean(currentArtifactHash && left.record.artifactHash === currentArtifactHash))
    return currentArtifactRank || left.index - right.index
  })
  const lines: string[] = []
  const includedUnits = new Set<string>()
  let length = 0
  for (const { record } of ranked) {
    if (!Array.isArray(record.symbolIndex)) continue
    const symbols = [...new Set(record.symbolIndex.filter((value): value is string => typeof value === 'string' && value.length <= 128))]
    if (!symbols.length) continue
    const identity = record.artifactHash
      ? `${record.artifactHash}:${record.unitName}:${record.language}:${JSON.stringify([...symbols].sort())}`
      : record.codeUnitId || `${record.artifactId || ''}:${record.unitName}:${record.language}:${JSON.stringify([...symbols].sort())}`
    if (includedUnits.has(identity)) continue
    const artifactName = record.artifactName || record.artifactId
    const artifactLabel = [artifactName, record.artifactHash?.slice(0, 12)].filter(Boolean).join(' #')
    const artifactVersion = artifactLabel
      ? `; ${currentArtifactHash && record.artifactHash === currentArtifactHash ? 'current' : 'other'} artifact ${artifactLabel}`
      : ''
    const line = `${record.unitName} (${record.language}${artifactVersion}): ${symbols.join(', ')}`
    if (length + line.length + 1 > maxChars) continue
    lines.push(line)
    includedUnits.add(identity)
    length += line.length + 1
  }
  return lines.join('\n')
}
