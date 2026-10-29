import { NextRequest, NextResponse } from 'next/server'
import { getEffectiveUser, getSession } from '@/lib/session'
import { requireProjectAccessStrict } from '@/lib/access'
import { createWsTicket } from '@/lib/auth'
import { assertGraphNotActivating } from '@/lib/activationLock'

// POST /api/agent/ws-ticket
//
// STRIDE S6: mints a short-lived ticket the browser includes in the /ws/agent
// init frame so the agent can authenticate the WebSocket. The ticket binds the
// EFFECTIVE user (getEffectiveUser) - a standard user's own id, or, when an admin
// is simulating user X, X - never a body-supplied or x-user-id value. So the agent
// acts as the impersonated user (fetches X's keys, tags the graph as X), and an
// admin can only mint a ticket for a project the simulated user owns. An
// internal-key caller has no cookie and cannot mint a ticket for anyone.
export async function POST(request: NextRequest) {
  const eff = await getEffectiveUser()
  if (!eff) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const projectId = String(body.projectId ?? body.project_id ?? '')
  const sessionId = String(body.sessionId ?? body.session_id ?? '')
  if (!projectId || !sessionId) {
    return NextResponse.json(
      { error: 'projectId and sessionId are required' },
      { status: 400 }
    )
  }

  // This ticket is a credential for direct access to the agent, so its project
  // scope must remain strict even while REST ownership checks are in log-only mode.
  const access = await requireProjectAccessStrict(eff, projectId)
  if (access instanceof NextResponse) return access

  // Scan Timeline 4A.3: the ticket is the chokepoint for starting an agent
  // session. Refuse to mint one while the project's live graph is being swapped -
  // the agent reasons over that graph, so it must not attach mid-swap.
  const activating = await assertGraphNotActivating(projectId)
  if (activating) return activating

  // If the signing secret is unavailable this returns null; the agent rejects
  // the later WebSocket handshake (fail-closed), so the UI reports auth failure.
  const actor = await realActorOf()
  const ticket = actor && actor !== eff.userId
    ? await createWsTicket(eff.userId, projectId, sessionId, actor)
    : await createWsTicket(eff.userId, projectId, sessionId)
  return NextResponse.json({ ticket })
}

/** The signed-in person, which differs from the effective user while an admin simulates. */
async function realActorOf(): Promise<string | undefined> {
  try {
    return (await getSession())?.userId
  } catch {
    return undefined
  }
}
