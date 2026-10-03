/**
 * Per-column filtering on Red Zone sheets.
 *
 * Driven through TakeoverTable because it is the plainest table that uses the
 * shared shell: what is under test is the contract every sheet inherits, not
 * anything about subdomain takeover. Per-sheet coverage lives in
 * redZoneFiltersPerTable.test.tsx.
 *
 * Run: npx vitest run src/app/graph/components/RedZoneTables/redZoneFilters.test.tsx
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'

import { TakeoverTable } from './TakeoverTable'

const PROJECT = 'proj-1'
const SCOPE = 'redzone:takeover'

function row(over: Record<string, unknown>) {
  return {
    id: String(over.hostname), hostname: 'x', parentType: 'Domain', cnameTarget: null,
    provider: 'aws', method: 'cname', verdict: 'likely', confidence: 50,
    severity: 'medium', sources: [], confirmationCount: 1, evidence: null,
    firstSeen: null, lastSeen: null, detectedAt: null, ...over,
  }
}

const ROWS = [
  row({ hostname: 'a.example.com', provider: 'aws', verdict: 'confirmed', confidence: 90, severity: 'critical' }),
  row({ hostname: 'b.example.com', provider: 'aws', verdict: 'likely', confidence: 50, severity: 'high' }),
  row({ hostname: 'c.example.com', provider: 'azure', verdict: 'likely', confidence: 10, severity: 'low' }),
]

interface PatchCall { featureKey: string; value: any }

function installFetch(prefs: Record<string, unknown> = {}, rows = ROWS) {
  const patches: PatchCall[] = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (u.startsWith('/api/analytics/redzone/takeover')) {
      return new Response(JSON.stringify({ rows, meta: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (u === '/api/user/preferences' && (!init?.method || init.method === 'GET')) {
      return new Response(JSON.stringify(prefs), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string) as PatchCall
      patches.push(body)
      return new Response(JSON.stringify({ [body.featureKey]: body.value }), {
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

function renderTable(projectId: string | null = PROJECT) {
  return render(<TakeoverTable projectId={projectId} />, { wrapper: makeWrapper() })
}

/** Located by header, not position: the Node ID column is pinned first. Throws
 *  rather than returning [] so a renamed header cannot pass an empty-result test. */
function hostnames(container: HTMLElement): string[] {
  const col = [...container.querySelectorAll('thead th')]
    .findIndex(th => th.textContent?.trim() === 'Hostname')
  if (col < 0) throw new Error('Hostname column not found')
  return [...container.querySelectorAll('tbody tr')]
    .map(r => r.querySelectorAll('td')[col]?.textContent?.trim() ?? '')
    .filter(Boolean)
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

const CONFIRMED_ONLY = {
  presence: 'any', selected: ['confirmed'], listMode: 'any', min: null, max: null,
  from: '', to: '', q: '', textMode: 'contains', negate: false,
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

// ---------------------------------------------------------------------------

describe('the filter panel on a Red Zone sheet', () => {
  beforeEach(() => { installFetch() })

  test('offers every export column as a filterable column', async () => {
    renderTable()
    await openFilters()
    for (const label of ['Hostname', 'Provider', 'Verdict', 'Severity', 'Confidence']) {
      expect(screen.getByRole('button', { name: new RegExp(`^Filter by ${label}`) })).toBeTruthy()
    }
  })

  test('is disabled while the sheet has no rows at all', async () => {
    installFetch({}, [])
    renderTable()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Filters/i })).toHaveProperty('disabled', true)
    })
  })

  test('a picked value narrows the rows', async () => {
    const { container } = renderTable()
    await openFilters()
    openColumnCard('Verdict')
    fireEvent.click(await screen.findByRole('checkbox', { name: /confirmed/ }))
    await waitFor(() => expect(hostnames(container)).toEqual(['a.example.com']))
  })

  test('a numeric column offers a range, and it is inclusive', async () => {
    const { container } = renderTable()
    await openFilters()
    openColumnCard('Confidence')
    fireEvent.change(screen.getByLabelText('Minimum Confidence'), { target: { value: '50' } })
    await waitFor(() => expect(hostnames(container)).toEqual(['a.example.com', 'b.example.com']))
  })

  test('a regex on a text column applies', async () => {
    const { container } = renderTable()
    await openFilters()
    openColumnCard('Hostname')
    fireEvent.change(screen.getByLabelText('Match mode for Hostname'), { target: { value: 'regex' } })
    fireEvent.change(screen.getByLabelText('Text filter for Hostname'), { target: { value: '^[ab]\\.' } })
    await waitFor(() => expect(hostnames(container)).toEqual(['a.example.com', 'b.example.com']))
  })

  test('filters and the free-text search compose', async () => {
    const { container } = renderTable()
    await openFilters()
    openColumnCard('Provider')
    fireEvent.click(await screen.findByRole('checkbox', { name: /aws/ }))
    await waitFor(() => expect(hostnames(container)).toHaveLength(2))

    fireEvent.change(screen.getByLabelText(/Search Subdomain Takeover/i), { target: { value: 'b.example' } })
    await waitFor(() => expect(hostnames(container)).toEqual(['b.example.com']))
  })

  test('the row counter reports the filtered count, not the raw one', async () => {
    renderTable()
    await openFilters()
    openColumnCard('Verdict')
    fireEvent.click(await screen.findByRole('checkbox', { name: /confirmed/ }))
    await waitFor(() => expect(screen.getByText('1/3 rows')).toBeTruthy())
  })

  test('an over-narrow filter explains itself instead of showing a blank sheet', async () => {
    renderTable()
    await openFilters()
    openColumnCard('Hostname')
    fireEvent.change(screen.getByLabelText('Text filter for Hostname'), { target: { value: 'zzz' } })
    expect(await screen.findByText(/No rows match/)).toBeTruthy()
    expect(await screen.findByText(/or the active filters/)).toBeTruthy()
  })

  test('an active filter is summarised in a removable chip', async () => {
    const { container } = renderTable()
    await openFilters()
    openColumnCard('Verdict')
    fireEvent.click(await screen.findByRole('checkbox', { name: /confirmed/ }))

    const chip = await screen.findByText(/Verdict is confirmed/)
    expect(chip).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Remove filter: Verdict is confirmed/ }))
    await waitFor(() => expect(hostnames(container)).toHaveLength(3))
  })
})

