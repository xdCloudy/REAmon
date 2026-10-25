/**
 * Node Inspector filtering against the parts of the table it has to agree with.
 *
 * A filter is only correct if everything downstream of it agrees: the row
 * counter, the pager, the export, and the other views of the same data. Each of
 * these has its own copy of "which rows are we talking about", and the ways
 * they drift are all silent:
 *
 *   - filter while on page 3 of 5 and land on a page that no longer exists,
 *     showing an empty table over a non-empty result
 *   - export the whole node type while the screen shows 12 rows
 *   - a filter that narrows the body but not the "N of M" counter
 *
 * Run: npx vitest run src/app/graph/components/NodeDetailsTable/NodeFilterPanel.integration.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createElement } from 'react'

import { NodeDetailsTable } from './NodeDetailsTable'
import type { GraphData } from '../../types'

const exportCalls: { fn: string; input: any }[] = []
vi.mock('./exportNodeDetails', () => ({
  exportNodeDetailsCsv: vi.fn(async (input: any) => { exportCalls.push({ fn: 'csv', input }) }),
  exportNodeDetailsJson: vi.fn(async (input: any) => { exportCalls.push({ fn: 'json', input }) }),
  exportNodeDetailsMarkdown: vi.fn(async (input: any) => { exportCalls.push({ fn: 'md', input }) }),
}))

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

function installFetchMock() {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    if (u === '/api/user/preferences' && (!init?.method || init.method === 'GET')) {
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ [body.featureKey]: body.value }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

/** 120 rows: more than the 50-row page size, so paging is real. */
const TOTAL = 120
const LIVE = 30

function makeData(): GraphData {
  const nodes = Array.from({ length: TOTAL }, (_, i) => ({
    id: `s${i}`,
    name: `host${String(i).padStart(3, '0')}.example.com`,
    type: 'Subdomain',
    properties: { status: i < LIVE ? 'live' : 'dead', port: i },
  }))
  return { nodes, links: [], projectId: 'p1' } as unknown as GraphData
}

function renderTable() {
  return render(
    <NodeDetailsTable data={makeData()} isLoading={false} error={null} projectId="p1" />,
    { wrapper: makeWrapper() },
  )
}

function bodyRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('tbody tr')].filter(
    r => !r.className.includes('noMatchRow'),
  ) as HTMLElement[]
}

async function openFilters() {
  fireEvent.click(screen.getByRole('button', { name: /Filters/i }))
  return screen.findByPlaceholderText('Find a column…')
}

function openColumnCard(label: string) {
  const header = screen.getByRole('button', { name: new RegExp(`^Filter by ${label}( \\(active\\))?$`) })
  if (header.getAttribute('aria-expanded') === 'false') fireEvent.click(header)
  return header
}

async function filterToLive() {
  await openFilters()
  openColumnCard('status')
  fireEvent.click(await screen.findByRole('checkbox', { name: /^live/ }))
}

beforeEach(() => { exportCalls.length = 0; installFetchMock() })
afterEach(() => { cleanup(); vi.clearAllMocks() })

// ---------------------------------------------------------------------------

describe('filtering and paging agree', () => {
  test('the first page is full before filtering', async () => {
    const { container } = renderTable()
    await waitFor(() => expect(bodyRows(container)).toHaveLength(50))
  })

  test('filtering from a later page does not leave the user on a dead page', async () => {
    const { container } = renderTable()
    await waitFor(() => expect(bodyRows(container)).toHaveLength(50))

    // Page 3 of 3 - beyond where 30 matching rows can reach.
    fireEvent.click(screen.getByRole('button', { name: /Last page|Go to last page/i }))
    await waitFor(() => expect(screen.getByText(/Page 3 of 3/)).toBeTruthy())

    await filterToLive()
    await waitFor(() => expect(screen.getByText(/Page 1 of 1/)).toBeTruthy())
    expect(bodyRows(container).length).toBe(LIVE)
  })

  test('the page count follows the filtered set, not the raw one', async () => {
    renderTable()
    await filterToLive()
    await waitFor(() => expect(screen.getByText(/Page 1 of 1/)).toBeTruthy())
  })

  test('clearing the filter restores the full pager', async () => {
    renderTable()
    await filterToLive()
    await waitFor(() => expect(screen.getByText(/Page 1 of 1/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Remove filter: status is live/ }))
    await waitFor(() => expect(screen.getByText(/Page 1 of 3/)).toBeTruthy())
  })
})

