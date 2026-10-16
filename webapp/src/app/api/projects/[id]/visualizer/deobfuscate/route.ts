import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { AgentUnreachableError, agentFetch } from '@/lib/agentFetch'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { buildProjectSymbolContext, buildProviderSymbolContext, extractMaintainedSymbols } from '@/lib/reamon/maintenance-memory'
import { providerVariablesOf } from '@/lib/reamon/code-units'
import { rankSimilarInstructionFunctions } from '@/lib/reamon/instruction-similarity'
import { codeRewriteLeaseGraceMs, failInterruptedCodeAttempts } from '@/lib/reamon/code-attempts'

interface RouteParams { params: Promise<{ id: string }> }
interface DeobfuscateBody { unitId?: unknown; providerId?: unknown; question?: unknown; scope?: unknown; startByte?: unknown; endByte?: unknown; memberName?: unknown; sourceCode?: unknown }

const MAX_SOURCE_BYTES = 64 * 1024
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const MAX_QUESTION_CHARS = 1000
const MAX_QUEUED_REWRITE_MS = 30 * 60_000
const MAX_CONTEXT_UNITS = 8
const MAX_CONTEXT_BYTES = 16 * 1024
const MAX_FUNCTION_HISTORY = 8_000
const MAX_FUNCTION_CANDIDATES = 2_000
const MAX_SAME_FILE_CONTEXT_MEMBERS = 3
const MAX_SAME_FILE_CONTEXT_BYTES = 8 * 1024
const MAX_DISASSEMBLY_BYTES = 8 * 1024
const MAX_BINARY_EVIDENCE_BYTES = 8 * 1024
const MAX_DEX_REFERENCE_METHODS = 64
const MAX_DEX_REFERENCE_ROWS = 128
const MAX_DEX_BYTECODE_METHODS = 8
const MAX_PROJECT_SYMBOL_RECORDS = 1_024
const MAX_PROJECT_SYMBOL_SCAN = 4_096
const MAX_PROVIDER_SYMBOL_RECORDS = 128
const MAX_PROJECT_DRAFT_RECORDS = 64
const MEMBER_OUTLINE_SOURCE = 'reamon-tree-sitter-outline@tree-sitter-language-pack-1.21.0'
const MAX_PERSISTED_OUTLINE_MEMBERS = 10_000

interface OutlineMember {
  name: string
  kind: string
  start_byte: number
  end_byte: number
  line: number
  source_bytes: number
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function boundedInstructionMnemonics(value: unknown): string[] {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.slice(0, 800).filter((item): item is string =>
    typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_./-]{0,31}$/.test(item))
}

function sameGhidraArchitecture(left: unknown, right: unknown): boolean {
  const leftArchitecture = plainObject(left).instructionArchitecture
  const rightArchitecture = plainObject(right).instructionArchitecture
  return typeof leftArchitecture === 'string' && leftArchitecture.length > 0
    && typeof rightArchitecture === 'string' && leftArchitecture === rightArchitecture
}

function utf8Prefix(source: string, maxBytes: number): string {
  return Buffer.from(source, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8')
}

function normalizeOutlineMembers(value: unknown): OutlineMember[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_PERSISTED_OUTLINE_MEMBERS).flatMap((item) => {
    const member = plainObject(item)
    if (typeof member.name !== 'string' || !member.name.trim()
      || typeof member.kind !== 'string'
      || !Number.isSafeInteger(member.start_byte) || !Number.isSafeInteger(member.end_byte)
      || !Number.isSafeInteger(member.line)) return []
    const startByte = member.start_byte as number
    const endByte = member.end_byte as number
    if (startByte < 0 || endByte <= startByte) return []
    return [{
      name: member.name.trim().slice(0, 500),
      kind: member.kind.slice(0, 80),
      start_byte: startByte,
      end_byte: endByte,
      line: Math.max(1, member.line as number),
      source_bytes: Number.isSafeInteger(member.source_bytes) && (member.source_bytes as number) >= 0
        ? Math.min(member.source_bytes as number, endByte - startByte)
        : endByte - startByte,
    }]
  })
}

async function cachedOutlineMembers(input: {
  projectId: string; taskId: string | null; artifactId: string; parentCodeUnitKey: string; sourceHash: string
}): Promise<{ members: OutlineMember[]; truncated: boolean }> {
  if (!input.taskId) return { members: [], truncated: false }
  const rows = await prisma.reamonObservation.findMany({
    where: {
      projectId: input.projectId,
      taskId: input.taskId,
      artifactId: input.artifactId,
      source: MEMBER_OUTLINE_SOURCE,
      kind: 'entity',
      type: 'function',
      AND: [
        { attributes: { path: ['parentCodeUnitKey'], equals: input.parentCodeUnitKey } },
        { attributes: { path: ['sourceHash'], equals: input.sourceHash } },
      ],
    },
    select: { attributes: true },
    orderBy: { stableKey: 'asc' },
    take: MAX_PERSISTED_OUTLINE_MEMBERS,
  })
  const attributes = rows.map((row) => plainObject(row.attributes))
  return { members: normalizeOutlineMembers(attributes.map((value) => {
    return {
      name: value.name,
      kind: value.memberKind,
      start_byte: value.startByte,
      end_byte: value.endByte,
      line: value.line,
      source_bytes: value.sourceBytes,
    }
  })), truncated: attributes.some((value) => value.outlineTruncated === true) }
}

async function persistOutlineMembers(input: {
  projectId: string; taskId: string | null; artifactId: string; sourceHash: string; parentCodeUnitKey: string;
  parentName: string; language: string; relativePath: string | null; codeArtifactId: string; members: OutlineMember[]; truncated: boolean; parserVersion: string
}): Promise<number> {
  if (!input.taskId || !input.members.length) return 0
  const rows = input.members.map((member) => {
    const identity = JSON.stringify([input.artifactId, input.taskId, input.parentCodeUnitKey, input.sourceHash,
      member.kind, member.name, member.start_byte, member.end_byte])
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 48)
    const stableKey = `outline:${digest}`
    return {
      projectId: input.projectId,
      taskId: input.taskId,
      artifactId: input.artifactId,
      kind: 'entity',
      type: 'function',
      stableKey,
      canonicalKey: stableKey,
      label: `${input.parentName}::${member.name}`.slice(0, 500),
      source: MEMBER_OUTLINE_SOURCE,
      attributes: {
        unitType: 'function',
        name: member.name,
        qualifiedName: `${input.parentName}::${member.name}`.slice(0, 1000),
        memberKind: member.kind,
        language: input.language.slice(0, 80),
        relativePath: input.relativePath,
        codeArtifactId: input.codeArtifactId,
        parentCodeUnitKey: input.parentCodeUnitKey,
        sourceHash: input.sourceHash,
        startByte: member.start_byte,
        endByte: member.end_byte,
        line: member.line,
        sizeBytes: member.source_bytes,
        evidenceKind: 'parser_outline',
        parserVersion: input.parserVersion,
        outlineTruncated: input.truncated,
      },
    }
  })
  const result = await prisma.reamonObservation.createMany({ data: rows, skipDuplicates: true })
  return result.count
}

async function requestOutline(language: string, source: Buffer): Promise<{ members: OutlineMember[]; truncated: boolean; parserVersion: string; unsupported?: boolean } | null> {
  const response = await agentFetch('/reamon/code/outline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, source_code: source.toString('utf8') }),
  }, { timeoutMs: 30_000 })
  const payload = plainObject(await response.json().catch(() => null))
  if (response.status === 415) return { members: [], truncated: false, parserVersion: 'unavailable', unsupported: true }
  if (!response.ok) return null
  const tooManyMembers = Array.isArray(payload.members) && payload.members.length > MAX_PERSISTED_OUTLINE_MEMBERS
  const parserVersion = typeof payload.parserVersion === 'string' ? payload.parserVersion.slice(0, 100) : 'unknown'
  return { members: normalizeOutlineMembers(payload.members), truncated: payload.truncated === true || tooManyMembers, parserVersion }
}

