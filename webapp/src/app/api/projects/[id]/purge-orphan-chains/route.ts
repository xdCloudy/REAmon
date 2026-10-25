import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getGraphSession } from '../../../graph/neo4j'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { agentFetch } from '@/lib/agentFetch'

// POST /api/projects/[id]/purge-orphan-chains
//
// Graph reconcile: delete Neo4j AttackChain subgraphs for this project whose
// chain_id has NO matching Postgres conversation (session_id). These orphans
// appear when a conversation was deleted while its agent loop was still running
// (the loop re-seeded the chain after the delete) or after an import. Each
// orphan's agent task is stopped first so it cannot immediately re-seed.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params

    // Ownership: this stops the project's agent tasks and DETACH-DELETEs graph
    // nodes, so only the effective owner may invoke it.
    const eff = await requireEffectiveUser()
    if (eff instanceof NextResponse) return eff
    const access = await requireProjectAccess(eff, projectId)
    if (access instanceof NextResponse) return access

    // Live conversations for this project = the session_ids that must be KEPT.
    const conversations = await prisma.conversation.findMany({
      where: { projectId },
      select: { sessionId: true },
    })
    const liveSessionIds = new Set(conversations.map(c => c.sessionId))

    const neo4jSession = getGraphSession()
    let purged = 0
    const stopped: string[] = []
    try {
      // All attack chains in Neo4j for this project.
      const res = await neo4jSession.run(
        `MATCH (ac:AttackChain { project_id: $projectId })
         RETURN ac.chain_id AS chainId, ac.user_id AS userId`,
        { projectId }
      )
      const orphans = res.records
        .map(r => ({ chainId: r.get('chainId') as string, userId: r.get('userId') as string }))
        .filter(c => c.chainId && !liveSessionIds.has(c.chainId))

      // Stop each orphan's running agent task (best-effort) so it can't re-seed.
      for (const orphan of orphans) {
        try {
          await agentFetch('/agent-session/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: orphan.userId, project_id: projectId, session_id: orphan.chainId }),
          })
          stopped.push(orphan.chainId)
        } catch (e) {
          console.error(`Failed to stop orphan session ${orphan.chainId} (continuing):`, e)
        }
      }

      // DETACH DELETE the orphan chain subgraphs.
      for (const orphan of orphans) {
        await neo4jSession.run(
          `MATCH (n)
           WHERE n.chain_id = $chainId AND n.project_id = $projectId
             AND (n:AttackChain OR n:ChainStep OR n:ChainFinding OR n:ChainDecision OR n:ChainFailure)
           DETACH DELETE n`,
          { chainId: orphan.chainId, projectId }
        )
        purged++
      }
    } finally {
      await neo4jSession.close()
    }

    return NextResponse.json({ purged, stopped })
  } catch (error) {
    console.error('Failed to purge orphan chains:', error)
    return NextResponse.json({ error: 'Failed to purge orphan chains' }, { status: 500 })
  }
}
