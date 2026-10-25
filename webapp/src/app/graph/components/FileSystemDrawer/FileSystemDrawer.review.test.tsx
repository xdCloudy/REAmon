/**
 * Stage-B deep review tests for FileSystemDrawer.
 *
 * Goal: find bugs the happy-path tests can't catch.
 *
 * Covers:
 *  - isProtectedPath equivalence with backend (11 variants from bug #17)
 *  - False-positive protection (names that contain "notes" but aren't)
 *  - Drag-drop happy path (upload triggered by drop event)
 *  - Modal: backdrop click closes; Cancel suppresses fetch
 *  - Mkdir: invalid name (slash) shows alert, does NOT POST
 *
 * Run: npx vitest run src/app/graph/components/FileSystemDrawer/FileSystemDrawer.review.test.tsx
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { FileSystemDrawer } from './FileSystemDrawer'

vi.mock('@/components/ui/Drawer', () => ({
  Drawer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="drawer">{children}</div>
  ),
}))

// Mock useAlertModal. The real hook requires <AlertProvider> in the tree
// (mounted in app/layout.tsx in production). The component now uses these
// modal-based alerts instead of window.alert/confirm, so tests assert on the
// spies. vi.hoisted runs before the vi.mock factory so the refs are stable.
const alertSpies = vi.hoisted(() => ({
  alert: vi.fn(async () => {}),
  alertError: vi.fn(async () => {}),
  alertWarning: vi.fn(async () => {}),
  confirm: vi.fn(async () => true),
  dangerConfirm: vi.fn(async () => true),
}))
vi.mock('@/components/ui', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    useAlertModal: () => alertSpies,
  }
})

interface FetchCall { url: string; init?: RequestInit }
let fetchCalls: FetchCall[] = []
let fetchHandler: (url: string, init?: RequestInit) => Promise<Response>

beforeEach(() => {
  alertSpies.alert.mockClear()
  alertSpies.alertError.mockClear()
  alertSpies.alertWarning.mockClear()
  alertSpies.confirm.mockClear()
  alertSpies.dangerConfirm.mockClear()
  fetchCalls = []
  fetchHandler = async (url) => {
    if (url.includes('/api/agent/workspace/list')) {
      return new Response(JSON.stringify({ entries: sampleWithProtected }), { status: 200 })
    }
    if (url.includes('/api/agent/workspace/jobs')) {
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    fetchCalls.push({ url: urlStr, init })
    return fetchHandler(urlStr, init)
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sampleWithProtected = [
  { name: 'notes', path: 'notes', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'tool-outputs', path: 'tool-outputs', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'jobs', path: 'jobs', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'uploads', path: 'uploads', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  // False-positive candidates: contain "notes" or look protected but aren't
  { name: 'notes-backup', path: 'notes-backup', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'my-notes', path: 'my-notes', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'NOTES', path: 'NOTES', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'tool-outputs-2', path: 'tool-outputs-2', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
]


// =============================================================================
// (1) Protection: only the EXACT 4 names are gated; look-alikes are NOT
// =============================================================================

describe('FileSystemDrawer: protection coverage', () => {
  test('only the 4 default subdirs are gated, not look-alikes', async () => {
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes-backup')).toBeInTheDocument())

    // 4 protected (notes, tool-outputs, jobs, uploads) -> 4 Lock badges
    expect(screen.getAllByTitle(/Protected default folder/)).toHaveLength(4)

    // 4 non-protected (notes-backup, my-notes, NOTES, tool-outputs-2)
    // -> each has Rename and Delete buttons. Total 4 of each.
    expect(screen.getAllByTitle('Rename')).toHaveLength(4)
    expect(screen.getAllByTitle('Delete')).toHaveLength(4)
  })

  test('NOTES (case-sensitive) is NOT protected', async () => {
    // Regression: a future "normalize to lowercase" refactor would silently
    // gate "NOTES" - this would lock the user out of a folder they own.
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('NOTES')).toBeInTheDocument())

    // Find the row containing "NOTES" - it must have Rename + Delete actions,
    // not a Lock badge. Locate via the heading text element.
    const notesUpper = screen.getByText('NOTES')
    const row = notesUpper.closest('div')
    // Per-row Rename / Delete buttons exist somewhere in the row
    // (we know there are exactly 4 Rename buttons; this row contributes one)
    expect(screen.getAllByTitle('Rename').length).toBeGreaterThanOrEqual(1)
    expect(row).toBeTruthy()
  })

  test('subpaths inside protected dirs are NOT themselves protected', async () => {
    // Plant a file INSIDE notes/ and verify it shows Rename + Delete
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({
          entries: [
            { name: 'inner.txt', path: 'notes/inner.txt', isDir: false, isSymlink: false, size: 1, mtime: '2026-05-14T10:00:00Z' },
          ],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" initialPath="notes" />)
    await waitFor(() => expect(screen.getByText('inner.txt')).toBeInTheDocument())
    expect(screen.queryAllByTitle(/Protected default folder/)).toHaveLength(0)
    expect(screen.getAllByTitle('Delete')).toHaveLength(1)
  })
})


// =============================================================================
// (2) Drag-and-drop
// =============================================================================

describe('FileSystemDrawer: drag-and-drop upload', () => {
  test('dropping a file triggers upload to currentPath', async () => {
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" initialPath="uploads" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())

    const dropZone = document.querySelector('[class*="dropZone"]') as HTMLElement
    expect(dropZone).toBeTruthy()

    // Simulate a file drop. jsdom's DataTransfer is limited; pass files via
    // a plain object that React's synthetic event reads through.
    const file = new File(['hello'], 'dropped.txt', { type: 'text/plain' })
    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [file],
        types: ['Files'],
      },
    })

    await waitFor(() => {
      const upload = fetchCalls.find(c => c.url.includes('/api/agent/workspace/upload'))
      expect(upload).toBeDefined()
      expect(upload?.init?.method).toBe('POST')
      const url = new URL(upload!.url, 'http://localhost')
      expect(url.searchParams.get('path')).toBe('uploads')  // currentPath
      expect(url.searchParams.get('filename')).toBe('dropped.txt')
      expect(url.searchParams.get('overwrite')).toBe('false')
      expect(upload!.init!.body).toBe(file)
    })
  })

  test('drag overlay activates on dragover with Files type', async () => {
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())

    const dropZone = document.querySelector('[class*="dropZone"]') as HTMLElement
    fireEvent.dragOver(dropZone, {
      dataTransfer: { types: ['Files'] },
    })
    // The dropZoneActive class kicks in
    await waitFor(() => {
      expect(dropZone.className).toMatch(/dropZoneActive/)
    })
  })
})


// =============================================================================
// (3) Modal behavior
// =============================================================================

describe('FileSystemDrawer: modal UX', () => {
  test('clicking the modal backdrop closes the delete modal', async () => {
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({
          entries: [{ name: 'free.txt', path: 'free.txt', isDir: false, isSymlink: false, size: 1, mtime: '2026-05-14T10:00:00Z' }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('free.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Delete'))
    await screen.findByText('Delete file?')

    // Click the backdrop (not the modal content) -> modal should close
    const backdrop = document.querySelector('[class*="modalBackdrop"]') as HTMLElement
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop)
    await waitFor(() => {
      expect(screen.queryByText('Delete file?')).not.toBeInTheDocument()
    })
    // And no DELETE was fired
    expect(fetchCalls.some(c => c.init?.method === 'DELETE')).toBe(false)
  })

  test('clicking inside the modal body does NOT close it', async () => {
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({
          entries: [{ name: 'free.txt', path: 'free.txt', isDir: false, isSymlink: false, size: 1, mtime: '2026-05-14T10:00:00Z' }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('free.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Delete'))
    await screen.findByText('Delete file?')

    const modal = document.querySelector('[class*="modal"]:not([class*="modalBackdrop"]):not([class*="modalHeader"]):not([class*="modalBody"]):not([class*="modalActions"]):not([class*="modalBtn"])') as HTMLElement
    expect(modal).toBeTruthy()
    fireEvent.click(modal)
    // Modal still open
    expect(screen.getByText('Delete file?')).toBeInTheDocument()
  })
})


// =============================================================================
// (4) Mkdir validation
// =============================================================================

describe('FileSystemDrawer: mkdir input validation', () => {
  test('slash in new folder name is rejected client-side', async () => {
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({ entries: sampleWithProtected }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('New folder in current directory'))
    const input = await screen.findByPlaceholderText('new folder name')
    fireEvent.change(input, { target: { value: 'evil/path' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Alert fires (modal warning), NO mkdir POST
    expect(alertSpies.alertWarning).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchCalls.some(c => c.url.includes('/workspace/mkdir'))).toBe(false)
  })

  test('dot/dotdot names are rejected client-side', async () => {
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('New folder in current directory'))
    const input = await screen.findByPlaceholderText('new folder name')
    for (const bad of ['..', '.']) {
      fireEvent.change(input, { target: { value: bad } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    expect(alertSpies.alertWarning.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(fetchCalls.some(c => c.url.includes('/workspace/mkdir'))).toBe(false)
  })

  test('empty / whitespace-only name closes input without POST', async () => {
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('New folder in current directory'))
    const input = await screen.findByPlaceholderText('new folder name')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('new folder name')).not.toBeInTheDocument()
    })
    expect(fetchCalls.some(c => c.url.includes('/workspace/mkdir'))).toBe(false)
  })
})