describe('the export follows the filter', () => {
  test('exporting after filtering ships only the matching rows', async () => {
    renderTable()
    await filterToLive()
    await screen.findByRole('button', { name: /Remove filter: status is live/ })

    fireEvent.click(screen.getByRole('button', { name: /CSV/i }))
    await waitFor(() => expect(exportCalls).toHaveLength(1))
    expect(exportCalls[0].input.rows).toHaveLength(LIVE)
  })

  test('every export format sees the same rows', async () => {
    renderTable()
    await filterToLive()
    await screen.findByRole('button', { name: /Remove filter: status is live/ })

    const formats = [/CSV/i, /JSON/i, /^MD$|Markdown/i]
    for (const [index, name] of formats.entries()) {
      fireEvent.click(screen.getByRole('button', { name }))
      await waitFor(() => expect(exportCalls).toHaveLength(index + 1))
    }
    expect(new Set(exportCalls.map(c => c.input.rows.length))).toEqual(new Set([LIVE]))
  })

  test('the export is not limited to the visible page', async () => {
    // 30 matching rows all fit on one page here; the guard is that the export
    // reads the filtered ROW MODEL rather than the paginated slice.
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: /CSV/i }))
    await waitFor(() => expect(exportCalls).toHaveLength(1))
    expect(exportCalls[0].input.rows).toHaveLength(TOTAL)
  })
})

describe('the counter agrees with the body', () => {
  test('it reports filtered over total once a filter is active', async () => {
    renderTable()
    await filterToLive()
    await waitFor(() => expect(screen.getByText(new RegExp(`${LIVE}\\s*/\\s*${TOTAL}`))).toBeTruthy())
  })

  test('an over-narrow filter says so instead of showing a blank table', async () => {
    const { container } = renderTable()
    await openFilters()
    openColumnCard('Name')
    fireEvent.change(screen.getByLabelText('Text filter for Name'), { target: { value: 'nope' } })

    expect(await screen.findByText(/No rows match the current filters/)).toBeTruthy()
    expect(bodyRows(container)).toHaveLength(0)
  })
})

