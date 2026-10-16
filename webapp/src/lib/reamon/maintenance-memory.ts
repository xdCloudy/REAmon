import { recoveredVariablesOf } from './code-units'

export interface MaintainedSymbolRecord {
  unitName: string
  language: string
  symbolIndex: unknown
  codeUnitId?: string
  artifactId?: string
  artifactName?: string
  artifactHash?: string
}

export interface ProviderSymbolRecord {
  codeUnitId: string
  unitName: string
  language: string
  address?: string
  prototype?: string
  providerEvidence?: string
  recoveredVariables: unknown
  recoveredVariablesTruncated?: boolean
}

function singleLine(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
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
  calleeUnitIds: Set<string> = new Set(),
): string {
  const ranked = records.map((record, index) => ({ record, index })).sort((left, right) => {
    const calleeRank = Number(calleeUnitIds.has(right.record.codeUnitId || '')) - Number(calleeUnitIds.has(left.record.codeUnitId || ''))
    if (calleeRank) return calleeRank
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

export function buildProviderSymbolContext(
  records: ProviderSymbolRecord[],
  relatedUnitIds: Set<string>,
  maxBytes = 8_000,
  provenance: { provider: string; artifactName: string; artifactHash: string; taskId: string; inputTruncated?: boolean },
  selectedUnitId?: string,
  calleeUnitIds: Set<string> = new Set(),
): string {
  const header = `Provider-recovered signatures, names, and types (provisional evidence; provider=${provenance.provider.slice(0, 120)}; artifact=${provenance.artifactName.slice(0, 160)}; sha256=${provenance.artifactHash.slice(0, 16)}; analysis=${provenance.taskId.slice(0, 128)}${provenance.inputTruncated ? '; related-unit selection capped' : ''}):`
  const ranked = records.map((record, index) => ({ record, index })).sort((left, right) => {
    const selectedRank = Number(right.record.codeUnitId === selectedUnitId) - Number(left.record.codeUnitId === selectedUnitId)
    if (selectedRank) return selectedRank
    const calleeRank = Number(calleeUnitIds.has(right.record.codeUnitId)) - Number(calleeUnitIds.has(left.record.codeUnitId))
    if (calleeRank) return calleeRank
    const relatedRank = Number(relatedUnitIds.has(right.record.codeUnitId)) - Number(relatedUnitIds.has(left.record.codeUnitId))
    return relatedRank || left.index - right.index
  })
  const lines = [header]
  let length = Buffer.byteLength(header, 'utf8')
  let omittedByContextLimit = false
  const includedUnits = new Set<string>()
  for (const { record } of ranked) {
    if (includedUnits.has(record.codeUnitId)) continue
    const { variables, truncated } = recoveredVariablesOf(record.recoveredVariables)
    const prototype = typeof record.prototype === 'string'
      ? singleLine(record.prototype, 500)
      : ''
    const providerEvidence = typeof record.providerEvidence === 'string'
      ? singleLine(record.providerEvidence, 300)
      : ''
    if (!variables.length && !prototype && !providerEvidence) continue
    const address = record.address && /^[A-Za-z0-9:_-]{1,128}$/.test(record.address) ? ` @ ${record.address}` : ''
    const symbolList = variables.slice(0, 12).map((variable) => {
      const kind = variable.kind === 'parameter' ? `parameter ${variable.parameterIndex}` : 'local'
      const locks = [
        variable.nameLocked === undefined ? '' : `name ${variable.nameLocked ? 'locked' : 'unlocked'}`,
        variable.typeLocked === undefined ? '' : `type ${variable.typeLocked ? 'locked' : 'unlocked'}`,
      ].filter(Boolean).join(', ')
      const size = variable.sizeBytes === undefined ? '' : `; ${variable.sizeBytes} B`
      return `${kind}: ${singleLine(variable.name, 128)}: ${singleLine(variable.dataType || 'unknown type', 128)}${size}${locks ? `; ${locks}` : ''}`
    })
    const omitted = variables.length > symbolList.length || truncated || record.recoveredVariablesTruncated
      ? `; more symbols omitted${record.recoveredVariablesTruncated ? ' by analyzer limit' : ''}`
      : ''
    const unitName = singleLine(record.unitName, 300)
    const identity = providerEvidence ? `provider metadata: ${providerEvidence}; ` : ''
    const signature = prototype ? `signature: ${prototype}; ` : ''
    const relation = record.codeUnitId === selectedUnitId
      ? 'selected unit'
      : calleeUnitIds.has(record.codeUnitId) ? 'direct callee' : 'related unit'
    const line = `${unitName}${address} [${record.language.slice(0, 80)}; ${relation}]: ${identity}${signature}${symbolList.join('; ')}${omitted}`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (length + lineBytes + 1 > maxBytes - 80) {
      omittedByContextLimit = true
      break
    }
    lines.push(line)
    includedUnits.add(record.codeUnitId)
    length += lineBytes + 1
  }
  if (omittedByContextLimit) lines.push('Additional recovered-symbol rows were omitted to fit the context budget.')
  return lines.length > 1 ? lines.join('\n') : ''
}

export function buildProviderGoTypeContext(
  serializedDetails: unknown,
  selectedSource: string,
  selectedPrototype: string | undefined,
  recoveredVariableTypes: string[],
  provenance: { artifactName: string; artifactHash: string; taskId: string; functionAddress?: string; truncated?: boolean },
  maxBytes = 2_800,
): string {
  if (typeof serializedDetails !== 'string' || serializedDetails.length > 16_000) return ''
  let parsed: unknown
  try { parsed = JSON.parse(serializedDetails) } catch { return '' }
  if (!Array.isArray(parsed)) return ''
  const sourceIdentifiers = new Set<string>()
  for (const text of [selectedSource, selectedPrototype || '', ...recoveredVariableTypes]) {
    for (const match of text.matchAll(/[A-Za-z_$][\w$]*(?:[./][A-Za-z_$][\w$]*)*/g)) sourceIdentifiers.add(match[0])
  }
  const header = `GoReSym reconstructed type evidence (provisional; names matched in selected function text only; artifact=${singleLine(provenance.artifactName, 120)}; sha256=${provenance.artifactHash.slice(0, 16)}; analysis=${provenance.taskId.slice(0, 128)}${provenance.functionAddress ? `; function=${provenance.functionAddress.slice(0, 128)}` : ''}):`
  const lines = [header]
  let length = Buffer.byteLength(header, 'utf8')
  let omitted = Boolean(provenance.truncated)
  const included = new Set<string>()
  for (const candidate of parsed.slice(0, 1000)) {
    const detail = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {}
    if (typeof detail.name !== 'string' || !detail.name.trim()
        || typeof detail.kind !== 'string' || typeof detail.reconstructed !== 'string') {
      omitted = true
      continue
    }
    const name = singleLine(detail.name, 256)
    const normalizedName = name.replace(/^[*\[\]\s]+/, '')
    if (!sourceIdentifiers.has(normalizedName)) continue
    const identity = `${name}\u0000${detail.kind}\u0000${detail.reconstructed}`
    if (included.has(identity)) continue
    const kind = singleLine(detail.kind, 80) || 'unknown kind'
    const reconstructed = singleLine(detail.reconstructed, 900)
    const line = `${name} [${kind}]: ${reconstructed || 'reconstructed form unavailable'}`
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (length + lineBytes + 1 > maxBytes - 80 || lines.length >= 9) {
      omitted = true
      continue
    }
    lines.push(line)
    included.add(identity)
    length += lineBytes + 1
  }
  if (omitted && lines.length > 1) lines.push('Additional Go type records were omitted by analyzer or context limits.')
  return lines.length > 1 ? lines.join('\n') : ''
}