async function dexMethodSourceExcerpt(input: {
  projectId: string
  taskId: string
  artifactId: string
  parentCodeUnitKey: string
  parentName: string
  language: string
  relativePath: string | null
  codeArtifactId: string
  methodName: string
  source: Buffer
  cache: Map<string, { members: OutlineMember[]; truncated: boolean }>
  persistOutline?: boolean
}): Promise<{ source: string; ambiguous: boolean; truncated: boolean } | null> {
  if (!input.source.length || input.source.byteLength > MAX_ARTIFACT_BYTES) return null
  const sourceHash = createHash('sha256').update(input.source).digest('hex')
  const cacheKey = JSON.stringify([input.projectId, input.taskId, input.artifactId, input.parentCodeUnitKey, sourceHash, input.persistOutline !== false])
  let outline = input.cache.get(cacheKey)
  if (!outline) {
    const stored = await cachedOutlineMembers({
      projectId: input.projectId,
      taskId: input.taskId,
      artifactId: input.artifactId,
      parentCodeUnitKey: input.parentCodeUnitKey,
      sourceHash,
    })
    outline = stored.members.length ? stored : undefined
    if (!outline) {
      const parsed = await requestOutline(input.language, input.source)
      if (!parsed) {
        input.cache.set(cacheKey, { members: [], truncated: false })
        return null
      }
      outline = { members: parsed.members, truncated: parsed.truncated }
      try {
        if (parsed.members.length && input.persistOutline !== false) await persistOutlineMembers({
          projectId: input.projectId,
          taskId: input.taskId,
          artifactId: input.artifactId,
          sourceHash,
          parentCodeUnitKey: input.parentCodeUnitKey,
          parentName: input.parentName,
          language: input.language,
          relativePath: input.relativePath,
          codeArtifactId: input.codeArtifactId,
          members: parsed.members,
          truncated: parsed.truncated,
          parserVersion: parsed.parserVersion,
        })
      } catch {
        // The source excerpt remains useful if optional outline persistence fails.
      }
    }
    input.cache.set(cacheKey, outline)
  }

  const matchingCandidates = outline.members.filter((member) => member.name === input.methodName
    && member.end_byte <= input.source.byteLength)
  const candidates = matchingCandidates.slice(0, 3)
  if (!candidates.length) return null
  const source = candidates.map((member, index) => {
    const ambiguity = candidates.length > 1 ? `; same-name candidate ${index + 1} of ${candidates.length}` : ''
    return `// syntax-outlined method at line ${member.line}${ambiguity}\n${input.source.subarray(member.start_byte, member.end_byte).toString('utf8')}`
  }).join('\n\n')
  const truncated = outline.truncated || matchingCandidates.length > candidates.length
  return {
    source: truncated ? `// syntax outline truncated; additional overloads may exist\n${source}` : source,
    ambiguous: matchingCandidates.length > 1,
    truncated,
  }
}

function smaliMethodEvidence(source: string, memberName: string, unitName: string): string {
  const simpleClassName = unitName.split('.').at(-1)?.split('$').at(-1) || unitName
  const targetName = memberName === simpleClassName ? '<init>' : memberName
  const matches: string[] = []
  let currentLines: string[] | null = null
  let currentName = ''

  for (const line of source.split(/\r?\n/)) {
    const methodHeader = line.match(/^\s*\.method\b.*\s([^\s(]+)\(/)
    if (methodHeader) {
      currentLines = [line]
      currentName = methodHeader[1]
      continue
    }
    if (!currentLines) continue
    currentLines.push(line)
    if (/^\s*\.end method\s*$/.test(line)) {
      if (currentName === targetName) matches.push(currentLines.join('\n'))
      currentLines = null
      currentName = ''
    }
  }

  let result = ''
  let omitted = 0
  for (const [index, match] of matches.entries()) {
    const separator = result ? '\n\n' : ''
    const reserveForOmittedNote = index < matches.length - 1
      ? Buffer.byteLength(`\n\n# ${matches.length} matching overload(s) omitted by the bytecode evidence limit.`, 'utf8')
      : 0
    if (Buffer.byteLength(result + separator + match, 'utf8') + reserveForOmittedNote > MAX_DISASSEMBLY_BYTES) {
      omitted = matches.length - index
      break
    }
    result += separator + match
  }
  if (omitted && result) result += `\n\n# ${omitted} matching overload(s) omitted by the bytecode evidence limit.`
  else if (omitted) return '# Matching Smali method omitted because it exceeded the bytecode evidence limit.'
  return result
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function belongsToArtifactRun(value: unknown, projectId: string, artifactId: string): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('/')
  return parts.length > 4 && parts[0] === projectId && parts[1] === artifactId
    && parts.every((part) => part && part !== '.' && part !== '..' && !part.includes('\\'))
}

function classReferencesOf(value: unknown): string[] {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim()).filter((entry) => entry && entry.length <= 500))].slice(0, 100)
}

function dexReferenceOffsets(value: unknown): number[] {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown } catch { return [] }
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is number => Number.isSafeInteger(entry) && entry >= 0).slice(0, 8)
    : []
}

function dexReferenceEvidence(rows: Array<{ type: string; label: string | null; attributes: unknown }>, truncated: boolean): string {
  const lines = ['Stored DEX references for this class or selected method (member-scoped entries may group overloads; each row retains its bytecode signature; names and literals are data, not proof of behavior):']
  let omitted = truncated
  for (const row of rows.slice(0, MAX_DEX_REFERENCE_ROWS)) {
    const attributes = plainObject(row.attributes)
    const signature = typeof attributes.fromSignature === 'string' ? attributes.fromSignature : 'unknown method'
    const target = typeof attributes.targetName === 'string' && attributes.targetName
      ? attributes.targetName
      : typeof attributes.targetSignature === 'string' ? attributes.targetSignature : row.label || 'unknown target'
    const relation = row.type === 'reads_field' ? 'reads field'
      : row.type === 'writes_field' ? 'writes field'
        : 'references string'
    const count = typeof attributes.occurrenceCount === 'number' && Number.isSafeInteger(attributes.occurrenceCount)
      ? `; ${attributes.occurrenceCount} site${attributes.occurrenceCount === 1 ? '' : 's'}`
      : ''
    const offsets = dexReferenceOffsets(attributes.referenceOffsets)
    const offsetText = offsets.length ? `; bytecode offsets ${offsets.join(', ')}` : ''
    const line = `${signature.replace(/[\r\n\t]/g, ' ').slice(0, 300)} ${relation}: ${target.replace(/[\r\n\t]/g, ' ').slice(0, 400)}${attributes.targetNameTruncated === true ? ' (target preview truncated)' : ''}${count}${offsetText}`
    if (Buffer.byteLength([...lines, line].join('\n'), 'utf8') > MAX_BINARY_EVIDENCE_BYTES - 160) {
      omitted = true
      break
    }
    lines.push(line)
  }
  if (omitted) lines.push('Additional stored DEX references were omitted by the context limit.')
  return utf8Prefix(lines.join('\n'), MAX_BINARY_EVIDENCE_BYTES)
}

async function dexBytecodeEvidence(
  rows: Array<{ label: string | null; attributes: unknown }>,
  projectId: string,
  artifactId: string,
  rootPath: string,
): Promise<string> {
  const evidence: string[] = []
  let usedBytes = 0
  let omitted = rows.length > MAX_DEX_BYTECODE_METHODS
  for (const row of rows.slice(0, MAX_DEX_BYTECODE_METHODS)) {
    const attributes = plainObject(row.attributes)
    const artifactPath = typeof attributes.bytecodeArtifactId === 'string' ? attributes.bytecodeArtifactId : ''
    if (!belongsToArtifactRun(artifactPath, projectId, artifactId)) continue
    try {
      const filePath = resolveDerivedArtifactPath(artifactPath)
      const fileRealPath = await realpath(filePath)
      if (!isInside(rootPath, fileRealPath)) continue
      const fileInfo = await stat(fileRealPath)
      if (!fileInfo.isFile() || fileInfo.size > 1024 * 1024) continue
      const payload = plainObject(JSON.parse((await readFile(fileRealPath)).toString('utf8')))
      if (!Array.isArray(payload.instructions)) continue
      const instructions = payload.instructions.slice(0, 160).flatMap((item) => {
        const instruction = plainObject(item)
        if (typeof instruction.offset !== 'number' || !Number.isSafeInteger(instruction.offset) || typeof instruction.mnemonic !== 'string') return []
        const operands = typeof instruction.operands === 'string' ? ` ${instruction.operands.replace(/[\r\n\t]/g, ' ').slice(0, 180)}` : ''
        return [`${instruction.offset.toString(16)}: ${instruction.mnemonic.replace(/[\r\n\t]/g, ' ').slice(0, 40)}${operands}`]
      })
      if (!instructions.length) continue
      const signature = typeof payload.signature === 'string' ? payload.signature : row.label || 'method'
      const instructionListTruncated = payload.truncated === true || payload.instructions.length > 160
      const line = `${signature.replace(/[\r\n\t]/g, ' ').slice(0, 300)}${instructionListTruncated ? ' (instruction list truncated)' : ''}: ${instructions.join('; ')}`
      const remaining = MAX_DISASSEMBLY_BYTES - usedBytes
      if (remaining <= 0) { omitted = true; break }
      const bounded = utf8Prefix(line, remaining)
      if (Buffer.byteLength(line, 'utf8') > remaining) omitted = true
      if (!bounded) break
      evidence.push(bounded)
      usedBytes += Buffer.byteLength(bounded, 'utf8')
    } catch {
      continue
    }
  }
  if (omitted && usedBytes < MAX_DISASSEMBLY_BYTES) evidence.push('Additional selected-method bytecode rows were omitted by the evidence limit.')
  return utf8Prefix(evidence.join('\n'), MAX_DISASSEMBLY_BYTES)
}

