import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { instructionSequenceFamily, instructionSequencesAreCompatible, parseControlFlowGraph, parseControlFlowMetrics, scoreInstructionFunctionPair, type SimilarInstructionFunction } from '@/lib/reamon/instruction-similarity'
import { nativeArchitectureGroup } from '@/lib/reamon/native-function-identity'

interface RouteParams { params: Promise<{ id: string }> }
const NO_STORE = { 'Cache-Control': 'private, no-store' }
const NATIVE_PROVIDERS = new Set(['reamon-ghidra', 'reamon-ida', 'reamon-kuna', 'reamon-miasm', 'reamon-reko', 'reamon-retdec'])
const BYTECODE_MATCH_PROVIDERS: Record<string, ReadonlySet<string>> = {
  'bytecode:dex': new Set(['reamon-dex-decompiler', 'reamon-jadx']),
  'bytecode:dotnet-il': new Set(['reamon-ilspy']),
  'bytecode:wasm': new Set(['reamon-wabt']),
  'bytecode:luajit': new Set(['reamon-unluac-rs']),
  'bytecode:luau': new Set(['reamon-unluac-rs']),
  'bytecode:lua51': new Set(['reamon-unluac-rs']),
  'bytecode:lua52': new Set(['reamon-unluac-rs']),
  'bytecode:lua53': new Set(['reamon-unluac-rs']),
  'bytecode:lua54': new Set(['reamon-unluac-rs']),
  'bytecode:lua55': new Set(['reamon-unluac-rs']),
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function endianness(attributes: Record<string, unknown>): 'little' | 'big' | null {
  for (const key of ['instructionArchitecture', 'architecture', 'endianness', 'byteOrder']) {
    const value = attributes[key]
    if (typeof value !== 'string') continue
    const normalized = value.trim().toLowerCase()
    if (normalized.includes('little') || /(?:^|[:/_-])le(?:[:/_-]|$)/.test(normalized)) return 'little'
    if (normalized.includes('big') || /(?:^|[:/_-])be(?:[:/_-]|$)/.test(normalized)) return 'big'
  }
  return null
}

function feature(row: { id: string; label: string | null; attributes: unknown }): SimilarInstructionFunction | null {
  const attributes = record(row.attributes)
  const raw = attributes.instructionMnemonics
  let parsed = raw
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) as unknown } catch { return null }
  }
  if (!Array.isArray(parsed)) return null
  const mnemonics = parsed.slice(0, 800).filter((item): item is string =>
    typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_./-]{0,31}$/.test(item)).map((item) => item.toLowerCase())
  return {
    key: row.id,
    name: typeof attributes.qualifiedName === 'string' ? attributes.qualifiedName : row.label || 'Unknown function',
    address: typeof attributes.address === 'string' ? attributes.address : null,
    mnemonics,
    controlFlowMetrics: parseControlFlowMetrics(attributes.controlFlowMetrics),
    controlFlowGraph: parseControlFlowGraph(attributes.controlFlowGraph, attributes.cfgTruncated),
  }
}

