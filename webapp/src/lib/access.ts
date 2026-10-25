import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { getEffectiveUser, EffectiveUser } from './session'

/**
 * Per-user authorization guards (BOLA remediation).
 *
 * Every data route must scope reads/writes to the caller's EFFECTIVE user
 * (see getEffectiveUser): a standard user to their own id, an admin to their own
 * id unless they are simulating another user. These helpers turn "which user is
 * this?" (identity) into "may this user touch this resource?" (authorization).
 *
 * Rollout: ownership is ENFORCED by default (fail closed). An operator who wants
 * to observe first can set ACCESS_ENFORCE=0 (or false) to run a log-only phase -
 * violations are then logged with a `[BOLA]` marker and allowed. Genuinely missing
 * resources (404) and unauthenticated callers (401) are always hard.
 *
 * Anti-enumeration: a cross-user resource is reported as 404 (not 403) so the
 * distinction "exists but not yours" vs "does not exist" cannot be used to
 * enumerate other users' project/conversation ids (repo convention).
 *
 * Secret-exposure routes (A2) use requireUserAccess, which enforces immediately.
 */

export function accessEnforced(): boolean {
  const v = process.env.ACCESS_ENFORCE
  // Enforce by default; only an explicit opt-out disables it.
  return !(v === '0' || v === 'false')
}

/**
 * Cross-user ownership-violation response. Returns a 404 (anti-enumeration) when
 * enforcing; otherwise logs `[BOLA]` and returns null (allow, opt-in log-only).
 */
function ownershipDenied(reason: string, detail: Record<string, unknown>): NextResponse | null {
  if (accessEnforced()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  console.warn(`[BOLA] would-block: ${reason}`, JSON.stringify(detail))
  return null
}

/** Resolve the effective user, or a 401 NextResponse the caller must return. */
export async function requireEffectiveUser(): Promise<EffectiveUser | NextResponse> {
  const eff = await getEffectiveUser()
  if (!eff) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return eff
}

/**
 * Immediate (non-log-only) owner check. Use where a violation must always block -
 * notably the secret-exposure routes (A2). Returns 403 unless eff owns ownerId.
 */
export function assertOwnerStrict(eff: EffectiveUser, ownerId: string): NextResponse | null {
  if (eff.userId === ownerId) return null
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

/** Log-only-aware owner check for the bulk BOLA rollout. */
export function assertOwner(eff: EffectiveUser, ownerId: string): NextResponse | null {
  if (eff.userId === ownerId) return null
  return ownershipDenied('owner mismatch', { ownerId, eff: eff.userId })
}

/** Prisma where-fragment scoping a list query to the effective user. */
export function ownerScope(eff: EffectiveUser): { userId: string } {
  return { userId: eff.userId }
}

/**
 * One-call guard for project-scoped routes: resolve the effective user and verify
 * they own `projectId`. Returns a 401/404 NextResponse to return, or null when
 * access is allowed. Convenience wrapper over requireEffectiveUser +
 * requireProjectAccess for the many scan/analytics `[projectId]` routes.
 */
export async function guardProject(projectId: string): Promise<NextResponse | null> {
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  const access = await requireProjectAccess(eff, projectId)
  if (access instanceof NextResponse) return access
  return null
}

/** Project guard for sensitive data and file controls that must always block cross-user access. */
export async function guardProjectStrict(projectId: string): Promise<NextResponse | null> {
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  const access = await requireProjectAccessStrict(eff, projectId)
  if (access instanceof NextResponse) return access
  return null
}

/**
 * Load a Project and verify the effective user owns it. 404 when the project does
 * not exist (always hard); ownership violation is log-only-aware. On success (or
 * during the log-only phase) returns the project's id + owner.
 */
export async function requireProjectAccess(
  eff: EffectiveUser,
  projectId: string
): Promise<{ project: { id: string; userId: string } } | NextResponse> {
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  })
  if (!project) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (project.userId !== eff.userId) {
    const denied = ownershipDenied('project owner mismatch', {
      projectId,
      owner: project.userId,
      eff: eff.userId,
    })
    if (denied) return denied
  }
  return { project }
}

/** Project access check that cannot be relaxed by the rollout's log-only setting. */
export async function requireProjectAccessStrict(
  eff: EffectiveUser,
  projectId: string
): Promise<{ project: { id: string; userId: string } } | NextResponse> {
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  })
  if (!project || project.userId !== eff.userId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return { project }
}

/**
 * Guard a resource that is owned via its parent Project (Report, Remediation,
 * GraphView, ...). `loadProjectId` returns the resource's projectId (or null when
 * the resource does not exist). Verifies the effective user owns that project.
 */
export async function requireProjectScopedResource(
  eff: EffectiveUser,
  loadProjectId: () => Promise<string | null | undefined>,
): Promise<{ ok: true } | NextResponse> {
  const projectId = await loadProjectId()
  if (!projectId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const access = await requireProjectAccess(eff, projectId)
  if (access instanceof NextResponse) return access
  return { ok: true }
}

/**
 * Load a Conversation (which carries a direct userId) and verify ownership.
 * 404 when absent; ownership is log-only-aware.
 */
export async function requireConversationAccess(
  eff: EffectiveUser,
  conversationId: string
): Promise<{ conversation: { id: string; userId: string; projectId: string } } | NextResponse> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, projectId: true },
  })
  if (!conversation) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (conversation.userId !== eff.userId) {
    const denied = ownershipDenied('conversation owner mismatch', {
      conversationId,
      owner: conversation.userId,
      eff: eff.userId,
    })
    if (denied) return denied
  }
  return { conversation }
}

/**
 * Load a Conversation by its (unique) sessionId and verify ownership. Used by the
 * by-session/* routes. 404 when absent; ownership is log-only-aware.
 */
export async function requireConversationAccessBySession(
  eff: EffectiveUser,
  sessionId: string
): Promise<{ conversation: { id: string; userId: string; projectId: string } } | NextResponse> {
  const conversation = await prisma.conversation.findUnique({
    where: { sessionId },
    select: { id: true, userId: true, projectId: true },
  })
  if (!conversation) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (conversation.userId !== eff.userId) {
    const denied = ownershipDenied('conversation owner mismatch', {
      sessionId,
      owner: conversation.userId,
      eff: eff.userId,
    })
    if (denied) return denied
  }
  return { conversation }
}
