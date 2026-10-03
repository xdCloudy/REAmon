/**
 * One pass over EVERY filterable page in the table dropdown.
 *
 * redZoneFilters.test.tsx pins the shared contract in depth on a single sheet.
 * This file is the breadth half: each table is mounted for real and driven
 * through the same four steps, because the integration is per-table (each one
 * hoists its own column list and picks its own persistence slug) and a
 * copy-paste slip in any single table is invisible to a shared-contract test.
 *
 * Per table:
 *   1. the Filters button is present
 *   2. its own columns are offered
 *   3. picking a value narrows the rows
 *   4. the change is saved under that table's own scope
 *
 * Run: npx vitest run src/app/graph/components/RedZoneTables/redZoneFiltersPerTable.test.tsx
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'

import { BlastRadiusTable } from './BlastRadiusTable'
import { DnsDriftTable } from './DnsDriftTable'
import { DnsEmailTable } from './DnsEmailTable'
import { GraphqlLedgerTable } from './GraphqlLedgerTable'
import { JsDepSignalsTable } from './JsDepSignalsTable'
import { KillChainTable } from './KillChainTable'
import { NetInitAccessTable } from './NetInitAccessTable'
import { ParamMatrixTable } from './ParamMatrixTable'
import { SecretsTable } from './SecretsTable'
import { SharedInfraTable } from './SharedInfraTable'
import { TakeoverTable } from './TakeoverTable'
import { ThreatIntelTable } from './ThreatIntelTable'
import { WebCachePoisonTable } from './WebCachePoisonTable'
import { WebInitAccessTable } from './WebInitAccessTable'
import { AiSurfaceTable, AiRiskTable } from './AiTables'
import { SupplyChainScaTable } from './SupplyChainScaTable'

const PROJECT = 'proj-1'

interface Case {
  /** Display name, and the test title. */
  name: string
  Component: (props: any) => any
  /** API slug the table requests. */
  endpoint: string
  /** Persistence scope the table must write under. */
  scope: string
  /** Column header as shown in the panel. */
  header: string
  /** Row key behind that header. */
  key: string
  /** Sheet name, for the tables that return `{ sheets: {...} }`. */
  sheet?: string
  /**
   * Fields the table dereferences without a null guard. Kept per-table and
   * deliberately minimal: what is under test is filtering, and padding every
   * fixture to a full row interface would hide which tables actually need it.
   */
  base?: Record<string, unknown>
}

/**
 * Two rows differing only in the column under test. Every other field is left
 * undefined on purpose: the cell renderers are null-safe, and a fixture that
 * mirrored each row interface would be re-derived from the source on every
 * schema change without testing anything more.
 */
function rowsFor(c: Case) {
  const base = c.base ?? {}
  return [
    { id: 'r1', ...base, [c.key]: 'alpha' },
    { id: 'r2', ...base, [c.key]: 'beta' },
  ]
}

const CASES: Case[] = [
  { name: 'Blast Radius', Component: BlastRadiusTable, endpoint: 'blastRadius', scope: 'redzone:blastRadius', header: 'Technology', key: 'techName' },
  { name: 'DNS Drift', Component: DnsDriftTable, endpoint: 'dnsDrift', scope: 'redzone:dnsDrift', header: 'Domain', key: 'domain',
    base: {
      historicResolutions: [], externalDomains: [], currentIps: [], currentAsns: [],
      currentCountries: [], asnDrift: [], countryDrift: [], danglingSubs: [],
    } },
  { name: 'DNS / Email', Component: DnsEmailTable, endpoint: 'dnsEmail', scope: 'redzone:dnsEmail', header: 'Domain', key: 'domain' },
  { name: 'GraphQL Ledger', Component: GraphqlLedgerTable, endpoint: 'graphql', scope: 'redzone:graphql', header: 'Endpoint', key: 'endpointUrl' },
  { name: 'JS Dep Signals', Component: JsDepSignalsTable, endpoint: 'supplyChain', scope: 'redzone:supplyChain', header: 'Type', key: 'findingType' },
  { name: 'Kill Chain', Component: KillChainTable, endpoint: 'killChain', scope: 'redzone:killChain', header: 'Subdomain', key: 'subdomain' },
  { name: 'Net Initial Access', Component: NetInitAccessTable, endpoint: 'netInitAccess', scope: 'redzone:netInitAccess', header: 'IP', key: 'ipAddress' },
  { name: 'Param Matrix', Component: ParamMatrixTable, endpoint: 'paramMatrix', scope: 'redzone:paramMatrix', header: 'Parameter', key: 'paramName' },
  { name: 'Secrets', Component: SecretsTable, endpoint: 'secrets', scope: 'redzone:secrets', header: 'Origin', key: 'origin' },
  { name: 'Shared Infra', Component: SharedInfraTable, endpoint: 'sharedInfra', scope: 'redzone:sharedInfra', header: 'Type', key: 'clusterType' },
  { name: 'Takeover', Component: TakeoverTable, endpoint: 'takeover', scope: 'redzone:takeover', header: 'Hostname', key: 'hostname',
    base: { verdict: 'likely', sources: [] } },
  { name: 'Threat Intel', Component: ThreatIntelTable, endpoint: 'threatIntel', scope: 'redzone:threatIntel', header: 'Type', key: 'assetType' },
  { name: 'Web Cache Poison', Component: WebCachePoisonTable, endpoint: 'webCachePoison', scope: 'redzone:webCachePoison', header: 'Endpoint', key: 'endpointUrl' },
  { name: 'Web Initial Access', Component: WebInitAccessTable, endpoint: 'webInitAccess', scope: 'redzone:webInitAccess', header: 'BaseURL', key: 'baseUrl',
    base: { headerGrid: {}, authEndpoints: [], findings: [] } },
]