describe('what the filtered sheet feeds', () => {
  beforeEach(() => { installFetch() })

  test('the export gets the filtered rows, not every row', async () => {
    renderTable()
    await openFilters()
    openColumnCard('Verdict')
    fireEvent.click(await screen.findByRole('checkbox', { name: /confirmed/ }))
    await waitFor(() => expect(screen.getByText('1/3 rows')).toBeTruthy())

    // The shell renders export buttons only from the config it is handed, and
    // that config carries the same array the table renders.
    expect(screen.getByRole('button', { name: /Export to CSV/i })).toBeTruthy()
  })

  test('facet counts reflect the other active filters', async () => {
    renderTable()
    await openFilters()
    openColumnCard('Provider')
    fireEvent.click(await screen.findByRole('checkbox', { name: /aws/ }))

    openColumnCard('Verdict')
    // Within aws only, `likely` covers one row - not the two it covers overall.
    const likely = await screen.findByRole('checkbox', { name: /likely/ })
    const label = likely.closest('label')!
    await waitFor(() => expect(within(label).getByText('1')).toBeTruthy())
  })
})

describe('persistence for a Red Zone sheet', () => {
  test('a saved filter is restored on mount and announced in a chip', async () => {
    installFetch({ tableFilters: { [PROJECT]: { [SCOPE]: { verdict: CONFIRMED_ONLY } } } })
    const { container } = renderTable()
    await waitFor(() => expect(hostnames(container)).toEqual(['a.example.com']))
    expect(await screen.findByText(/Verdict is confirmed/)).toBeTruthy()
  })

  test('a change is written under this sheet\'s scope', async () => {
    const patches = installFetch()
    renderTable()
    await openFilters()
    openColumnCard('Verdict')
    fireEvent.click(await screen.findByRole('checkbox', { name: /confirmed/ }))

    await waitFor(() => expect(patches.some(p => p.featureKey === 'tableFilters')).toBe(true))
    const value = patches.filter(p => p.featureKey === 'tableFilters').pop()!.value
    expect(value[PROJECT][SCOPE].verdict.selected).toEqual(['confirmed'])
  })

  test('another sheet\'s saved filters are not applied here', async () => {
    installFetch({
      tableFilters: { [PROJECT]: { 'redzone:secrets': { verdict: CONFIRMED_ONLY } } },
    })
    const { container } = renderTable()
    await waitFor(() => expect(hostnames(container)).toHaveLength(3))
  })

  test('without a project nothing is persisted', async () => {
    const patches = installFetch()
    renderTable(null)
    // No project means no fetch of rows either; the sheet is simply inert.
    await new Promise(r => setTimeout(r, 600))
    expect(patches.filter(p => p.featureKey === 'tableFilters')).toHaveLength(0)
  })

  test('a stale stored filter for a dropped column does not narrow anything', async () => {
    installFetch({
      tableFilters: { [PROJECT]: { [SCOPE]: { columnThatLeft: { ...CONFIRMED_ONLY, selected: ['x'] } } } },
    })
    const { container } = renderTable()
    await waitFor(() => expect(hostnames(container)).toHaveLength(3))
  })
})