export async function POST(request: Request, { params }: RouteParams) {
  let runningAttemptId: string | null = null
  let codeUnitLeaseId: string | null = null
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    let body: DeobfuscateBody
    try { body = await request.json() as DeobfuscateBody } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !validId(body.unitId)
      || (body.scope !== 'outline' && !validId(body.providerId))
      || (body.scope !== undefined && !['file', 'member', 'outline'].includes(String(body.scope)))) {
      return NextResponse.json({ error: 'A code unit and valid transformation scope are required' }, { status: 400 })
    }
    if (body.question !== undefined && (typeof body.question !== 'string' || body.question.length > MAX_QUESTION_CHARS)) {
      return NextResponse.json({ error: `Request must be at most ${MAX_QUESTION_CHARS} characters` }, { status: 400 })
    }

    const observation = await prisma.reamonObservation.findFirst({
      where: { id: body.unitId.trim(), projectId, type: 'code_unit' },
      select: { id: true, artifactId: true, taskId: true, stableKey: true, canonicalKey: true, label: true, source: true, type: true, attributes: true },
    })
    if (!observation?.artifactId) return NextResponse.json({ error: 'Code unit not found' }, { status: 404 })

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const artifact = await prisma.artifact.findFirst({
      where: { AND: [{ id: observation.artifactId, projectId }, selection.artifactWhere] },
      select: { id: true, originalName: true, sha256: true },
    })
    if (!artifact) return NextResponse.json({ error: 'Code unit is not part of the active workspace' }, { status: 404 })

    const attributes = plainObject(observation.attributes)
    const codeArtifactId = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
    const pathPrefix = `${projectId}/${artifact.id}/`
    const segments = codeArtifactId.split('/')
    if (!codeArtifactId.startsWith(pathPrefix) || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
      return NextResponse.json({ error: 'Code unit has no valid linked source artifact' }, { status: 404 })
    }

    const configuredRoot = derivedArtifactRoot()
    const filePath = resolveDerivedArtifactPath(codeArtifactId)
    const [rootPath, sourcePath] = await Promise.all([realpath(configuredRoot), realpath(filePath)])
    if (!isInside(rootPath, sourcePath)) return NextResponse.json({ error: 'Linked source path is invalid' }, { status: 404 })
    const sourceInfo = await stat(sourcePath)
    if (!sourceInfo.isFile() || sourceInfo.size > MAX_ARTIFACT_BYTES) {
      return NextResponse.json({ error: 'Linked source exceeds the deobfuscation limit' }, { status: 413 })
    }
    const fullBytes = await readFile(sourcePath)
    const sourceHash = createHash('sha256').update(fullBytes).digest('hex')
    const scope = body.scope === 'member' ? 'member' : body.scope === 'outline' ? 'outline' : 'file'
    const language = typeof attributes.language === 'string' ? attributes.language : 'unknown'
    const sourceLanguage = typeof attributes.sourceLanguage === 'string' ? attributes.sourceLanguage : ''
    const unitName = (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
      || (typeof attributes.name === 'string' && attributes.name)
      || observation.label
      || 'Selected code unit'
    if (scope === 'outline') {
      if (body.sourceCode !== undefined && typeof body.sourceCode !== 'string') {
        return NextResponse.json({ error: 'Source for the member outline must be text' }, { status: 400 })
      }
      const outlineSource = typeof body.sourceCode === 'string' ? Buffer.from(body.sourceCode, 'utf8') : fullBytes
      if (outlineSource.byteLength > MAX_ARTIFACT_BYTES) {
        return NextResponse.json({ error: 'Source for the member outline exceeds the size limit' }, { status: 413 })
      }
      if (body.sourceCode === undefined && observation.taskId) {
        const cached = await cachedOutlineMembers({ projectId, taskId: observation.taskId, artifactId: artifact.id, parentCodeUnitKey: observation.stableKey, sourceHash })
        if (cached.members.length) return NextResponse.json({ members: cached.members, truncated: cached.truncated, persistedMemberCount: cached.members.length, cached: true }, { headers: { 'Cache-Control': 'private, no-store' } })
      }
      const outline = await requestOutline(language, outlineSource)
      if (!outline) return NextResponse.json({ error: 'Could not build the function and method outline' }, { status: 502 })
      if (outline.unsupported) return NextResponse.json({ members: [], truncated: false, unsupported: true }, { headers: { 'Cache-Control': 'private, no-store' } })
      let persistedMemberCount = 0
      if (body.sourceCode === undefined) {
        persistedMemberCount = await persistOutlineMembers({
          projectId, taskId: observation.taskId, artifactId: artifact.id, sourceHash,
          parentCodeUnitKey: observation.stableKey, parentName: unitName, language,
          relativePath: typeof attributes.relativePath === 'string' ? attributes.relativePath : null,
          codeArtifactId, members: outline.members, truncated: outline.truncated, parserVersion: outline.parserVersion,
        })
      }
      return NextResponse.json({ members: outline.members, truncated: outline.truncated, parserVersion: outline.parserVersion, persistedMemberCount }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    let bytes = fullBytes
    if (scope === 'member') {
      const startByte = body.startByte
      const endByte = body.endByte
      if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte) || (startByte as number) < 0 || (endByte as number) <= (startByte as number) || (endByte as number) > fullBytes.byteLength || typeof body.memberName !== 'string') {
        return NextResponse.json({ error: 'The selected function or method range is invalid. Reload the source outline and try again.' }, { status: 400 })
      }
      const cached = await cachedOutlineMembers({ projectId, taskId: observation.taskId, artifactId: artifact.id, parentCodeUnitKey: observation.stableKey, sourceHash })
      let outlinedMembers = cached.members
      if (!outlinedMembers.length) {
        const outline = await requestOutline(language, fullBytes)
        if (!outline) return NextResponse.json({ error: 'This source language cannot verify a member-level edit target' }, { status: 422 })
        outlinedMembers = outline.members
        await persistOutlineMembers({
          projectId, taskId: observation.taskId, artifactId: artifact.id, sourceHash,
          parentCodeUnitKey: observation.stableKey, parentName: unitName, language,
          relativePath: typeof attributes.relativePath === 'string' ? attributes.relativePath : null,
          codeArtifactId, members: outlinedMembers, truncated: outline.truncated, parserVersion: outline.parserVersion,
        })
      }
      const memberName = body.memberName.trim()
      if (!outlinedMembers.some((member) => member.start_byte === startByte && member.end_byte === endByte && member.name === memberName)) {
        return NextResponse.json({ error: 'This function or method no longer matches the stored source outline. Reload the outline and try again.' }, { status: 409 })
      }
      bytes = fullBytes.subarray(startByte as number, endByte as number)
      if (bytes.byteLength > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'This function or method is too large for one AI transformation' }, { status: 413 })
    } else if (bytes.byteLength > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'This source file is too large for one AI transformation. Edit it in a local tool or select a smaller code unit.' }, { status: 413 })
    }
    const provider = await prisma.userLlmProvider.findFirst({
      where: { id: String(body.providerId).trim(), userId: user.userId, providerType: 'openai_compatible' },
      select: { id: true, name: true, modelIdentifier: true, timeout: true },
    })
    if (!provider) return NextResponse.json({ error: 'Saved OpenAI-compatible provider not found' }, { status: 404 })

    // Give the model a small, same-run neighborhood so names can be inferred from
    // how this class interacts with its collaborators, rather than this file alone.
    const runPrefix = `${segments.slice(0, 4).join('/')}/`
    const classReferences = classReferencesOf(attributes.classReferences).filter((name) => name !== unitName)
    const relatedRows = classReferences.length ? await prisma.reamonObservation.findMany({
      where: {
        projectId,
        artifactId: artifact.id,
        source: observation.source,
        ...(observation.taskId ? { taskId: observation.taskId } : {}),
        type: 'code_unit',
        label: { in: classReferences },
      },
      select: { id: true, label: true, attributes: true },
      orderBy: { updatedAt: 'desc' },
      take: 1000,
    }) : []
    const relatedByName = new Map<string, Record<string, unknown>>()
    const relatedUnitIdByName = new Map<string, string>()
    for (const row of relatedRows) {
      const name = row.label || ''
      const relatedAttributes = plainObject(row.attributes)
      const relatedArtifactId = typeof relatedAttributes.codeArtifactId === 'string' ? relatedAttributes.codeArtifactId : ''
      if (classReferences.includes(name) && relatedArtifactId.startsWith(runPrefix) && !relatedByName.has(name)) {
        relatedByName.set(name, relatedAttributes)
        relatedUnitIdByName.set(name, row.id)
      }
    }

    // Analyzer call relationships are run-scoped observations. Use direct
    // neighbors from this exact task and artifact as rewrite evidence.
    if (observation.taskId && observation.stableKey) {
      const callEdges = await prisma.reamonObservation.findMany({
        where: {
          projectId,
          taskId: observation.taskId,
          artifactId: artifact.id,
          kind: 'relationship',
          type: 'calls',
          source: observation.source,
        },
        select: { fromKey: true, toKey: true, attributes: true },
        orderBy: { stableKey: 'asc' },
        take: 401,
      })
      const neighborKeys: string[] = []
      const seenNeighborKeys = new Set<string>()
      const requestedMemberName = body.scope === 'member' && typeof body.memberName === 'string'
        ? body.memberName.trim().slice(0, 500)
        : ''
      const simpleClassName = unitName.split('.').at(-1)?.split('$').at(-1) || unitName
      const selectedMethodName = requestedMemberName === simpleClassName ? '<init>' : requestedMemberName
      const methodNameFromSignature = (value: unknown) => typeof value === 'string'
        ? value.split('->').at(-1)?.split('(')[0] || ''
        : ''
      for (const edge of callEdges) {
        const edgeAttributes = plainObject(edge.attributes)
        const fromClassKey = typeof edgeAttributes.fromCodeUnitKey === 'string' ? edgeAttributes.fromCodeUnitKey : ''
        const toClassKey = typeof edgeAttributes.toCodeUnitKey === 'string' ? edgeAttributes.toCodeUnitKey : ''
        const fromMatches = edge.fromKey === observation.stableKey
          || (fromClassKey === observation.stableKey && (!selectedMethodName || methodNameFromSignature(edgeAttributes.fromSignature) === selectedMethodName))
        const toMatches = edge.toKey === observation.stableKey
          || (toClassKey === observation.stableKey && (!selectedMethodName || methodNameFromSignature(edgeAttributes.toSignature) === selectedMethodName))
        if (!fromMatches && !toMatches) continue
        const neighborKey = fromMatches ? toClassKey || edge.toKey : fromClassKey || edge.fromKey
        if (!neighborKey || neighborKey === observation.stableKey || seenNeighborKeys.has(neighborKey)) continue
        seenNeighborKeys.add(neighborKey)
        neighborKeys.push(neighborKey)
        if (neighborKeys.length >= MAX_CONTEXT_UNITS) break
      }
      const neighborRows = neighborKeys.length ? await prisma.reamonObservation.findMany({
        where: {
          projectId,
          taskId: observation.taskId,
          artifactId: artifact.id,
          source: observation.source,
          kind: 'entity',
          type: 'code_unit',
          stableKey: { in: neighborKeys },
        },
        select: { id: true, label: true, attributes: true },
        take: MAX_CONTEXT_UNITS,
      }) : []
      for (const row of neighborRows) {
        const relatedAttributes = plainObject(row.attributes)
        const relatedArtifactId = typeof relatedAttributes.codeArtifactId === 'string' ? relatedAttributes.codeArtifactId : ''
        const name = (typeof relatedAttributes.qualifiedName === 'string' && relatedAttributes.qualifiedName)
          || (typeof relatedAttributes.name === 'string' && relatedAttributes.name)
          || row.label
          || ''
        if (!name || name === unitName || !relatedArtifactId.startsWith(runPrefix) || relatedByName.has(name)) continue
        relatedByName.set(name, relatedAttributes)
        relatedUnitIdByName.set(name, row.id)
      }
    }

    const similarFunctionNames: string[] = []
    const similarArtifactByName = new Map<string, string>()
    const similarDexMethodByName = new Map<string, { taskId: string; parentCodeUnitKey: string; methodName: string }>()
    const dexOutlineCache = new Map<string, { members: OutlineMember[]; truncated: boolean }>()
    const selectedMemberName = typeof body.memberName === 'string' ? body.memberName.trim() : ''
    const isMethodScopedRewrite = (observation.source === 'reamon-jadx' || observation.source === 'reamon-ilspy' || observation.source === 'reamon-dex-decompiler')
      && scope === 'member' && Boolean(selectedMemberName)
    if ((observation.source === 'reamon-ghidra' || observation.source === 'reamon-wabt' || isMethodScopedRewrite) && observation.taskId && observation.stableKey) {
      const targetMnemonics = boundedInstructionMnemonics(attributes.instructionMnemonics)
      if (targetMnemonics.length >= 4 || isMethodScopedRewrite) {
        const candidates = await prisma.reamonObservation.findMany({
          where: {
            projectId,
            type: isMethodScopedRewrite ? 'function' : 'code_unit',
            source: observation.source,
            artifact: { is: selection.artifactWhere },
            task: { is: {
              projectId,
              status: 'COMPLETED',
              capability: { in: ['decompile', 'disassemble'] },
              provider: { is: { pluginId: observation.source } },
            } },
          },
          orderBy: [{ updatedAt: 'desc' }, { stableKey: 'asc' }],
          take: MAX_FUNCTION_HISTORY + 1,
          select: {
            id: true, taskId: true, stableKey: true, canonicalKey: true, label: true, attributes: true, artifactId: true,
            artifact: { select: { profile: true, originalName: true, sha256: true } },
          },
        })
        const uniqueCandidates = new Map<string, typeof candidates[number]>()
        for (const candidate of candidates.slice(0, MAX_FUNCTION_HISTORY)) {
          if (observation.source === 'reamon-ghidra' && candidate.artifactId !== artifact.id
            && !sameGhidraArchitecture(attributes, candidate.attributes)) continue
          const identity = `${candidate.artifactId}:${candidate.canonicalKey}`
          if (!uniqueCandidates.has(identity)) uniqueCandidates.set(identity, candidate)
        }
        const boundedCandidates = [...uniqueCandidates.values()]
          .slice(0, MAX_FUNCTION_CANDIDATES)
          .filter((row) => row.artifactId !== artifact.id || row.canonicalKey !== observation.canonicalKey)
        const rowByKey = new Map(boundedCandidates.map((row) => [row.id, row]))
        const candidateFeatures = boundedCandidates.map((row) => {
          const candidateAttributes = plainObject(row.attributes)
          return {
            key: row.id,
            name: (typeof candidateAttributes.qualifiedName === 'string' && candidateAttributes.qualifiedName) || row.label || 'Unknown function',
            address: typeof candidateAttributes.address === 'string' ? candidateAttributes.address : null,
            mnemonics: boundedInstructionMnemonics(candidateAttributes.instructionMnemonics),
          }
        })
        const methodName = (signature: string) => {
          const tail = signature.includes('->') ? signature.slice(signature.indexOf('->') + 2)
            : signature.includes('::') ? signature.slice(signature.lastIndexOf('::') + 2) : signature
          return tail.split('(')[0].replace(/#\d+$/, '')
        }
        const selectedRelativePath = typeof attributes.relativePath === 'string' ? attributes.relativePath : ''
        const methodTargets = isMethodScopedRewrite ? boundedCandidates.filter((row) => {
          if (row.artifactId !== artifact.id) return false
          const candidateAttributes = plainObject(row.attributes)
          const candidateSignature = observation.source === 'reamon-dex-decompiler'
            ? (typeof candidateAttributes.qualifiedName === 'string' ? candidateAttributes.qualifiedName : '')
            : (typeof candidateAttributes.address === 'string' ? candidateAttributes.address : '')
          const candidateName = methodName(candidateSignature)
          const className = unitName.split('.').at(-1)?.split('+').at(-1) || ''
          const isConstructor = ['constructor', '<init>', '.ctor', className].includes(selectedMemberName)
          const expectedName = isConstructor
            ? (observation.source === 'reamon-jadx' || observation.source === 'reamon-dex-decompiler' ? '<init>' : '.ctor')
            : selectedMemberName
          const sameSourceUnit = candidateAttributes.parentCodeUnitKey === observation.stableKey
            || (selectedRelativePath && candidateAttributes.relativePath === selectedRelativePath)
          return sameSourceUnit && candidateName === expectedName
        }) : []
        const targets = isMethodScopedRewrite
          ? methodTargets.map((row) => {
            const candidateAttributes = plainObject(row.attributes)
            return { key: row.id, name: row.label || selectedMemberName, address: typeof candidateAttributes.address === 'string' ? candidateAttributes.address : null, mnemonics: boundedInstructionMnemonics(candidateAttributes.instructionMnemonics) }
          }).filter((target) => target.mnemonics.length >= 4)
          : targetMnemonics.length >= 4 ? [{ key: observation.id, name: unitName, address: typeof attributes.address === 'string' ? attributes.address : null, mnemonics: targetMnemonics }] : []
        const similarFunctions = targets.flatMap((target) => rankSimilarInstructionFunctions(target, candidateFeatures, MAX_CONTEXT_UNITS))
          .reduce((matches, match) => {
            const prior = matches.get(match.key)
            if (!prior || prior.similarity < match.similarity) matches.set(match.key, match)
            return matches
          }, new Map<string, typeof candidateFeatures[number] & { similarity: number }>())
        const rankedMatches = [...similarFunctions.values()].sort((left, right) => right.similarity - left.similarity).slice(0, MAX_CONTEXT_UNITS)
        const functionParentRefs = isMethodScopedRewrite ? rankedMatches.flatMap((match) => {
          const row = rowByKey.get(match.key)
          const candidateAttributes = row ? plainObject(row.attributes) : {}
          const parentKey = candidateAttributes.parentCodeUnitKey
          return row?.taskId && typeof parentKey === 'string' && parentKey
            ? [{ taskId: row.taskId, stableKey: parentKey }]
            : []
        }) : []
        const functionParentRows = functionParentRefs.length ? await prisma.reamonObservation.findMany({
          where: {
            projectId,
            source: observation.source,
            type: 'code_unit',
            taskId: { in: [...new Set(functionParentRefs.map((reference) => reference.taskId))] },
            stableKey: { in: [...new Set(functionParentRefs.map((reference) => reference.stableKey))] },
            artifact: { is: selection.artifactWhere },
          },
          select: { id: true, taskId: true, stableKey: true },
        }) : []
        const functionParentByKey = new Map(functionParentRows.map((row) => [`${row.taskId}:${row.stableKey}`, row]))
        for (const match of rankedMatches) {
          const row = rowByKey.get(match.key)
          if (!row) continue
          const relatedAttributes = plainObject(row.attributes)
          const relatedArtifactId = typeof relatedAttributes.codeArtifactId === 'string' ? relatedAttributes.codeArtifactId : ''
          if (!row.artifactId || !belongsToArtifactRun(relatedArtifactId, projectId, row.artifactId)) continue
          const name = (typeof relatedAttributes.qualifiedName === 'string' && relatedAttributes.qualifiedName)
            || (typeof relatedAttributes.name === 'string' && relatedAttributes.name)
            || row.label
            || ''
          if (!name || name === unitName || relatedByName.has(name)) continue
          relatedByName.set(name, {
            ...relatedAttributes,
            instructionSimilarityPercent: match.similarity,
            instructionArtifactName: row.artifact?.originalName,
            instructionArtifactHash: row.artifact?.sha256,
          })
          const parentKey = relatedAttributes.parentCodeUnitKey
          const parent = row.taskId && typeof parentKey === 'string'
            ? functionParentByKey.get(`${row.taskId}:${parentKey}`)
            : undefined
          relatedUnitIdByName.set(name, parent?.id || row.id)
          similarArtifactByName.set(name, row.artifactId)
          if (observation.source === 'reamon-dex-decompiler' && row.taskId
            && typeof parentKey === 'string' && typeof relatedAttributes.name === 'string') {
            similarDexMethodByName.set(name, {
              taskId: row.taskId,
              parentCodeUnitKey: parentKey,
              methodName: relatedAttributes.name,
            })
          }
          similarFunctionNames.push(name)
        }
      }
    }
    const references = [...new Set([...similarFunctionNames, ...relatedByName.keys()])]
    const relatedUnitIds = [...relatedUnitIdByName.values()]
    const providerRelatedUnitIds = [...relatedUnitIdByName.entries()].flatMap(([name, id]) =>
      similarArtifactByName.has(name) && similarArtifactByName.get(name) !== artifact.id ? [] : [id])
    const providerSymbolUnitIds = [...new Set([observation.id, ...providerRelatedUnitIds])]
    const providerSymbolInputTruncated = providerSymbolUnitIds.length > MAX_PROVIDER_SYMBOL_RECORDS
    const [maintainedRelatedRows, projectDraftRows, currentDraft, providerSymbolRows] = await Promise.all([
      relatedUnitIds.length ? prisma.reamonMaintainedSource.findMany({
        where: { projectId, codeUnitId: { in: relatedUnitIds } },
        select: { codeUnitId: true, artifactId: true, unitName: true, language: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      }) : Promise.resolve([]),
      prisma.reamonCodeDraft.findMany({
        where: { projectId, artifactId: artifact.id, runKey: runPrefix.slice(0, -1) },
        select: { codeUnitId: true, unitName: true, language: true, sourceHash: true, sourceCode: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: MAX_PROJECT_DRAFT_RECORDS,
      }),
      prisma.reamonCodeDraft.findFirst({
        where: { projectId, artifactId: artifact.id, runKey: runPrefix.slice(0, -1), codeUnitId: observation.id, sourceHash },
        select: { sourceCode: true, unitName: true, language: true },
        orderBy: { updatedAt: 'desc' },
      }),
      observation.taskId ? prisma.reamonObservation.findMany({
        where: {
          projectId,
          artifactId: artifact.id,
          taskId: observation.taskId,
          source: observation.source,
          id: { in: providerSymbolUnitIds.slice(0, MAX_PROVIDER_SYMBOL_RECORDS) },
          type: 'code_unit',
        },
        select: { id: true, label: true, attributes: true },
        orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      }) : Promise.resolve([]),
    ])
    // Read project memory in bounded pages so older maintained units are not
    // permanently hidden behind only the newest page in large APK projects.
    // The cap bounds database work while the model context itself remains small.
    const projectSymbolRows: Array<{
      codeUnitId: string
      artifactId: string
      unitName: string
      language: string
      sourceHash: string | null
      acceptedReviewId: string | null
      symbolIndex: unknown
    }> = []
    let symbolCursor: string | undefined
    while (projectSymbolRows.length < MAX_PROJECT_SYMBOL_SCAN) {
      const page = await prisma.reamonMaintainedSource.findMany({
        where: { projectId },
        select: { codeUnitId: true, artifactId: true, unitName: true, language: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true, id: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        ...(symbolCursor ? { cursor: { id: symbolCursor }, skip: 1 } : {}),
        take: Math.min(MAX_PROJECT_SYMBOL_RECORDS, MAX_PROJECT_SYMBOL_SCAN - projectSymbolRows.length),
      })
      if (!page.length) break
      projectSymbolRows.push(...page.map(({ id: _id, ...row }) => row))
      symbolCursor = page.at(-1)?.id
      if (page.length < MAX_PROJECT_SYMBOL_RECORDS) break
    }
    const symbolRecords = [...maintainedRelatedRows, ...projectSymbolRows]
    const acceptedReviewIds = [...new Set(symbolRecords.flatMap((row) => row.acceptedReviewId ? [row.acceptedReviewId] : []))]
    const acceptedReviews = acceptedReviewIds.length ? await prisma.reamonCodeReview.findMany({
      where: { projectId, id: { in: acceptedReviewIds }, decision: 'ACCEPTED' },
      select: { id: true, artifactId: true, codeUnitId: true, maintainedSourceHash: true },
    }) : []
    const acceptedReviewById = new Map(acceptedReviews.map((review) => [review.id, review]))
    const trustedSymbolRecords = symbolRecords.filter((row) => {
      if (!row.sourceHash || !row.acceptedReviewId) return false
      const receipt = acceptedReviewById.get(row.acceptedReviewId)
      return receipt?.artifactId === row.artifactId
        && receipt.codeUnitId === row.codeUnitId
        && receipt.maintainedSourceHash === row.sourceHash
    })
    const trustedRecordKeys = new Set(trustedSymbolRecords.map((row) => JSON.stringify([row.codeUnitId, row.artifactId, row.sourceHash, row.acceptedReviewId])))
    const trustedRelatedRows = maintainedRelatedRows.filter((row) => trustedRecordKeys.has(JSON.stringify([row.codeUnitId, row.artifactId, row.sourceHash, row.acceptedReviewId])))
    const symbolArtifactIds = [...new Set(trustedSymbolRecords.map((row) => row.artifactId))]
    const symbolArtifacts = symbolArtifactIds.length ? await prisma.artifact.findMany({
      where: { projectId, id: { in: symbolArtifactIds } },
      select: { id: true, originalName: true, sha256: true },
    }) : []
    const artifactById = new Map(symbolArtifacts.map((artifactRow) => [artifactRow.id, artifactRow]))
    const maintainedByUnitId = new Map(trustedRelatedRows.map((row) => [row.codeUnitId, row]))
    const maintainedProjectContext = buildProjectSymbolContext(trustedSymbolRecords.map((row) => ({
      ...row,
      artifactName: artifactById.get(row.artifactId)?.originalName,
      artifactHash: artifactById.get(row.artifactId)?.sha256,
    })), new Set(relatedUnitIds), undefined, artifact.sha256)
    const providerSymbolContext = observation.taskId ? buildProviderSymbolContext(
      providerSymbolRows.map((row) => {
        const providerAttributes = plainObject(row.attributes)
        const providerVariables = providerVariablesOf(providerAttributes, observation.source)
        const goIdentity = [
          providerAttributes.symbolSource === 'GoReSym' ? 'symbol recovered by GoReSym' : '',
          typeof providerAttributes.goPackage === 'string' ? `Go package ${providerAttributes.goPackage.slice(0, 200)}` : '',
        ].filter(Boolean).join('; ')
        return {
          codeUnitId: row.id,
          unitName: (typeof providerAttributes.qualifiedName === 'string' && providerAttributes.qualifiedName)
            || (typeof providerAttributes.name === 'string' && providerAttributes.name)
            || row.label
            || 'Unnamed code unit',
          language: (typeof providerAttributes.language === 'string' && providerAttributes.language)
            || (typeof providerAttributes.sourceLanguage === 'string' && providerAttributes.sourceLanguage)
            || 'unknown',
          address: typeof providerAttributes.address === 'string' ? providerAttributes.address : undefined,
          prototype: typeof providerAttributes.prototype === 'string' ? providerAttributes.prototype : undefined,
          providerEvidence: goIdentity || undefined,
          recoveredVariables: providerVariables.variables,
          recoveredVariablesTruncated: providerVariables.truncated
            || providerAttributes.recoveredVariablesTruncated === true,
        }
      }),
      new Set(providerRelatedUnitIds),
      8_000,
      {
        provider: observation.source,
        artifactName: artifact.originalName,
        artifactHash: artifact.sha256,
        taskId: observation.taskId,
        inputTruncated: providerSymbolInputTruncated,
      },
      observation.id,
    ) : ''
    const dexMethodExcerptCache = new Map<string, { members: OutlineMember[]; truncated: boolean }>()
    const dexMethodExcerpt = async (name: string, source: Buffer, sourceLanguage: string, relatedArtifactId: string, persistOutline: boolean) => {
      const candidate = similarDexMethodByName.get(name)
      const relatedAttributes = relatedByName.get(name)
      if (!candidate || !relatedAttributes) return null
      const signature = typeof relatedAttributes.qualifiedName === 'string' ? relatedAttributes.qualifiedName : name
      const parentName = signature.includes('->') ? signature.slice(0, signature.indexOf('->')) : signature.split('#')[0]
      return dexMethodSourceExcerpt({
        projectId,
        taskId: candidate.taskId,
        artifactId: similarArtifactByName.get(name) || artifact.id,
        parentCodeUnitKey: candidate.parentCodeUnitKey,
        parentName: parentName || unitName,
        language: sourceLanguage || 'Java',
        relativePath: typeof relatedAttributes.relativePath === 'string' ? relatedAttributes.relativePath : null,
        codeArtifactId: relatedArtifactId,
        methodName: candidate.methodName,
        source,
        cache: dexMethodExcerptCache,
        persistOutline,
      })
    }
    const draftByUnitId = new Map<string, typeof projectDraftRows[number]>()
    for (const draft of projectDraftRows) if (!draftByUnitId.has(draft.codeUnitId)) draftByUnitId.set(draft.codeUnitId, draft)
    const rankedDrafts = [...draftByUnitId.values()].sort((left, right) => Number(relatedUnitIds.includes(right.codeUnitId)) - Number(relatedUnitIds.includes(left.codeUnitId)))
    const draftIndexBatch: typeof rankedDrafts = []
    let draftIndexBytes = 0
    for (const draft of rankedDrafts) {
      const bytes = Buffer.byteLength(draft.sourceCode, 'utf8')
      if (draftIndexBytes + bytes > 2 * 1024 * 1024) continue
      draftIndexBatch.push(draft)
      draftIndexBytes += bytes
    }
    const draftSymbolsByUnitId = new Map<string, string[]>()
    if (draftIndexBatch.length) {
      try {
        const indexResponse = await agentFetch('/reamon/code/index-symbols', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources: draftIndexBatch.map(({ language: draftLanguage, sourceCode }) => ({
            language: draftLanguage,
            source_code: sourceCode,
          })) }),
        }, { timeoutMs: 5_000 })
        const indexResult = await indexResponse.json().catch(() => null) as { results?: unknown } | null
        if (indexResponse.ok && Array.isArray(indexResult?.results) && indexResult.results.length === draftIndexBatch.length) {
          indexResult.results.forEach((value, index) => {
            const result = plainObject(value)
            if (result.indexed !== true || !Array.isArray(result.symbols)) return
            draftSymbolsByUnitId.set(draftIndexBatch[index].codeUnitId, [...new Set(
              result.symbols.filter((symbol): symbol is string => typeof symbol === 'string' && symbol.length > 1 && symbol.length <= 128),
            )].slice(0, 512))
          })
        }
      } catch {
        // Project drafts remain usable as tentative hints if syntax indexing is unavailable.
      }
    }
    const draftSymbolLines: string[] = []
    let draftContextChars = 0
    for (const draft of rankedDrafts) {
      const symbols = draftSymbolsByUnitId.get(draft.codeUnitId) ?? extractMaintainedSymbols(draft.sourceCode, draft.language)
      if (!symbols.length) continue
      const line = `${draft.unitName} (${draft.language}; unreviewed project draft): ${symbols.join(', ')}`
      if (draftContextChars + line.length + 1 > 4_000) continue
      draftSymbolLines.push(line)
      draftContextChars += line.length + 1
    }
    const projectDraftContext = draftSymbolLines.length
      ? `Unreviewed draft naming evidence from this imported artifact (consistency hints only; behavior is not accepted):\n${draftSymbolLines.join('\n')}`
      : ''
    const priorAttempts = await prisma.reamonCodeAttempt.findMany({
      where: { projectId, artifactId: artifact.id, runKey: runPrefix.slice(0, -1), codeUnitId: observation.id, sourceHash },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { providerName: true, modelIdentifier: true, question: true, scope: true, status: true, errorCode: true, errorMessage: true, syntaxValidated: true, validationStatus: true, validationMethod: true, validationMessage: true, createdAt: true },
    })
    const priorAttemptLines = priorAttempts.reverse().map((attempt, index) => {
      const outcome = attempt.status === 'SUCCEEDED'
        ? `succeeded; syntax validated: ${attempt.syntaxValidated === true ? 'yes' : attempt.syntaxValidated === false ? 'no' : 'unknown'}`
        : attempt.status === 'RUNNING'
          ? 'did not finish (the prior request may have been interrupted)'
          : `failed${attempt.errorCode ? ` (${attempt.errorCode})` : ''}${attempt.errorMessage ? `: ${attempt.errorMessage}` : ''}`
      const validation = attempt.validationStatus
        ? `; validation=${attempt.validationStatus.toLowerCase()}${attempt.validationMethod ? ` via ${attempt.validationMethod}` : ''}${attempt.validationMessage ? `: ${attempt.validationMessage}` : ''}`
        : ''
      return `${index + 1}. ${attempt.providerName} / ${attempt.modelIdentifier}; scope=${attempt.scope}; request=${attempt.question || '(default)'}; outcome=${outcome}${validation}`
    })
    const priorAttemptContext = utf8Prefix(priorAttemptLines.join('\n'), 4 * 1024)
    const contextSources: Array<{ unit_name: string; language: string; source_code: string }> = []
    let contextBytes = 0
    if (scope === 'member' && body.startByte !== undefined && body.endByte !== undefined && contextSources.length < MAX_CONTEXT_UNITS) {
      try {
        const cached = await cachedOutlineMembers({ projectId, taskId: observation.taskId, artifactId: artifact.id, parentCodeUnitKey: observation.stableKey, sourceHash })
        let members = cached.members
        if (!members.length) {
          const outline = await requestOutline(language, fullBytes)
          members = outline?.members || []
          if (outline) await persistOutlineMembers({
              projectId, taskId: observation.taskId, artifactId: artifact.id, sourceHash,
              parentCodeUnitKey: observation.stableKey, parentName: unitName, language,
              relativePath: typeof attributes.relativePath === 'string' ? attributes.relativePath : null,
              codeArtifactId, members, truncated: outline.truncated, parserVersion: outline.parserVersion,
            })
        }
        const startByte = body.startByte as number
        const endByte = body.endByte as number
        const siblings = members.filter((member) => member.end_byte <= fullBytes.byteLength
          && (member.start_byte !== startByte || member.end_byte !== endByte))
          .sort((left, right) => Math.abs(left.start_byte - startByte) - Math.abs(right.start_byte - startByte))
        let sameFileBytes = 0
        let sameFileMembers = 0
        for (const sibling of siblings) {
          if (sameFileMembers >= MAX_SAME_FILE_CONTEXT_MEMBERS || contextSources.length >= MAX_CONTEXT_UNITS || sameFileBytes >= MAX_SAME_FILE_CONTEXT_BYTES || contextBytes >= MAX_CONTEXT_BYTES) break
          const from = sibling.start_byte
          const to = sibling.end_byte
          const remaining = Math.min(MAX_SAME_FILE_CONTEXT_BYTES - sameFileBytes, MAX_CONTEXT_BYTES - contextBytes)
          const source = fullBytes.subarray(from, Math.min(to, from + remaining)).toString('utf8')
          if (!source.trim()) continue
          const siblingName = sibling.name.slice(0, 300) || 'unnamed member'
          const truncated = to - from > Buffer.byteLength(source, 'utf8')
          contextSources.push({
            unit_name: `${unitName} :: ${siblingName} (same-file sibling${truncated ? '; excerpt truncated' : ''}; analyzer source evidence)`,
            language: language.slice(0, 80),
            source_code: source,
          })
          const sourceBytes = Buffer.byteLength(source, 'utf8')
          sameFileMembers += 1
          sameFileBytes += sourceBytes
          contextBytes += sourceBytes
        }
      } catch {
        // Same-file context is optional; the selected method and call graph remain usable.
      }
    }
    if (currentDraft?.sourceCode.trim() && contextSources.length < MAX_CONTEXT_UNITS && contextBytes < MAX_CONTEXT_BYTES) {
      const source = utf8Prefix(currentDraft.sourceCode, MAX_CONTEXT_BYTES - contextBytes)
      if (source.trim()) {
        contextSources.push({
          unit_name: `${unitName} (current unreviewed draft; naming and previously rewritten members are provisional context)`,
          language: currentDraft.language.slice(0, 80),
          source_code: source,
        })
        contextBytes += Buffer.byteLength(source, 'utf8')
      }
    }
    for (const name of references) {
      if (contextSources.length >= MAX_CONTEXT_UNITS || contextBytes >= MAX_CONTEXT_BYTES) break
      const relatedAttributes = relatedByName.get(name)
      const similarityPercent = typeof relatedAttributes?.instructionSimilarityPercent === 'number'
        ? relatedAttributes.instructionSimilarityPercent
        : null
      const similarityArtifactName = typeof relatedAttributes?.instructionArtifactName === 'string'
        ? relatedAttributes.instructionArtifactName.slice(0, 160)
        : ''
      const similarityArtifactHash = typeof relatedAttributes?.instructionArtifactHash === 'string'
        ? relatedAttributes.instructionArtifactHash.slice(0, 12)
        : ''
      const similarityArtifact = [similarityArtifactName, similarityArtifactHash].filter(Boolean).join(' #')
      const similarityHint = similarityPercent === null
        ? ''
        : ` (instruction-pattern look-alike, ${similarityPercent}% sequence similarity; candidate only${similarityArtifact ? `, from artifact ${similarityArtifact}` : ''})`
      const smaliSimilarity = similarityPercent !== null && observation.source === 'reamon-jadx'
      const relatedArtifactId = typeof (smaliSimilarity ? relatedAttributes?.disassemblyArtifactId : relatedAttributes?.codeArtifactId) === 'string'
        ? (smaliSimilarity ? relatedAttributes?.disassemblyArtifactId : relatedAttributes?.codeArtifactId) as string
        : ''
      const expectedArtifactId = similarityPercent !== null ? similarArtifactByName.get(name) || artifact.id : artifact.id
      if (!belongsToArtifactRun(relatedArtifactId, projectId, expectedArtifactId)) continue
      const relatedUnitId = relatedUnitIdByName.get(name)
      const maintainedSource = relatedUnitId ? maintainedByUnitId.get(relatedUnitId) : undefined
      if (maintainedSource?.sourceCode.trim()) {
        let methodExcerpt: { source: string; ambiguous: boolean; truncated: boolean } | null = null
        try {
          methodExcerpt = await dexMethodExcerpt(name, Buffer.from(maintainedSource.sourceCode, 'utf8'), maintainedSource.language, relatedArtifactId, false)
        } catch {
          // A syntax outline is optional; use the accepted source if it is unavailable.
        }
        const source = utf8Prefix(methodExcerpt?.source || maintainedSource.sourceCode, MAX_CONTEXT_BYTES - contextBytes)
        contextSources.push({
          unit_name: `${name}${similarityHint} (saved maintained version: ${maintainedSource.unitName}${methodExcerpt ? `; syntax-outlined method source${methodExcerpt.ambiguous ? '; same-name candidates may be ambiguous' : ''}${methodExcerpt.truncated ? '; outline truncated' : ''}` : ''})`,
          language: maintainedSource.language.slice(0, 80),
          source_code: source,
        })
        contextBytes += Buffer.byteLength(source, 'utf8')
        continue
      }
      const relatedPath = resolveDerivedArtifactPath(relatedArtifactId)
      try {
        const safeRelatedPath = await realpath(relatedPath)
        if (!isInside(rootPath, safeRelatedPath)) continue
        const relatedInfo = await stat(safeRelatedPath)
        if (!relatedInfo.isFile() || relatedInfo.size > MAX_ARTIFACT_BYTES) continue
        const relatedBytes = await readFile(safeRelatedPath)
        const remaining = MAX_CONTEXT_BYTES - contextBytes
        const source = smaliSimilarity
          ? relatedBytes.toString('utf8')
          : relatedBytes.subarray(0, Math.min(remaining, MAX_CONTEXT_BYTES)).toString('utf8')
        if (!source.trim()) continue
        let relatedSource = source
        if (similarityPercent !== null && observation.source === 'reamon-dex-decompiler') {
          const excerpt = await dexMethodExcerpt(name, relatedBytes, language, relatedArtifactId, true)
          if (excerpt) relatedSource = excerpt.source
        }
        if (smaliSimilarity) {
          const fullSignature = typeof relatedAttributes?.address === 'string' ? relatedAttributes.address : ''
          const methodSignature = fullSignature.includes('->') ? fullSignature.slice(fullSignature.indexOf('->') + 2) : ''
          const lines = source.split(/\r?\n/)
          const start = lines.findIndex((line) => /^\s*\.method\b/.test(line) && line.trimEnd().endsWith(methodSignature))
          const end = start >= 0 ? lines.findIndex((line, index) => index > start && /^\s*\.end method\s*$/.test(line)) : -1
          if (start >= 0) relatedSource = lines.slice(start, end >= 0 ? end + 1 : Math.min(lines.length, start + 128)).join('\n')
        }
        contextSources.push({
          unit_name: `${name}${similarityHint}${similarityPercent !== null && observation.source === 'reamon-dex-decompiler' && relatedSource !== source ? ` (syntax-outlined Java method source${relatedSource.includes('same-name candidate') ? '; overload candidates may be ambiguous' : ''}${relatedSource.includes('syntax outline truncated') ? '; outline truncated' : ''})` : ''}`,
          language: smaliSimilarity ? 'Smali'
            : relatedAttributes?.language === 'IL' ? 'C#'
              : (typeof relatedAttributes?.language === 'string' ? relatedAttributes.language.slice(0, 80) : language),
          source_code: utf8Prefix(relatedSource, MAX_CONTEXT_BYTES - contextBytes),
        })
        contextBytes += Buffer.byteLength(contextSources.at(-1)?.source_code || '', 'utf8')
      } catch {
        // Related evidence is optional; the selected source remains usable.
      }
    }

    let dexReferenceRows: Array<{ type: string; label: string | null; attributes: unknown }> = []
    let selectedDexMethods: Array<{ label: string | null; attributes: unknown }> = []
    let dexReferencesTruncated = false
    if (observation.source === 'reamon-dex-decompiler' && observation.taskId && observation.stableKey) {
      let methodSignatures: string[] = []
      if (scope === 'member' && selectedMemberName) {
        const simpleClassName = unitName.split(/[.$/]/).at(-1)?.replace(/^L|;$/g, '') || unitName
        const constructorSelected = ['constructor', '<init>', '.ctor', simpleClassName, unitName].includes(selectedMemberName)
        const methodNames = constructorSelected ? ['<init>'] : [selectedMemberName]
        const methodRows = await prisma.reamonObservation.findMany({
          where: {
            projectId,
            artifactId: artifact.id,
            taskId: observation.taskId,
            source: observation.source,
            type: 'function',
            AND: [
              { attributes: { path: ['parentCodeUnitKey'], equals: observation.stableKey } },
              { OR: methodNames.map((name) => ({ attributes: { path: ['name'], equals: name } })) },
            ],
          },
          orderBy: { stableKey: 'asc' },
          take: MAX_DEX_REFERENCE_METHODS + 1,
          select: { label: true, attributes: true },
        })
        dexReferencesTruncated = methodRows.length > MAX_DEX_REFERENCE_METHODS
        selectedDexMethods = methodRows.slice(0, MAX_DEX_REFERENCE_METHODS)
        methodSignatures = [...new Set(methodRows.slice(0, MAX_DEX_REFERENCE_METHODS).flatMap((row) => {
          const signature = plainObject(row.attributes).qualifiedName
          return typeof signature === 'string' && signature ? [signature] : []
        }))]
      }
      if (scope !== 'member' || methodSignatures.length) {
        const signatureFilter = scope === 'member'
          ? [{ OR: methodSignatures.map((signature) => ({ attributes: { path: ['fromSignature'], equals: signature } })) }]
          : []
        const references = await prisma.reamonObservation.findMany({
          where: {
            projectId,
            artifactId: artifact.id,
            taskId: observation.taskId,
            source: observation.source,
            kind: 'relationship',
            type: { in: ['reads_field', 'writes_field', 'references_string'] },
            AND: [
              { attributes: { path: ['fromCodeUnitKey'], equals: observation.stableKey } },
              ...signatureFilter,
            ],
          },
          orderBy: { stableKey: 'asc' },
          take: MAX_DEX_REFERENCE_ROWS + 1,
          select: { type: true, label: true, attributes: true },
        })
        dexReferencesTruncated ||= references.length > MAX_DEX_REFERENCE_ROWS
        dexReferenceRows = references.slice(0, MAX_DEX_REFERENCE_ROWS)
      }
    }

    const disassemblyArtifactId = typeof attributes.disassemblyArtifactId === 'string' ? attributes.disassemblyArtifactId : ''
    const referencedStrings = observation.source === 'reamon-ghidra'
      ? classReferencesOf(attributes.referencedStrings).slice(0, 12).map((value) => value.slice(0, 512))
      : []
    const binaryEvidence = observation.source === 'reamon-dex-decompiler' && (dexReferenceRows.length || dexReferencesTruncated)
      ? dexReferenceEvidence(dexReferenceRows, dexReferencesTruncated)
      : referencedStrings.length
      ? utf8Prefix(`Function address: ${typeof attributes.address === 'string' ? attributes.address.slice(0, 128) : 'unknown'}\n` + referencedStrings.map((value) => `Referenced text: ${value}`).join('\n'), MAX_BINARY_EVIDENCE_BYTES)
      : ''
    let disassemblySource = observation.source === 'reamon-dex-decompiler' && scope === 'member' && selectedDexMethods.length
      ? await dexBytecodeEvidence(selectedDexMethods, projectId, artifact.id, rootPath)
      : ''
    if (!disassemblySource && disassemblyArtifactId.startsWith(runPrefix)) {
      try {
        const safeDisassemblyPath = await realpath(resolveDerivedArtifactPath(disassemblyArtifactId))
        if (isInside(rootPath, safeDisassemblyPath)) {
          const disassemblyInfo = await stat(safeDisassemblyPath)
          if (disassemblyInfo.isFile() && disassemblyInfo.size <= MAX_ARTIFACT_BYTES) {
            const disassembly = await readFile(safeDisassemblyPath)
            const disassemblyText = disassembly.toString('utf8')
            disassemblySource = scope === 'member'
              ? smaliMethodEvidence(disassemblyText, String(body.memberName), String(unitName))
              : disassembly.subarray(0, MAX_DISASSEMBLY_BYTES).toString('utf8')
          }
        }
      } catch {
        // Bytecode evidence is optional; the selected source remains usable.
      }
    }
    const timeoutSeconds = typeof provider.timeout === 'number' && Number.isFinite(provider.timeout) ? provider.timeout : 120
    const timeoutMs = Math.max(10_000, Math.min(300_000, timeoutSeconds * 1000))

    const leaseIdentity = JSON.stringify([artifact.id, runPrefix.slice(0, -1), observation.id, sourceHash])
    const leaseKey = createHash('sha256').update(leaseIdentity).digest('hex')
    const leaseWhere = { projectId, leaseKey }
    const leaseNow = new Date()
    await prisma.reamonCodeUnitLease.deleteMany({ where: { ...leaseWhere, expiresAt: { lte: leaseNow } } })
    try {
      const lease = await prisma.reamonCodeUnitLease.create({
        data: {
          ...leaseWhere,
          artifactId: artifact.id,
          runKey: runPrefix.slice(0, -1),
          codeUnitId: observation.id,
          sourceHash,
          expiresAt: new Date(leaseNow.getTime() + Math.max(timeoutMs + codeRewriteLeaseGraceMs, MAX_QUEUED_REWRITE_MS)),
        },
        select: { id: true },
      })
      codeUnitLeaseId = lease.id
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error
      return NextResponse.json({ error: 'A rewrite is already running for this unit and source version. Wait for it to finish, then retry.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    const acquiredLeaseId = codeUnitLeaseId
    if (!acquiredLeaseId) throw new Error('Could not acquire the code-unit rewrite lease')

    const attemptScope = { projectId, artifactId: artifact.id, runKey: runPrefix.slice(0, -1), codeUnitId: observation.id, sourceHash }
    await failInterruptedCodeAttempts(attemptScope, leaseNow)

    const requestPayload = {
      model: `custom/${provider.id}`,
      user_id: user.userId,
      unit_name: String(unitName).slice(0, 500),
      language: language.slice(0, 80),
      source_language: sourceLanguage.slice(0, 80),
      source_code: bytes.toString('utf8'),
      scope,
      member_name: scope === 'member' ? String(body.memberName).slice(0, 500) : '',
      context_sources: contextSources,
      disassembly_source: disassemblySource,
      binary_evidence: binaryEvidence,
      project_symbol_context: maintainedProjectContext,
      provider_symbol_context: providerSymbolContext,
      project_draft_context: projectDraftContext,
      prior_attempt_context: priorAttemptContext,
      question: typeof body.question === 'string' ? body.question.trim() : '',
    }
    const attempt = await prisma.reamonCodeAttempt.create({
      data: {
        ...attemptScope,
        ownerUserId: user.userId,
        unitName: String(unitName).slice(0, 500),
        language: language.slice(0, 80),
        providerName: provider.name.slice(0, 128),
        modelIdentifier: provider.modelIdentifier.slice(0, 128),
        question: typeof body.question === 'string' ? body.question.trim() : '',
        scope,
        status: 'QUEUED',
        requestPayload,
        timeoutMs,
        unitLeaseId: acquiredLeaseId,
      },
      select: { id: true },
    })
    runningAttemptId = null
    codeUnitLeaseId = null
    return NextResponse.json({ attemptId: attempt.id, status: 'QUEUED' }, { status: 202, headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (runningAttemptId) {
      await prisma.reamonCodeAttempt.updateMany({
          where: { id: runningAttemptId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          errorCode: error instanceof AgentUnreachableError ? 'agent_unreachable' : 'request_error',
          errorMessage: error instanceof AgentUnreachableError ? 'The AI analysis service is unavailable.' : 'The rewrite request failed before completion.',
          completedAt: new Date(),
          runToken: null,
          leaseOwner: null,
          leaseHeartbeatAt: null,
        },
      }).catch(() => undefined)
    }
    if (error instanceof AgentUnreachableError) {
      console.error('AI deobfuscation could not reach the agent:', error.message)
      return NextResponse.json({ error: 'The AI analysis service is unavailable. Try again shortly.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    }
    console.error('Failed to deobfuscate REAmon code unit:', error)
    return NextResponse.json({ error: 'Failed to improve this code unit' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  } finally {
    if (codeUnitLeaseId) {
      await prisma.reamonCodeUnitLease.deleteMany({ where: { id: codeUnitLeaseId } }).catch(() => undefined)
    }
  }
}
