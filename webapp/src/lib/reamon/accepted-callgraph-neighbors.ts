import prisma from '@/lib/prisma'

const MAX_ANCHOR_MATCHES = 500
const MAX_CALL_EDGES = 4_000
const CALL_GRAPH_PROVIDERS = new Set(['reamon-ghidra', 'reamon-kuna'])

export interface CallGraphNeighborCandidate {
  id: string
  taskId: string | null
  artifactId: string | null
  artifactSha256: string | null
  source: string
  stableKey: string
}

export interface CallGraphNeighborSupport {
  acceptedMatchCount: number
  relations: Array<'caller' | 'callee'>
}

export async function loadAcceptedCallGraphNeighborSupport(input: {
  projectId: string
  focus: CallGraphNeighborCandidate
  candidates: CallGraphNeighborCandidate[]
}): Promise<{ byCandidateId: Map<string, CallGraphNeighborSupport>; truncated: boolean }> {
  if (!CALL_GRAPH_PROVIDERS.has(input.focus.source)) return { byCandidateId: new Map(), truncated: false }
  const candidates = input.candidates.filter((candidate) =>
    candidate.taskId && candidate.artifactId && candidate.artifactSha256
    && CALL_GRAPH_PROVIDERS.has(candidate.source) && candidate.id !== input.focus.id)
  const candidateTaskIds = [...new Set(candidates.map((candidate) => candidate.taskId as string))]
  if (!input.focus.taskId || !input.focus.artifactId || !input.focus.artifactSha256 || !candidateTaskIds.length) {
    return { byCandidateId: new Map(), truncated: false }
  }

  const anchors = await prisma.reamonFunctionMatch.findMany({
    where: {
      projectId: input.projectId,
      OR: [
        { taskAId: input.focus.taskId, taskBId: { in: candidateTaskIds } },
        { taskBId: input.focus.taskId, taskAId: { in: candidateTaskIds } },
      ],
      reviews: { some: { decision: 'ACCEPTED' } },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_ANCHOR_MATCHES + 1,
    include: { reviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  if (anchors.length > MAX_ANCHOR_MATCHES) return { byCandidateId: new Map(), truncated: true }

  const focusGroup = groupKey(input.focus)
  const edgeGroups = new Map<string, { candidate: CallGraphNeighborCandidate; keys: Set<string> }>()
  const linksByCandidate = new Map<string, Array<{
    id: string
    focusAnchorKey: string
    candidateAnchorKey: string
  }>>()
  const addKeys = (candidate: CallGraphNeighborCandidate, keys: string[]) => {
    const key = groupKey(candidate)
    if (!key) return
    const group = edgeGroups.get(key) || { candidate, keys: new Set<string>() }
    for (const value of keys) if (value) group.keys.add(value)
    edgeGroups.set(key, group)
  }
  addKeys(input.focus, [input.focus.stableKey])

  for (const candidate of candidates) {
    if (!candidate.taskId || !candidate.artifactId || !candidate.artifactSha256) continue
    const candidateLinks = linksByCandidate.get(candidate.id) || []
    for (const anchor of anchors) {
      if (anchor.reviews[0]?.decision !== 'ACCEPTED') continue
      const forward = anchor.taskAId === input.focus.taskId && anchor.taskBId === candidate.taskId
        && anchor.artifactAId === input.focus.artifactId && anchor.artifactBId === candidate.artifactId
        && anchor.artifactASha256 === input.focus.artifactSha256 && anchor.artifactBSha256 === candidate.artifactSha256
        && anchor.providerAId === input.focus.source && anchor.providerBId === candidate.source
      const reverse = anchor.taskBId === input.focus.taskId && anchor.taskAId === candidate.taskId
        && anchor.artifactBId === input.focus.artifactId && anchor.artifactAId === candidate.artifactId
        && anchor.artifactBSha256 === input.focus.artifactSha256 && anchor.artifactASha256 === candidate.artifactSha256
        && anchor.providerBId === input.focus.source && anchor.providerAId === candidate.source
      if (!forward && !reverse) continue
      const focusAnchorKey = forward ? anchor.functionAStableKey : anchor.functionBStableKey
      const candidateAnchorKey = forward ? anchor.functionBStableKey : anchor.functionAStableKey
      candidateLinks.push({ id: anchor.id, focusAnchorKey, candidateAnchorKey })
      addKeys(input.focus, [focusAnchorKey])
      addKeys(candidate, [candidate.stableKey, candidateAnchorKey])
    }
    if (candidateLinks.length) linksByCandidate.set(candidate.id, candidateLinks)
  }

  if (!linksByCandidate.size) return { byCandidateId: new Map(), truncated: false }

  const edgeGroupsForQuery = [...edgeGroups.values()].flatMap(({ candidate, keys }) => {
    if (!candidate.taskId || !candidate.artifactId || !keys.size) return []
    const keyList = [...keys]
    return [{
      artifactId: candidate.artifactId,
      taskId: candidate.taskId,
      source: candidate.source,
      OR: [{ fromKey: { in: keyList } }, { toKey: { in: keyList } }],
    }]
  })
  const edges = await prisma.reamonObservation.findMany({
    where: { projectId: input.projectId, kind: 'relationship', type: 'calls', OR: edgeGroupsForQuery },
    select: { artifactId: true, taskId: true, source: true, fromKey: true, toKey: true },
    orderBy: { stableKey: 'asc' },
    take: MAX_CALL_EDGES + 1,
  })
  if (edges.length > MAX_CALL_EDGES) return { byCandidateId: new Map(), truncated: true }

  const edgesByGroup = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (!edge.artifactId || !edge.taskId || !edge.fromKey || !edge.toKey) continue
    const key = `${edge.artifactId}\u0000${edge.taskId}\u0000${edge.source}`
    const group = edgesByGroup.get(key) || new Set<string>()
    group.add(`${edge.fromKey}\u0000${edge.toKey}`)
    edgesByGroup.set(key, group)
  }

  const focusEdges = edgesByGroup.get(focusGroup) || new Set<string>()
  const byCandidateId = new Map<string, CallGraphNeighborSupport>()
  for (const candidate of candidates) {
    const links = linksByCandidate.get(candidate.id)
    if (!links?.length) continue
    const candidateEdges = edgesByGroup.get(groupKey(candidate)) || new Set<string>()
    const supportedAnchors = new Set<string>()
    const relations = new Set<'caller' | 'callee'>()
    for (const link of links) {
      const focusCallsAnchor = focusEdges.has(`${input.focus.stableKey}\u0000${link.focusAnchorKey}`)
      const anchorCallsFocus = focusEdges.has(`${link.focusAnchorKey}\u0000${input.focus.stableKey}`)
      const candidateCallsAnchor = candidateEdges.has(`${candidate.stableKey}\u0000${link.candidateAnchorKey}`)
      const anchorCallsCandidate = candidateEdges.has(`${link.candidateAnchorKey}\u0000${candidate.stableKey}`)
      if (focusCallsAnchor && candidateCallsAnchor) {
        supportedAnchors.add(link.id)
        relations.add('callee')
      }
      if (anchorCallsFocus && anchorCallsCandidate) {
        supportedAnchors.add(link.id)
        relations.add('caller')
      }
    }
    if (supportedAnchors.size) byCandidateId.set(candidate.id, {
      acceptedMatchCount: supportedAnchors.size,
      relations: [...relations],
    })
  }
  return { byCandidateId, truncated: false }
}

function groupKey(candidate: CallGraphNeighborCandidate): string {
  return `${candidate.artifactId || ''}\u0000${candidate.taskId || ''}\u0000${candidate.source}`
}
