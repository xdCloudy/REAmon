/**
 * Sheeted Red Zone tables, where "which table am I" is not the component.
 *
 * Supply-Chain SCA and the AI tables put several sheets behind one shell, and
 * the sheets have disjoint columns. That makes three failures possible that a
 * single-sheet table cannot have:
 *
 *   - a filter set on one sheet still applied after switching to another,
 *     which for disjoint columns means an empty table with no visible cause
 *   - both sheets sharing one saved filter set, so filters appear to "jump"
 *   - a filter restored onto a sheet that has since become empty, with the
 *     Filters button disabled and therefore no way to clear it
 *
 * Run: npx vitest run src/app/graph/components/RedZoneTables/redZoneFilters.sheets.test.tsx
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'

import { SupplyChainScaTable } from './SupplyChainScaTable'
import { TakeoverTable } from './TakeoverTable'

const PROJECT = 'p1'

function pkg(over: Record<string, unknown>) {
  return {
    purl: 'pkg:npm/x', name: 'x', version: '1', ecosystem: 'npm', harvestSource: 'sbom',
    sourcePath: null, firstSeen: null, lastSeen: null, baseUrls: [], repos: [], sboms: [],
    maliciousCount: 0, suspiciousCount: 0, notAnalysedCount: 0, advisoryCount: 0,
    advisorySeverities: [], ...over,
  }
}

function verdict(over: Record<string, unknown>) {
  return {
    findingId: 'f', verdict: 'suspicious', severity: 'low', sourceTool: 'osv',
    advisoryId: 'A-1', title: 't', detail: 'd', confidence: 'suspicious', softError: false,
    aliases: [], firstSeen: null, lastSeen: null, purl: 'pkg:npm/x', name: 'x',
    version: '1', ecosystem: 'npm', harvestSource: 'sbom', sourcePath: null,
    baseUrls: [], repos: [], sboms: [], ...over,
  }
}

const SCA = {
  sheets: {
    verdicts: [
      verdict({ findingId: 'v1', name: 'alpha', verdict: 'malicious' }),
      verdict({ findingId: 'v2', name: 'beta', verdict: 'suspicious' }),
    ],
    packages: [
      pkg({ purl: 'pkg:npm/alpha', name: 'alpha', ecosystem: 'npm' }),
      pkg({ purl: 'pkg:pypi/gamma', name: 'gamma', ecosystem: 'pypi' }),
    ],
    advisories: [],
  },
  meta: { truncated: {} },
}

interface PatchCall { featureKey: string; value: any }

function installFetch(prefs: Record<string, unknown> = {}, body: unknown = SCA) {
  const patches: PatchCall[] = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (u.includes('/api/analytics/redzone/')) {
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

const rowCount = (c: HTMLElement) => c.querySelectorAll('tbody tr').length

/**
 * Idempotent: the panel closes on `mousedown` outside it, and `fireEvent.click`
 * does not dispatch one - so after a sheet switch the panel is still open here
 * even though a real click would have closed it. Clicking again would toggle it
 * shut and make the test fail for a reason that does not exist in a browser.
 */
async function openFilters() {
  const already = screen.queryByPlaceholderText('Find a column…')
  if (already) return already
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

async function selectSheet(name: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name }))
}