function featureSnapshot(value: SimilarInstructionFunction) {
  const snapshot = {
    version: 'reamon-instruction-cfg-wl-v4',
    mnemonics: value.mnemonics,
    controlFlowMetrics: value.controlFlowMetrics || null,
    controlFlowGraph: value.controlFlowGraph || null,
  }
  return { ...snapshot, sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') }
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access
    const search = new URL(request.url).searchParams
    const taskId = search.get('taskId')?.trim()
    const functionId = search.get('functionId')?.trim()
    const matches = await prisma.reamonFunctionMatch.findMany({
      where: {
        projectId,
        AND: [
          ...(taskId ? [{ OR: [{ taskAId: taskId }, { taskBId: taskId }] }] : []),
          ...(functionId ? [{ OR: [{ functionAObservationId: functionId }, { functionBObservationId: functionId }] }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { reviews: { orderBy: { createdAt: 'desc' }, take: 10 } },
    })
    return NextResponse.json({ matches }, { headers: NO_STORE })
  } catch (error) {
    console.error('Could not load saved function matches:', error)
    return NextResponse.json({ error: 'Could not load saved function comparisons' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access
    const body = await request.json() as Record<string, unknown>
    const taskAId = typeof body.taskAId === 'string' ? body.taskAId.trim() : ''
    const functionAId = typeof body.functionAId === 'string' ? body.functionAId.trim() : ''
    const taskBId = typeof body.taskBId === 'string' ? body.taskBId.trim() : ''
    const functionBId = typeof body.functionBId === 'string' ? body.functionBId.trim() : ''
    if ([taskAId, functionAId, taskBId, functionBId].some((value) => !value || value.length > 128) || taskAId === taskBId) {
      return NextResponse.json({ error: 'Choose functions from two completed analysis runs.' }, { status: 400, headers: NO_STORE })
    }
    const [taskA, taskB] = await Promise.all([taskAId, taskBId].map((id) => prisma.task.findFirst({
      where: { id, projectId, status: 'COMPLETED', capability: { in: ['decompile', 'disassemble'] } },
      select: {
        id: true, artifactId: true,
        provider: { select: { pluginId: true, version: true } },
        artifact: { select: { id: true, sha256: true, originalName: true, profile: true } },
      },
    })))
    if (!taskA?.artifact || !taskB?.artifact || !taskA.provider || !taskB.provider) {
      return NextResponse.json({ error: 'Both functions must come from completed project analysis runs.' }, { status: 404, headers: NO_STORE })
    }
    const [functionA, functionB] = await Promise.all([
      prisma.reamonObservation.findFirst({ where: { projectId, taskId: taskAId, artifactId: taskA.artifactId, type: { in: ['code_unit', 'function'] }, OR: [{ id: functionAId }, { stableKey: functionAId }] }, select: { id: true, stableKey: true, label: true, attributes: true } }),
      prisma.reamonObservation.findFirst({ where: { projectId, taskId: taskBId, artifactId: taskB.artifactId, type: { in: ['code_unit', 'function'] }, OR: [{ id: functionBId }, { stableKey: functionBId }] }, select: { id: true, stableKey: true, label: true, attributes: true } }),
    ])
    if (!functionA || !functionB) return NextResponse.json({ error: 'A selected function no longer belongs to its recorded analysis run.' }, { status: 404, headers: NO_STORE })
    const featureA = feature(functionA)
    const featureB = feature(functionB)
    const attributesA = { ...record(taskA.artifact.profile), ...record(functionA.attributes) }
    const attributesB = { ...record(taskB.artifact.profile), ...record(functionB.attributes) }
    const identityA = { providerId: taskA.provider.pluginId, artifactId: taskA.artifactId, attributes: attributesA }
    const identityB = { providerId: taskB.provider.pluginId, artifactId: taskB.artifactId, attributes: attributesB }
    const familyA = instructionSequenceFamily(identityA)
    const familyB = instructionSequenceFamily(identityB)
    if (!featureA || !featureB || !instructionSequencesAreCompatible(identityA, identityB)) {
      return NextResponse.json({ error: 'These functions do not have compatible stored instruction evidence.' }, { status: 422, headers: NO_STORE })
    }
    const endianA = endianness(attributesA)
    const endianB = endianness(attributesB)
    let comparisonDomain: string | null = null
    if (familyA?.startsWith('native:')) {
      const architecture = nativeArchitectureGroup(attributesA)
      const architectureB = nativeArchitectureGroup(attributesB)
      if (NATIVE_PROVIDERS.has(taskA.provider.pluginId) && NATIVE_PROVIDERS.has(taskB.provider.pluginId)
          && architecture && architecture === architectureB && !(endianA && endianB && endianA !== endianB)) {
        comparisonDomain = `native:${architecture}:${endianA || endianB || 'endianness-unknown'}`
      }
    } else if (familyA && BYTECODE_MATCH_PROVIDERS[familyA]?.has(taskA.provider.pluginId)
        && BYTECODE_MATCH_PROVIDERS[familyA]?.has(taskB.provider.pluginId)) {
      comparisonDomain = familyA
    }
    if (!comparisonDomain) {
      return NextResponse.json({ error: 'These runs do not share a supported native architecture or bytecode instruction family.' }, { status: 422, headers: NO_STORE })
    }
    const score = scoreInstructionFunctionPair(featureA, featureB)
    if (!score || score.similarity < 0.6) return NextResponse.json({ error: 'The functions do not meet the matcher’s candidate threshold.' }, { status: 422, headers: NO_STORE })
    const existing = await prisma.reamonFunctionMatch.findFirst({
      where: {
        projectId,
        matcher: 'reamon-instruction-cfg-wl',
        matcherVersion: '4',
        OR: [
          { taskAId, taskBId, functionAStableKey: functionA.stableKey, functionBStableKey: functionB.stableKey },
          { taskAId: taskBId, taskBId: taskAId, functionAStableKey: functionB.stableKey, functionBStableKey: functionA.stableKey },
        ],
      },
      include: { reviews: { orderBy: { createdAt: 'desc' }, take: 10 } },
    })
    if (existing) return NextResponse.json({ match: existing, reused: true }, { headers: NO_STORE })

    const match = await prisma.reamonFunctionMatch.create({
      data: {
        projectId,
        artifactAId: taskA.artifact.id, artifactASha256: taskA.artifact.sha256, artifactAName: taskA.artifact.originalName,
        taskAId, providerAId: taskA.provider.pluginId, providerAVersion: taskA.provider.version,
        functionAObservationId: functionA.id, functionAStableKey: functionA.stableKey,
        functionAName: featureA.name, functionAAddress: featureA.address, functionAFeatures: featureSnapshot(featureA) as unknown as Prisma.InputJsonValue,
        artifactBId: taskB.artifact.id, artifactBSha256: taskB.artifact.sha256, artifactBName: taskB.artifact.originalName,
        taskBId, providerBId: taskB.provider.pluginId, providerBVersion: taskB.provider.version,
        functionBObservationId: functionB.id, functionBStableKey: functionB.stableKey,
        functionBName: featureB.name, functionBAddress: featureB.address, functionBFeatures: featureSnapshot(featureB) as unknown as Prisma.InputJsonValue,
        architecture: comparisonDomain,
        matcher: 'reamon-instruction-cfg-wl',
        matcherVersion: '4',
        similarity: Math.round(score.similarity * 100),
        instructionSimilarity: Math.round(score.instructionSimilarity * 100),
        controlFlowSimilarity: score.controlFlowSimilarity === null ? null : Math.round(score.controlFlowSimilarity * 100),
        controlFlowTopologySimilarity: score.controlFlowTopologySimilarity === null ? null : Math.round(score.controlFlowTopologySimilarity * 100),
      },
      include: { reviews: true },
    })
    return NextResponse.json({ match, reused: false }, { status: 201, headers: NO_STORE })
  } catch (error) {
    console.error('Could not persist function match:', error)
    return NextResponse.json({ error: 'Could not save this function comparison' }, { status: 500, headers: NO_STORE })
  }
}
