import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { nativeAddressAliases, nativeFunctionIdentity } from '@/lib/reamon/native-function-identity'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_ALTERNATES = 32
const MAX_ALTERNATE_OBSERVATIONS = 500
const BCF_CLEAN_COMMIT = 'f457afaa801b30f7bb98c28d419a36d5c9fd7115'
const CFF_DEFLATTEN_COMMIT = 'f457afaa801b30f7bb98c28d419a36d5c9fd7115'
const NO_STORE = { 'Cache-Control': 'private, no-store' }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const unitId = new URL(request.url).searchParams.get('unitId')?.trim() || ''
    if (!unitId || unitId.length > 128) {
      return NextResponse.json({ error: 'A valid code unit is required' }, { status: 400, headers: NO_STORE })
    }

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const unit = await prisma.reamonObservation.findFirst({
      where: {
        id: unitId,
        projectId,
        type: 'code_unit',
        artifact: { is: selection.artifactWhere },
        task: { is: { projectId, status: 'COMPLETED', capability: 'decompile' } },
      },
      select: {
        id: true,
        taskId: true,
        artifactId: true,
        source: true,
        attributes: true,
        artifact: { select: { sha256: true } },
      },
    })
    if (!unit?.taskId || !unit.artifactId || !unit.artifact?.sha256) {
      return NextResponse.json({ alternates: [] }, { headers: NO_STORE })
    }

    const attributes = record(unit.attributes)
    const relativePath = typeof attributes.relativePath === 'string' ? attributes.relativePath : ''
    const language = typeof attributes.language === 'string' ? attributes.language : ''
    const identity = typeof attributes.identity === 'string' ? attributes.identity : ''
    const selectedAddress = typeof attributes.address === 'string' ? attributes.address
      : typeof attributes.startAddress === 'string' ? attributes.startAddress : ''
    const nativeIdentity = nativeFunctionIdentity(unit.artifactId, selectedAddress)
    const addressAliases = nativeAddressAliases(selectedAddress)
    const selectedOutputHashValue = attributes.codeArtifactSha256 ?? attributes.decompiledSourceSha256
    const selectedOutputHash = typeof selectedOutputHashValue === 'string' ? selectedOutputHashValue.toLowerCase() : ''
    if (!relativePath || !language || relativePath.length > 1000 || relativePath.startsWith('/')
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
      || !/^[a-f0-9]{64}$/.test(selectedOutputHash)
      || attributes.inputArtifactSha256 !== unit.artifact.sha256) {
      return NextResponse.json({ alternates: [] }, { headers: NO_STORE })
    }

    const currentTaskPromise = prisma.task.findFirst({
      where: { id: unit.taskId, projectId, artifactId: unit.artifactId, capability: 'decompile', status: 'COMPLETED' },
      select: { id: true, runToken: true, completedAt: true, provider: { select: { pluginId: true } } },
    })

    const [matchingRows, currentTask] = await Promise.all([
      prisma.reamonObservation.findMany({
        where: {
          projectId,
          artifactId: unit.artifactId,
          task: { is: { projectId, artifactId: unit.artifactId, capability: 'decompile', status: 'COMPLETED' } },
          type: 'code_unit',
          source: { not: unit.source },
          AND: [
            { attributes: { path: ['inputArtifactSha256'], equals: unit.artifact.sha256 } },
          ],
          OR: [
            {
              AND: [
                { attributes: { path: ['relativePath'], equals: relativePath } },
                { attributes: { path: ['language'], equals: language } },
              ],
            },
            ...(nativeIdentity ? [
              ...(identity ? [{ attributes: { path: ['identity'], equals: identity } }] : []),
              ...addressAliases.flatMap((address) => [
                { attributes: { path: ['address'], equals: address } },
                { attributes: { path: ['startAddress'], equals: address } },
              ]),
            ] : []),
          ],
        },
        orderBy: [{ updatedAt: 'desc' }, { stableKey: 'asc' }],
        take: MAX_ALTERNATE_OBSERVATIONS + 1,
        select: {
          id: true, taskId: true, source: true, label: true, attributes: true,
          task: { select: { runToken: true, completedAt: true, provider: { select: { pluginId: true } } } },
        },
      }),
      currentTaskPromise,
    ])

    const rowsTruncated = matchingRows.length > MAX_ALTERNATE_OBSERVATIONS
    const rows = matchingRows.slice(0, MAX_ALTERNATE_OBSERVATIONS)
    const seenProviders = new Set<string>()
    const alternates = []
    let truncated = rowsTruncated
    let rootPath: string
    try {
      rootPath = await realpath(derivedArtifactRoot())
    } catch {
      return NextResponse.json({ alternates: [] }, { headers: NO_STORE })
    }
    const reipaArtifactId = typeof attributes.reipaAlternateCodeArtifactId === 'string'
      ? attributes.reipaAlternateCodeArtifactId
      : ''
    const reipaHash = typeof attributes.reipaAlternateOutputSha256 === 'string'
      ? attributes.reipaAlternateOutputSha256.toLowerCase()
      : ''
    const reipaVersion = typeof attributes.reipaAlternateProviderVersion === 'string'
      ? attributes.reipaAlternateProviderVersion.slice(0, 120)
      : ''
    const reipaPrefix = `${projectId}/${unit.artifactId}/${unit.taskId}/${currentTask?.runToken || ''}/`
    if (alternates.length < MAX_ALTERNATES && unit.source === 'reamon-ghidra'
      && currentTask?.provider?.pluginId === 'reamon-ghidra' && currentTask.runToken
      && reipaVersion.startsWith('ReIPA@') && /^ReIPA@[a-f0-9]{40}$/.test(reipaVersion)
      && /^[a-f0-9]{64}$/.test(reipaHash) && reipaArtifactId.startsWith(reipaPrefix)) {
      const reipaRelativePath = reipaArtifactId.slice(reipaPrefix.length)
      if (reipaRelativePath.startsWith('alternates/reipa/') && reipaRelativePath.endsWith('.c')
        && !reipaRelativePath.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
        try {
          const runRoot = await realpath(resolveDerivedArtifactPath(reipaPrefix.slice(0, -1)))
          const filePath = await realpath(resolveDerivedArtifactPath(reipaArtifactId))
          if (inside(rootPath, runRoot) && inside(runRoot, filePath)) {
            const info = await stat(filePath)
            if (info.isFile() && info.size > 0 && info.size <= MAX_SOURCE_BYTES) {
              const bytes = await readFile(filePath)
              const outputHash = createHash('sha256').update(bytes).digest('hex')
              if (outputHash === reipaHash) {
                alternates.push({
                  id: `${unit.id}:reipa`,
                  providerId: 'reamon-reipa',
                  providerName: 'ReIPA · experimental pseudocode',
                  version: reipaVersion,
                  name: typeof attributes.recoveredNativeSymbolName === 'string'
                    ? attributes.recoveredNativeSymbolName.slice(0, 500)
                    : unitId,
                  language: 'C',
                  relativePath,
                  inputSha256: unit.artifact.sha256,
                  outputSha256: outputHash,
                  completedAt: currentTask.completedAt?.toISOString() || null,
                  source: bytes.toString('utf8'),
                })
              }
            }
          }
        } catch {
          // An unavailable ReIPA alternate must not prevent reviewing Ghidra output.
        }
      }
    }
    const bcfArtifactId = typeof attributes.bcfCleanAlternateCodeArtifactId === 'string'
      ? attributes.bcfCleanAlternateCodeArtifactId : ''
    const bcfHash = typeof attributes.bcfCleanAlternateOutputSha256 === 'string'
      ? attributes.bcfCleanAlternateOutputSha256.toLowerCase() : ''
    const bcfVersion = typeof attributes.bcfCleanProviderVersion === 'string'
      ? attributes.bcfCleanProviderVersion : ''
    const bcfAuditArtifactId = typeof attributes.bcfCleanAuditArtifactId === 'string'
      ? attributes.bcfCleanAuditArtifactId : ''
    const bcfAuditHash = typeof attributes.bcfCleanAuditSha256 === 'string'
      ? attributes.bcfCleanAuditSha256.toLowerCase() : ''
    if (alternates.length < MAX_ALTERNATES && unit.source === 'reamon-ghidra'
      && currentTask?.provider?.pluginId === 'reamon-ghidra' && currentTask.runToken
      && bcfVersion === `BcfClean@${BCF_CLEAN_COMMIT}`
      && /^[a-f0-9]{64}$/.test(bcfHash) && /^[a-f0-9]{64}$/.test(bcfAuditHash)
      && bcfArtifactId.startsWith(reipaPrefix) && bcfAuditArtifactId.startsWith(reipaPrefix)) {
      const bcfRelativePath = bcfArtifactId.slice(reipaPrefix.length)
      const bcfAuditRelativePath = bcfAuditArtifactId.slice(reipaPrefix.length)
      if (/^alternates\/bcf-clean\/[a-f0-9]{1,16}\.c$/.test(bcfRelativePath)
        && bcfAuditRelativePath === 'audit/bcf-clean-patch.json') {
        try {
          const runRoot = await realpath(resolveDerivedArtifactPath(reipaPrefix.slice(0, -1)))
          const filePath = await realpath(resolveDerivedArtifactPath(bcfArtifactId))
          const auditPath = await realpath(resolveDerivedArtifactPath(bcfAuditArtifactId))
          if (inside(rootPath, runRoot) && inside(runRoot, filePath) && inside(runRoot, auditPath)) {
            const [info, auditInfo] = await Promise.all([stat(filePath), stat(auditPath)])
            if (info.isFile() && info.size > 0 && info.size <= MAX_SOURCE_BYTES
              && auditInfo.isFile() && auditInfo.size > 0 && auditInfo.size <= 8 * 1024 * 1024) {
              const [bytes, auditBytes] = await Promise.all([readFile(filePath), readFile(auditPath)])
              const outputHash = createHash('sha256').update(bytes).digest('hex')
              const auditHash = createHash('sha256').update(auditBytes).digest('hex')
              const audit = JSON.parse(auditBytes.toString('utf8')) as Record<string, unknown>
              const functions = Array.isArray(audit.functions) ? audit.functions : []
              const selectedVerifiedFunction = functions.some((value) => {
                const candidate = record(value)
                const entry = typeof candidate.entry === 'string' ? candidate.entry : ''
                const sameFunction = nativeIdentity
                  ? nativeFunctionIdentity(unit.artifactId!, entry) === nativeIdentity
                  : entry === selectedAddress || addressAliases.includes(entry)
                return sameFunction && typeof candidate.verify === 'string'
                  && candidate.verify.startsWith('OK (') && Number.isInteger(candidate.patches)
                  && Number(candidate.patches) > 0
              })
              if (outputHash === bcfHash && auditHash === bcfAuditHash
                && audit.tool === 'BcfClean' && selectedVerifiedFunction) {
                alternates.push({
                  id: `${unit.id}:bcf-clean`,
                  providerId: 'reamon-ghidra-bcf-clean',
                  providerName: 'BcfClean · emulation-verified native cleanup',
                  version: bcfVersion,
                  name: typeof attributes.qualifiedName === 'string' ? attributes.qualifiedName.slice(0, 500) : unitId,
                  language: 'C',
                  relativePath,
                  inputSha256: unit.artifact.sha256,
                  outputSha256: outputHash,
                  completedAt: currentTask.completedAt?.toISOString() || null,
                  source: bytes.toString('utf8'),
                })
              }
            }
          }
        } catch {
          // An invalid BcfClean artifact or audit must not prevent reviewing Ghidra output.
        }
      }
    }
    const cffArtifactId = typeof attributes.cffDeflattenAlternateCodeArtifactId === 'string'
      ? attributes.cffDeflattenAlternateCodeArtifactId : ''
    const cffHash = typeof attributes.cffDeflattenAlternateOutputSha256 === 'string'
      ? attributes.cffDeflattenAlternateOutputSha256.toLowerCase() : ''
    const cffVersion = typeof attributes.cffDeflattenProviderVersion === 'string'
      ? attributes.cffDeflattenProviderVersion : ''
    const cffAuditArtifactId = typeof attributes.cffDeflattenAuditArtifactId === 'string'
      ? attributes.cffDeflattenAuditArtifactId : ''
    const cffAuditHash = typeof attributes.cffDeflattenAuditSha256 === 'string'
      ? attributes.cffDeflattenAuditSha256.toLowerCase() : ''
    if (alternates.length < MAX_ALTERNATES && unit.source === 'reamon-ghidra'
      && currentTask?.provider?.pluginId === 'reamon-ghidra' && currentTask.runToken
      && cffVersion === `CffDeflatten@${CFF_DEFLATTEN_COMMIT}`
      && /^[a-f0-9]{64}$/.test(cffHash) && /^[a-f0-9]{64}$/.test(cffAuditHash)
      && cffArtifactId.startsWith(reipaPrefix) && cffAuditArtifactId.startsWith(reipaPrefix)) {
      const cffRelativePath = cffArtifactId.slice(reipaPrefix.length)
      const cffAuditRelativePath = cffAuditArtifactId.slice(reipaPrefix.length)
      if (/^alternates\/cffdeflatten\/[a-f0-9]{1,16}\.c$/.test(cffRelativePath)
        && cffAuditRelativePath === 'audit/cff-deflatten-patch.json') {
        try {
          const runRoot = await realpath(resolveDerivedArtifactPath(reipaPrefix.slice(0, -1)))
          const filePath = await realpath(resolveDerivedArtifactPath(cffArtifactId))
          const auditPath = await realpath(resolveDerivedArtifactPath(cffAuditArtifactId))
          if (inside(rootPath, runRoot) && inside(runRoot, filePath) && inside(runRoot, auditPath)) {
            const [info, auditInfo] = await Promise.all([stat(filePath), stat(auditPath)])
            if (info.isFile() && info.size > 0 && info.size <= MAX_SOURCE_BYTES
              && auditInfo.isFile() && auditInfo.size > 0 && auditInfo.size <= 8 * 1024 * 1024) {
              const [bytes, auditBytes] = await Promise.all([readFile(filePath), readFile(auditPath)])
              const outputHash = createHash('sha256').update(bytes).digest('hex')
              const auditHash = createHash('sha256').update(auditBytes).digest('hex')
              const audit = JSON.parse(auditBytes.toString('utf8')) as Record<string, unknown>
              const functions = Array.isArray(audit.functions) ? audit.functions : []
              const selectedVerifiedFunction = functions.some((value) => {
                const candidate = record(value)
                const entry = typeof candidate.entry === 'string' ? candidate.entry : ''
                const sameFunction = nativeIdentity
                  ? nativeFunctionIdentity(unit.artifactId!, entry) === nativeIdentity
                  : entry === selectedAddress || addressAliases.includes(entry)
                return sameFunction && typeof candidate.verify === 'string'
                  && candidate.verify.startsWith('OK (') && Number.isInteger(candidate.patches)
                  && Number(candidate.patches) > 0
              })
              if (outputHash === cffHash && auditHash === cffAuditHash
                && audit.tool === 'CffDeflatten' && selectedVerifiedFunction) {
                alternates.push({
                  id: `${unit.id}:cff-deflatten`,
                  providerId: 'reamon-ghidra-cff-deflatten',
                  providerName: 'CffDeflatten · emulation-verified control-flow cleanup',
                  version: cffVersion,
                  name: typeof attributes.qualifiedName === 'string' ? attributes.qualifiedName.slice(0, 500) : unitId,
                  language: 'C',
                  relativePath,
                  inputSha256: unit.artifact.sha256,
                  outputSha256: outputHash,
                  completedAt: currentTask.completedAt?.toISOString() || null,
                  source: bytes.toString('utf8'),
                })
              }
            }
          }
        } catch {
          // An invalid CffDeflatten artifact or audit must not prevent reviewing Ghidra output.
        }
      }
    }
    for (const row of rows) {
      if (!row.taskId || seenProviders.has(row.source)) continue
      if (alternates.length >= MAX_ALTERNATES) {
        truncated = true
        break
      }
      const task = row.task
      const candidate = record(row.attributes)
      const codeArtifactId = typeof candidate.codeArtifactId === 'string' ? candidate.codeArtifactId : ''
      const expectedHashValue = candidate.codeArtifactSha256 ?? candidate.decompiledSourceSha256
      const expectedHash = typeof expectedHashValue === 'string' ? expectedHashValue.toLowerCase() : ''
      const candidateRelativePath = typeof candidate.relativePath === 'string' ? candidate.relativePath : ''
      const candidateLanguage = typeof candidate.language === 'string' ? candidate.language : ''
      const candidateAddress = typeof candidate.address === 'string' ? candidate.address
        : typeof candidate.startAddress === 'string' ? candidate.startAddress : ''
      const sameNativeIdentity = Boolean(nativeIdentity && nativeFunctionIdentity(unit.artifactId!, candidateAddress) === nativeIdentity)
      const sameSourcePath = candidateRelativePath === relativePath && candidateLanguage === language
      const expectedPrefix = `${projectId}/${unit.artifactId}/${row.taskId}/${task?.runToken || ''}/`
      const sourceRelativePath = codeArtifactId.startsWith(expectedPrefix) ? codeArtifactId.slice(expectedPrefix.length) : ''
      if (!task?.runToken || task.provider?.pluginId !== row.source || !codeArtifactId.startsWith(expectedPrefix)
        || !sourceRelativePath || (!sameSourcePath && !sameNativeIdentity)
        || !candidateRelativePath
        || (sourceRelativePath !== candidateRelativePath && !sourceRelativePath.endsWith(`/${candidateRelativePath}`))
        || sourceRelativePath.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
        || !/^[a-f0-9]{64}$/.test(expectedHash)) continue
      try {
        const runRoot = await realpath(resolveDerivedArtifactPath(expectedPrefix.slice(0, -1)))
        const filePath = await realpath(resolveDerivedArtifactPath(codeArtifactId))
        if (!inside(rootPath, runRoot) || !inside(runRoot, filePath)) continue
        const info = await stat(filePath)
        if (!info.isFile() || info.size <= 0 || info.size > MAX_SOURCE_BYTES) continue
        const bytes = await readFile(filePath)
        const outputHash = createHash('sha256').update(bytes).digest('hex')
        if (outputHash !== expectedHash) continue
        seenProviders.add(row.source)
        alternates.push({
          id: row.id,
          providerId: row.source,
          providerName: row.source.replace(/^reamon-/, ''),
          version: typeof candidate.decompilerVersion === 'string' ? candidate.decompilerVersion.slice(0, 120)
            : typeof candidate.decompilationEngineVersion === 'string' ? candidate.decompilationEngineVersion.slice(0, 120) : null,
          name: typeof candidate.qualifiedName === 'string' ? candidate.qualifiedName.slice(0, 500) : row.label,
          language: candidateLanguage || language,
          relativePath: candidateRelativePath || sourceRelativePath,
          inputSha256: unit.artifact.sha256,
          outputSha256: outputHash,
          completedAt: task.completedAt?.toISOString() || null,
          source: bytes.toString('utf8'),
        })
      } catch {
        // An unavailable alternate must not prevent reviewing the selected output.
      }
    }

    return NextResponse.json({ alternates, truncated }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to load alternate decompiler outputs:', error)
    return NextResponse.json({ error: 'Failed to load alternate decompiler outputs' }, { status: 500, headers: NO_STORE })
  }
}