const SELECT = (values: string[]) => ({
  presence: 'any', selected: values, listMode: 'any', min: null, max: null,
  from: '', to: '', q: '', textMode: 'contains', negate: false,
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

// ---------------------------------------------------------------------------

describe('a filter belongs to one sheet', () => {
  test('switching sheet drops it from view', async () => {
    installFetch()
    const { container } = render(<SupplyChainScaTable projectId={PROJECT} />, { wrapper: makeWrapper() })
    await waitFor(() => expect(rowCount(container)).toBe(2))

    await openFilters()
    openColumnCard('Verdict')
    fireEvent.click(await screen.findByRole('checkbox', { name: /^malicious/ }))
    await waitFor(() => expect(rowCount(container)).toBe(1))

    await selectSheet(/^Packages/)
    // `verdict` does not exist on the packages sheet; carrying the filter over
    // would filter every row out and show an empty sheet for no visible reason.
    await waitFor(() => expect(rowCount(container)).toBe(2))
    expect(screen.queryByText(/Verdict is malicious/)).toBeNull()
  })

  test('going back to the sheet brings it back', async () => {
    installFetch()
    const { container } = render(<SupplyChainScaTable projectId={PROJECT} />, { wrapper: makeWrapper() })
    await waitFor(() => expect(rowCount(container)).toBe(2))

    await openFilters()
    openColumnCard('Verdict')
    fireEvent.click(await screen.findByRole('checkbox', { name: /^malicious/ }))
    await waitFor(() => expect(rowCount(container)).toBe(1))

    await selectSheet(/^Packages/)
    await waitFor(() => expect(rowCount(container)).toBe(2))
    await selectSheet(/^Verdicts/)
    await waitFor(() => expect(rowCount(container)).toBe(1))
  })

  test('each sheet is saved under its own scope', async () => {
    const patches = installFetch()
    render(<SupplyChainScaTable projectId={PROJECT} />, { wrapper: makeWrapper() })

    await openFilters()
    openColumnCard('Verdict')
    fireEvent.click(await screen.findByRole('checkbox', { name: /^malicious/ }))
    await waitFor(() => expect(patches.some(p => p.featureKey === 'tableFilters')).toBe(true))

    await selectSheet(/^Packages/)
    await openFilters()
    openColumnCard('Ecosystem')
    fireEvent.click(await screen.findByRole('checkbox', { name: /^pypi/ }))

    await waitFor(() => {
      const value = patches.filter(p => p.featureKey === 'tableFilters').pop()!.value
      expect(Object.keys(value[PROJECT]).sort()).toEqual([
        'redzone:supplyChainSca:packages',
        'redzone:supplyChainSca:verdicts',
      ])
    })
  })

  test('sheets restore independently on mount', async () => {
    installFetch({
      tableFilters: {
        [PROJECT]: {
          'redzone:supplyChainSca:verdicts': { verdict: SELECT(['malicious']) },
          'redzone:supplyChainSca:packages': { ecosystem: SELECT(['pypi']) },
        },
      },
    })
    const { container } = render(<SupplyChainScaTable projectId={PROJECT} />, { wrapper: makeWrapper() })
    await waitFor(() => expect(rowCount(container)).toBe(1))

    await selectSheet(/^Packages/)
    await waitFor(() => expect(rowCount(container)).toBe(1))
    expect(await screen.findByText(/Ecosystem is pypi/)).toBeTruthy()
  })
})

describe('a restored filter is always escapable', () => {
  test('on a sheet that has since gone empty, the chip still clears it', async () => {
    // The Filters BUTTON is disabled with no rows, so the chip is the only way
    // out; if it were hidden too, the user would be stuck with an empty sheet.
    installFetch(
      { tableFilters: { [PROJECT]: { 'redzone:takeover': { verdict: SELECT(['confirmed']) } } } },
      { rows: [], meta: {} },
    )
    render(<TakeoverTable projectId={PROJECT} />, { wrapper: makeWrapper() })

    const chip = await screen.findByRole('button', { name: /Remove filter: Verdict is confirmed/ })
    expect(screen.getByRole('button', { name: /^Filters/i })).toHaveProperty('disabled', true)

    fireEvent.click(chip)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Remove filter:/ })).toBeNull())
  })

  test('a filter matching nothing explains itself and stays clearable', async () => {
    installFetch(
      { tableFilters: { [PROJECT]: { 'redzone:takeover': { hostname: { ...SELECT([]), q: 'nomatch' } } } } },
      { rows: [{ id: 'a', hostname: 'a.example.com', verdict: 'likely', sources: [] }], meta: {} },
    )
    const { container } = render(<TakeoverTable projectId={PROJECT} />, { wrapper: makeWrapper() })

    await waitFor(() => expect(rowCount(container)).toBe(0))
    expect(await screen.findByText(/No rows match/)).toBeTruthy()
    // The button stays usable because the SHEET has rows, even though none match.
    expect(screen.getByRole('button', { name: /^Filters/i })).toHaveProperty('disabled', false)
  })
})

describe('date columns on a live sheet', () => {
  test('an ISO timestamp column filters by day, inclusive', async () => {
    installFetch({}, {
      rows: [
        { id: 'a', hostname: 'a.example.com', verdict: 'likely', sources: [], lastSeen: '2026-08-07 23:30:00' },
        { id: 'b', hostname: 'b.example.com', verdict: 'likely', sources: [], lastSeen: '2026-08-09 00:30:00' },
      ],
      meta: {},
    })
    const { container } = render(<TakeoverTable projectId={PROJECT} />, { wrapper: makeWrapper() })
    await waitFor(() => expect(rowCount(container)).toBe(2))

    await openFilters()
    openColumnCard('Last Seen')
    fireEvent.change(screen.getByLabelText('Last Seen from'), { target: { value: '2026-08-07' } })
    fireEvent.change(screen.getByLabelText('Last Seen to'), { target: { value: '2026-08-07' } })

    // The 23:30 row displays as the 7th and must be kept regardless of the
    // machine's timezone; the 9th must go.
    await waitFor(() => expect(rowCount(container)).toBe(1))
  })
})