/** The sheeted tables: same contract, but the scope carries the sheet. */
const SHEET_CASES: Case[] = [
  { name: 'AI Surface', Component: AiSurfaceTable, endpoint: 'aiSurface', scope: 'redzone:aiSurface:llmEndpoints', header: 'Base URL', key: 'baseUrl', sheet: 'llmEndpoints' },
  { name: 'AI Risk', Component: AiRiskTable, endpoint: 'aiRisk', scope: 'redzone:aiRisk:findings', header: 'Finding', key: 'name', sheet: 'findings' },
  { name: 'Supply Chain SCA', Component: SupplyChainScaTable, endpoint: 'supplyChainSca', scope: 'redzone:supplyChainSca:verdicts', header: 'Package', key: 'name', sheet: 'verdicts',
    base: { repos: [], baseUrls: [], sboms: [], aliases: [] } },
]

interface PatchCall { featureKey: string; value: any }

function installFetch(c: Case, prefs: Record<string, unknown> = {}) {
  const patches: PatchCall[] = []
  const rows = rowsFor(c)
  const body = c.sheet ? { sheets: { [c.sheet]: rows }, meta: {} } : { rows, meta: {} }
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (u.startsWith(`/api/analytics/redzone/${c.endpoint}`)) {
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (u === '/api/user/preferences' && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify(prefs), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (init?.method === 'PATCH') {
      const b = JSON.parse(init.body as string) as PatchCall
      patches.push(b)
      return new Response(JSON.stringify({ [b.featureKey]: b.value }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return patches
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

function bodyRowCount(container: HTMLElement): number {
  return container.querySelectorAll('tbody tr').length
}

async function openFilters() {
  const button = await screen.findByRole('button', { name: /^Filters/i })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  return screen.findByPlaceholderText('Find a column…')
}

function openColumnCard(label: string) {
  const header = screen.getByRole('button', { name: new RegExp(`^Filter by ${label}( \\(active\\))?$`) })
  if (header.getAttribute('aria-expanded') === 'false') fireEvent.click(header)
  return header
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe.each([...CASES, ...SHEET_CASES])('$name', (c: Case) => {
  function renderIt() {
    return render(createElement(c.Component, { projectId: PROJECT }), { wrapper: makeWrapper() })
  }

  test('renders its rows and offers a Filters button', async () => {
    installFetch(c)
    const { container } = renderIt()
    await waitFor(() => expect(bodyRowCount(container)).toBe(2))
    expect(screen.getByRole('button', { name: /^Filters/i })).toBeTruthy()
  })

  test('the panel lists this sheet\'s own column', async () => {
    installFetch(c)
    renderIt()
    await openFilters()
    expect(screen.getByRole('button', { name: new RegExp(`^Filter by ${c.header}`) })).toBeTruthy()
  })

  test('picking a value narrows the rows', async () => {
    installFetch(c)
    const { container } = renderIt()
    await openFilters()
    openColumnCard(c.header)
    fireEvent.click(await screen.findByRole('checkbox', { name: /alpha/ }))
    await waitFor(() => expect(bodyRowCount(container)).toBe(1))
  })

  test('the choice is saved under this table\'s own scope', async () => {
    const patches = installFetch(c)
    renderIt()
    await openFilters()
    openColumnCard(c.header)
    fireEvent.click(await screen.findByRole('checkbox', { name: /alpha/ }))

    await waitFor(() => expect(patches.some(p => p.featureKey === 'tableFilters')).toBe(true))
    const value = patches.filter(p => p.featureKey === 'tableFilters').pop()!.value
    expect(Object.keys(value[PROJECT])).toEqual([c.scope])
    expect(value[PROJECT][c.scope][c.key].selected).toEqual(['alpha'])
  })

  test('a saved filter is restored on mount', async () => {
    installFetch(c, {
      tableFilters: {
        [PROJECT]: {
          [c.scope]: {
            [c.key]: {
              presence: 'any', selected: ['beta'], listMode: 'any', min: null, max: null,
              from: '', to: '', q: '', textMode: 'contains', negate: false,
            },
          },
        },
      },
    })
    const { container } = renderIt()
    await waitFor(() => expect(bodyRowCount(container)).toBe(1))
  })
})
