/**
 * Report narratives run on the caller's own "Report narratives" model. The
 * route used to call the agent with a plain `fetch` and no internal key, and
 * to swallow every non-OK answer into "a report without narratives". Now only
 * an agent that cannot be reached falls back; a model, key or version problem
 * reaches the person.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockSettings = vi.fn()
const mockCreate = vi.fn()
const mockAgentFetch = vi.fn()
const mockGather = vi.fn()
const mockHtml = vi.fn()

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: async () => ({ userId: 'alice' }),
  requireProjectAccessStrict: async () => ({ id: 'p1', userId: 'alice' }),
}))
vi.mock('@/lib/prisma', () => ({
  default: {
    userSettings: { findUnique: (...a: unknown[]) => mockSettings(...a) },
    report: { create: (...a: unknown[]) => mockCreate(...a) },
  },
}))
vi.mock('@/lib/agentFetch', () => {
  class AgentUnreachableError extends Error {
    cause_: unknown
    constructor(cause: unknown) { super('down'); this.cause_ = cause }
  }
  return { agentFetch: (...a: unknown[]) => mockAgentFetch(...a), AgentUnreachableError }
})
vi.mock('@/lib/report/reportData', () => ({ gatherReportData: (...a: unknown[]) => mockGather(...a) }))
vi.mock('@/lib/report/reportTemplate', () => ({ generateReportHtml: (...a: unknown[]) => mockHtml(...a) }))
vi.mock('fs', () => ({ writeFileSync: vi.fn(), mkdirSync: vi.fn(), existsSync: () => true }))

import { POST } from './route'
import { AgentUnreachableError } from '@/lib/agentFetch'

const params = { params: Promise.resolve({ id: 'p1' }) }
const req = () => new NextRequest('http://x/api/projects/p1/reports', { method: 'POST' })

function reportData() {
  const empty = new Proxy({}, { get: () => [] })
  return {
    project: { name: 'Proj', targetDomain: 'example.com' },
    metrics: { riskScore: 1, riskLabel: 'low' },
    graphOverview: empty, attackSurface: empty,
    vulnerabilities: { findings: [] }, cveIntelligence: { cveChains: [], exploits: [], githubSecrets: [] },
    attackChains: { chains: [], exploitSuccesses: [] }, remediations: [],
    trufflehog: { findings: [] }, secrets: {}, jsRecon: { findings: [] },
    supplyChain: { findings: [] }, graphqlScan: { findings: [] }, vhostSni: { findings: [] },
    tlsx: { findings: [], topIssuers: [] }, webCachePoison: { findings: [] },
    aiSurface: { findings: [], attackFindings: [] }, otx: { pulses: [] },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettings.mockResolvedValue({ featureModels: { report_narratives: 'gpt-5' } })
  mockGather.mockResolvedValue(reportData())
  mockHtml.mockReturnValue('<html></html>')
  mockCreate.mockImplementation(async ({ data }) => ({ id: 'r1', ...data }))
  mockAgentFetch.mockResolvedValue(new Response(JSON.stringify({
    executiveSummary: 'ok', model_used: 'gpt-5',
  }), { status: 200 }))
})

describe('report narratives', () => {
  test('no saved model is model_required before any data is gathered', async () => {
    mockSettings.mockResolvedValue(null)
    const res = await POST(req(), params)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('model_required')
    expect(mockGather).not.toHaveBeenCalled()
  })

  test('the model and the caller go to the agent through agentFetch', async () => {
    const res = await POST(req(), params)
    expect(res.status).toBe(201)
    expect(mockAgentFetch.mock.calls[0][0]).toBe('/api/report/summarize')
    const sent = JSON.parse((mockAgentFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(sent).toMatchObject({ model: 'gpt-5', user_id: 'alice' })
    const narratives = mockHtml.mock.calls[0][1]
    expect(narratives).toEqual({ executiveSummary: 'ok' })
  })

  test('an unreachable agent still produces a report without narratives', async () => {
    mockAgentFetch.mockRejectedValue(new AgentUnreachableError(new Error('ECONNREFUSED')))
    const res = await POST(req(), params)
    expect(res.status).toBe(201)
    expect(mockHtml.mock.calls[0][1]).toBeNull()
    expect(mockCreate.mock.calls[0][0].data.hasNarratives).toBe(false)
  })

  test('model_unavailable is shown, not swallowed', async () => {
    mockAgentFetch.mockResolvedValue(new Response(JSON.stringify({
      code: 'model_unavailable', error: 'x', model_used: 'gpt-5',
    }), { status: 503 }))
    const res = await POST(req(), params)
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('model_unavailable')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('an outdated agent is shown, not swallowed', async () => {
    mockAgentFetch.mockResolvedValue(new Response(JSON.stringify({ executiveSummary: 'x' }), { status: 200 }))
    const res = await POST(req(), params)
    expect((await res.json()).code).toBe('agent_outdated')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test('a 4xx is shown, not swallowed', async () => {
    mockAgentFetch.mockResolvedValue(new Response(JSON.stringify({
      error: 'user_id is required', model_used: 'gpt-5',
    }), { status: 400 }))
    const res = await POST(req(), params)
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
