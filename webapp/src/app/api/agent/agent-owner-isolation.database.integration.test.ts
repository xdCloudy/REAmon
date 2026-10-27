/** @vitest-environment node */
/** Opt-in PostgreSQL acceptance for owner isolation at sensitive agent proxies. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import prisma from '@/lib/prisma'

const mocks = vi.hoisted(() => ({ getEffectiveUser: vi.fn(), agentFetch: vi.fn() }))

vi.mock('@/lib/session', () => ({ getEffectiveUser: mocks.getEffectiveUser }))
vi.mock('@/lib/agentFetch', () => ({ agentFetch: mocks.agentFetch }))

import { GET as listWorkspaceJobs } from './workspace/jobs/route'
import { POST as cancelWorkspaceJob } from './workspace/jobs/[jobId]/cancel/route'
import { GET as listSessions } from './sessions/route'

const enabled = process.env.REAMON_AGENT_OWNER_ISOLATION_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL)
let projectId = ''
let ownerId = ''
const nonOwnerId = `non-owner-${randomUUID()}`

function projectParams() { return { params: Promise.resolve({ id: projectId }) } }
function jobsRequest() { return new NextRequest(`http://localhost/api/agent/workspace/jobs?projectId=${projectId}`) }
function cancelRequest() { return new NextRequest(`http://localhost/api/agent/workspace/jobs/job-1/cancel?projectId=${projectId}`, { method: 'POST' }) }
function sessionRequest() { return new NextRequest(`http://localhost/api/agent/sessions?projectId=${projectId}`) }

describe.skipIf(!enabled)('Agent workspace and session owner isolation against PostgreSQL', () => {
  beforeAll(async () => {
    const user = await prisma.user.findFirst({ select: { id: true } })
    if (!user) throw new Error('Agent owner-isolation integration requires an existing database user')
    ownerId = user.id
    const project = await prisma.project.create({
      data: { userId: ownerId, name: `AgentOwnerIsolation-${randomUUID()}`, projectKind: 'REVERSE_ENGINEERING' },
      select: { id: true },
    })
    projectId = project.id
  })

  beforeEach(() => {
    mocks.agentFetch.mockReset().mockImplementation(async () => Response.json({ jobs: [], sessions: [] }))
  })
  afterEach(() => vi.unstubAllEnvs())

  afterAll(async () => {
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId, userId: ownerId } })
    await prisma.$disconnect()
  })

  it('allows the owner to reach the project-scoped job and session APIs', async () => {
    mocks.getEffectiveUser.mockResolvedValue({ userId: ownerId })
    const jobs = await listWorkspaceJobs(jobsRequest())
    const sessions = await listSessions(sessionRequest())

    expect(jobs.status).toBe(200)
    expect(sessions.status).toBe(200)
    expect(mocks.agentFetch).toHaveBeenNthCalledWith(1, `/workspace/jobs?projectId=${projectId}`, { cache: 'no-store' })
    expect(mocks.agentFetch).toHaveBeenNthCalledWith(2, `/sessions?project_id=${projectId}`, { cache: 'no-store' })
  })

  it('hides another owner’s job list, cancellation, and sessions without proxying', async () => {
    vi.stubEnv('ACCESS_ENFORCE', '0')
    mocks.getEffectiveUser.mockResolvedValue({ userId: nonOwnerId })
    const jobs = await listWorkspaceJobs(jobsRequest())
    const cancel = await cancelWorkspaceJob(cancelRequest(), { params: Promise.resolve({ jobId: 'job-1' }) })
    const sessions = await listSessions(sessionRequest())

    expect(jobs.status).toBe(404)
    expect(cancel.status).toBe(404)
    expect(sessions.status).toBe(404)
    for (const response of [jobs, cancel, sessions]) expect(await response.json()).toEqual({ error: 'Not found' })
    expect(mocks.agentFetch).not.toHaveBeenCalled()
  })
})