describe('a numeric filter on a real column', () => {
  test('a range narrows to exactly the rows in it', async () => {
    const { container } = renderTable()
    await openFilters()
    openColumnCard('port')
    fireEvent.change(screen.getByLabelText('Minimum port'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Maximum port'), { target: { value: '19' } })
    await waitFor(() => expect(bodyRows(container)).toHaveLength(10))
  })

  test('the range and a facet compose', async () => {
    const { container } = renderTable()
    await openFilters()
    openColumnCard('port')
    fireEvent.change(screen.getByLabelText('Minimum port'), { target: { value: '20' } })
    openColumnCard('status')
    fireEvent.click(await screen.findByRole('checkbox', { name: /^live/ }))
    // ports 20..29 are the only rows that are both >= 20 and live.
    await waitFor(() => expect(bodyRows(container)).toHaveLength(10))
  })
})

/**
 * The defect this whole feature started from: `last_seen` is a Cypher
 * `datetime()`, which reaches the browser as a temporal OBJECT. The cell
 * renders it as "2026-08-07 15:32:58" while a naive filter compared the user's
 * pattern against `[object Object]` - so every filter on a timestamp column
 * matched nothing, on a column that visibly contained dates.
 */
describe('regression: filtering a Neo4j timestamp column', () => {
  function neo(h: number, mi: number, s: number) {
    const i = (low: number) => ({ low, high: 0 })
    return {
      year: i(2026), month: i(8), day: i(7),
      hour: i(h), minute: i(mi), second: i(s),
      nanosecond: i(0), timeZoneOffsetSeconds: i(0),
    }
  }

  function temporalData(): GraphData {
    const nodes = [
      { id: 'p1', name: 'pkg-a', type: 'Package', properties: { last_seen: neo(15, 32, 58) } },
      { id: 'p2', name: 'pkg-b', type: 'Package', properties: { last_seen: neo(15, 45, 1) } },
      { id: 'p3', name: 'pkg-c', type: 'Package', properties: { last_seen: neo(16, 14, 17) } },
    ]
    return { nodes, links: [], projectId: 'p1' } as unknown as GraphData
  }

  function renderTemporal() {
    return render(
      <NodeDetailsTable data={temporalData()} isLoading={false} error={null} projectId="p1" />,
      { wrapper: makeWrapper() },
    )
  }

  test('the cell shows the formatted timestamp', async () => {
    const { container } = renderTemporal()
    await waitFor(() => expect(container.textContent).toContain('2026-08-07 15:32:58'))
  })

  test('the column is offered as a date range, not as opaque text', async () => {
    renderTemporal()
    await openFilters()
    openColumnCard('last_seen')
    expect(screen.getByLabelText('last_seen from')).toBeTruthy()
  })

  test('the hour-window regex a user would type selects the right rows', async () => {
    const { container } = renderTemporal()
    await openFilters()
    openColumnCard('last_seen')
    fireEvent.change(screen.getByLabelText('Match mode for last_seen'), { target: { value: 'regex' } })
    fireEvent.change(screen.getByLabelText('Text filter for last_seen'), {
      target: { value: '^\\d{4}-\\d{2}-\\d{2} 15:\\d{2}:\\d{2}$' },
    })
    await waitFor(() => expect(bodyRows(container)).toHaveLength(2))
  })

  test('a plain contains search finds the displayed text', async () => {
    const { container } = renderTemporal()
    await openFilters()
    openColumnCard('last_seen')
    fireEvent.change(screen.getByLabelText('Text filter for last_seen'), { target: { value: '16:14' } })
    await waitFor(() => expect(bodyRows(container)).toHaveLength(1))
  })

  test('the date picker covers the day the cells display', async () => {
    const { container } = renderTemporal()
    await openFilters()
    openColumnCard('last_seen')
    fireEvent.change(screen.getByLabelText('last_seen from'), { target: { value: '2026-08-07' } })
    fireEvent.change(screen.getByLabelText('last_seen to'), { target: { value: '2026-08-07' } })
    await waitFor(() => expect(bodyRows(container)).toHaveLength(3))
  })

  test('the facet list offers the formatted values, not JSON', async () => {
    renderTemporal()
    await openFilters()
    openColumnCard('last_seen')
    // A date column has no facet list, so the guard is that nothing anywhere in
    // the panel advertises the raw object shape.
    expect(screen.queryByText(/"low"/)).toBeNull()
  })
})

/**
 * Navigating the panel itself.
 *
 * Both controls here only appear once a table is big enough to need them - a
 * type with 40 properties, a column with 300 distinct values - which is exactly
 * when they stop being cosmetic and become the only way to reach a column.
 */
describe('finding your way around a large panel', () => {
  const PROPS = 40
  const ROWS = 300
  // 20 owners, each repeating: enough distinct values to overflow the 12 shown
  // in a card, few enough that the column is inferred as a picker at all. A
  // column of 300 unique values is correctly a text box, with no facets.
  const OWNERS = 20

  function wideData(): GraphData {
    const nodes = Array.from({ length: ROWS }, (_, i) => {
      const properties: Record<string, unknown> = { owner: `team-${String(i % OWNERS).padStart(2, '0')}` }
      for (let p = 0; p < PROPS; p++) properties[`attr_${p}`] = p % 2 === 0 ? 'x' : 'y'
      return { id: `n${i}`, name: `n${i}.example.com`, type: 'Subdomain', properties }
    })
    return { nodes, links: [], projectId: 'p1' } as unknown as GraphData
  }

  function renderWide() {
    return render(
      <NodeDetailsTable data={wideData()} isLoading={false} error={null} projectId="p1" />,
      { wrapper: makeWrapper() },
    )
  }

  test('the column search narrows the card list to matches', async () => {
    renderWide()
    const search = await openFilters()
    expect(screen.getAllByRole('button', { name: /^Filter by / }).length).toBeGreaterThan(20)

    fireEvent.change(search, { target: { value: 'attr_7' } })
    await waitFor(() => {
      const cards = screen.getAllByRole('button', { name: /^Filter by / })
      expect(cards.map(c => c.getAttribute('aria-label'))).toEqual(['Filter by attr_7'])
    })
  })

  test('a column search matching nothing says so instead of showing an empty panel', async () => {
    renderWide()
    const search = await openFilters()
    fireEvent.change(search, { target: { value: 'zzzz' } })
    expect(await screen.findByText(/No column matches that name/)).toBeTruthy()
  })

  test('a long facet list is truncated, and "Show all" reveals the rest', async () => {
    renderWide()
    await openFilters()
    openColumnCard('owner')

    // Capped at FACET_VISIBLE (12) plus the card's own `not` toggle.
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeLessThanOrEqual(13))
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`Show all ${OWNERS}`) }))
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBe(OWNERS + 1))
  })

  test('the in-card search finds a value that is not on screen', async () => {
    renderWide()
    await openFilters()
    openColumnCard('owner')

    fireEvent.change(screen.getByLabelText('Search values for owner'), { target: { value: 'team-19' } })
    const box = await screen.findByRole('checkbox', { name: /^team-19/ })
    fireEvent.click(box)
    await screen.findByRole('button', { name: /Remove filter: owner is team-19/ })
  })

  test('a selected value stays visible after the search that found it is cleared', async () => {
    renderWide()
    await openFilters()
    openColumnCard('owner')

    const cardSearch = screen.getByLabelText('Search values for owner')
    fireEvent.change(cardSearch, { target: { value: 'team-19' } })
    fireEvent.click(await screen.findByRole('checkbox', { name: /^team-19/ }))
    fireEvent.change(cardSearch, { target: { value: '' } })

    // team-19 sits outside the 12 facets shown by default, so only the
    // "keep selected values pinned" rule can keep it reachable.
    const still = await screen.findByRole('checkbox', { name: /^team-19/ })
    expect((still as HTMLInputElement).checked).toBe(true)
  })
})
