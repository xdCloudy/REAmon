/**
 * Unit + integration tests for FileSystemDrawer.
 *
 * Run: npx vitest run src/app/graph/components/FileSystemDrawer/FileSystemDrawer.test.tsx
 *
 * Covers:
 *  - Rendering: tabs, default Files tab, breadcrumb, empty/error/loading states.
 *  - Files tab: list rendering, dir navigation, parent-dir entry, breadcrumb clicks,
 *    refresh button, refetch on path change.
 *  - Rename: enter mode on pencil click, Enter commits, Escape cancels, same-name no-op.
 *  - Delete: confirm dialog, recursive flag for directories, refetches on success.
 *  - Download: builds correct URL, uses an anchor element (NOT window.location.href
 *    so a server error response doesn't navigate the user away from the page).
 *  - Jobs tab: list rendering with status badges, cancel only for running jobs,
 *    View Log switches to Files tab and navigates to the log's directory.
 *  - Polling: jobs fetch fires every 5s while on Jobs tab; cleared on tab change/close.
 *  - Open/close lifecycle: no fetch when isOpen=false.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { FileSystemDrawer } from './FileSystemDrawer'

// ---------------------------------------------------------------------------
// Mock the shared Drawer wrapper - we don't care about its open/close animation,
// only that its children render. Keep the surface minimal to avoid coupling.
// ---------------------------------------------------------------------------
vi.mock('@/components/ui/Drawer', () => ({
  Drawer: ({ isOpen, children, title }: { isOpen: boolean; children: React.ReactNode; title?: React.ReactNode }) => (
    <div data-testid="drawer" data-open={isOpen ? 'true' : 'false'}>
      {title && <div data-testid="drawer-title">{title}</div>}
      {children}
    </div>
  ),
}))

// ---------------------------------------------------------------------------
// Mock useAlertModal. The real hook requires <AlertProvider> in the tree
// (mounted in app/layout.tsx in production). Tests assert that the right
// alert/confirm method was called instead of probing the modal DOM.
// dangerConfirm defaults to "user clicked Confirm"; override per-test if needed.
// vi.hoisted runs before the vi.mock factory, so the spies are stable refs.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string
  init?: RequestInit
}

let fetchCalls: FetchCall[] = []
let fetchHandler: (url: string, init?: RequestInit) => Promise<Response>

beforeEach(() => {
  fetchCalls = []
  fetchHandler = async () => new Response(JSON.stringify({ entries: [] }), { status: 200 })
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    fetchCalls.push({ url: urlStr, init })
    return fetchHandler(urlStr, init)
  }) as unknown as typeof fetch
  // Reset alert/confirm spies between tests (vi.restoreAllMocks clears history
  // on vi.fn but not on hoisted shared refs, so do it explicitly).
  alertSpies.alert.mockClear()
  alertSpies.alertError.mockClear()
  alertSpies.alertWarning.mockClear()
  alertSpies.confirm.mockClear().mockResolvedValue(true)
  alertSpies.dangerConfirm.mockClear().mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function setListResponse(entries: any[]) {
  fetchHandler = async (url) => {
    if (url.includes('/api/agent/workspace/list')) {
      return new Response(JSON.stringify({ entries }), { status: 200 })
    }
    if (url.includes('/api/agent/workspace/jobs')) {
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
}

function setJobsResponse(jobs: any[]) {
  fetchHandler = async (url) => {
    if (url.includes('/api/agent/workspace/jobs')) {
      return new Response(JSON.stringify({ jobs }), { status: 200 })
    }
    return new Response(JSON.stringify({ entries: [] }), { status: 200 })
  }
}

// Non-protected user dir + 2 files. Tests that depend on Rename/Delete
// being present on every entry would break if we used a protected default
// subdir like `notes` at index 0.
const sampleEntries = [
  { name: 'my-dir', path: 'my-dir', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'a.txt', path: 'a.txt', isDir: false, isSymlink: false, size: 42, mtime: '2026-05-14T10:01:00Z' },
  { name: 'big.bin', path: 'big.bin', isDir: false, isSymlink: false, size: 5000, mtime: '2026-05-14T10:02:00Z' },
]

// Sample including a protected default subdir, for protection tests
const sampleEntriesWithProtected = [
  { name: 'notes', path: 'notes', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'tool-outputs', path: 'tool-outputs', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'my-dir', path: 'my-dir', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
  { name: 'free.txt', path: 'free.txt', isDir: false, isSymlink: false, size: 10, mtime: '2026-05-14T10:00:00Z' },
]

const sampleJobs = [
  {
    job_id: 'aaa111', project_id: 'p1', tool_name: 'execute_nuclei',
    args: { target: 'example.com' }, label: null, status: 'running',
    started_at: new Date(Date.now() - 30_000).toISOString(),
    ended_at: null, exit_code: null,
    output_path: '/workspace/p1/jobs/aaa111.log',
    error: null, size_bytes: 1024,
  },
  {
    job_id: 'bbb222', project_id: 'p1', tool_name: 'execute_hydra',
    args: {}, label: 'brute attempt', status: 'done',
    started_at: new Date(Date.now() - 120_000).toISOString(),
    ended_at: new Date(Date.now() - 60_000).toISOString(), exit_code: 0,
    output_path: '/workspace/p1/jobs/bbb222.log',
    error: null, size_bytes: 8192,
  },
]

// ---------------------------------------------------------------------------
// Rendering + tab switching
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: rendering + tabs', () => {
  test('renders both tabs with Files selected by default', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    expect(screen.getByText('Files')).toBeInTheDocument()
    expect(screen.getByText('Jobs')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
  })

  test('switching to Jobs tab triggers jobs fetch', async () => {
    setJobsResponse(sampleJobs)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    fireEvent.click(screen.getByText('Jobs'))
    await waitFor(() => {
      expect(fetchCalls.some(c => c.url.includes('/api/agent/workspace/jobs'))).toBe(true)
    })
    await waitFor(() => expect(screen.getByText('execute_nuclei')).toBeInTheDocument())
  })

  test('does not fetch when isOpen=false', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={false} onClose={() => {}} projectId="p1" />)
    // Give a moment for any stray fetches
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Files tab behaviour
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: Files tab', () => {
  test('clicking a directory navigates into it and refetches', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('my-dir')).toBeInTheDocument())
    fireEvent.click(screen.getByText('my-dir'))
    await waitFor(() => {
      const lastList = fetchCalls.filter(c => c.url.includes('/api/agent/workspace/list')).pop()
      expect(lastList?.url).toContain('path=my-dir')
    })
  })

  test('parent-dir entry (..) navigates up', async () => {
    setListResponse([{ name: 'inside.txt', path: 'notes/sub/inside.txt', isDir: false, isSymlink: false, size: 1, mtime: '2026-05-14T10:00:00Z' }])
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" initialPath="notes/sub" />)
    await waitFor(() => expect(screen.getByText('inside.txt')).toBeInTheDocument())
    // The parent-dir entry is rendered as ".."
    fireEvent.click(screen.getByText('..'))
    await waitFor(() => {
      const lastList = fetchCalls.filter(c => c.url.includes('/api/agent/workspace/list')).pop()
      expect(lastList?.url).toContain('path=notes')
      expect(lastList?.url).not.toContain('path=notes%2Fsub')
    })
  })

  test('empty list shows (empty)', async () => {
    setListResponse([])
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('(empty)')).toBeInTheDocument())
  })

  test('error state surfaces the error message', async () => {
    fetchHandler = async () => new Response(JSON.stringify({ error: 'path escapes workspace' }), { status: 400 })
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText(/path escapes workspace/)).toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: rename', () => {
  test('clicking pencil shows inline input', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    const renameBtn = screen.getAllByTitle('Rename')[1]  // a.txt's pencil (entry[0] is notes dir)
    fireEvent.click(renameBtn)
    const input = await screen.findByDisplayValue('a.txt')
    expect(input).toBeInTheDocument()
  })

  test('Enter commits via POST /api/agent/workspace/rename', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('Rename')[1])
    const input = await screen.findByDisplayValue('a.txt')
    fireEvent.change(input, { target: { value: 'renamed.txt' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      const renameCall = fetchCalls.find(c => c.url.includes('/api/agent/workspace/rename'))
      expect(renameCall).toBeDefined()
      expect(renameCall?.init?.method).toBe('POST')
      const body = JSON.parse(renameCall!.init!.body as string)
      expect(body).toEqual({ projectId: 'p1', path: 'a.txt', newName: 'renamed.txt' })
    })
  })

  test('Escape cancels without firing a rename request', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('Rename')[1])
    const input = await screen.findByDisplayValue('a.txt')
    fireEvent.change(input, { target: { value: 'new.txt' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchCalls.some(c => c.url.includes('/workspace/rename'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: delete (modal flow)', () => {
  test('clicking trash opens the confirmation modal (no immediate DELETE)', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('Delete')[1])  // a.txt's trash
    // Modal title appears
    await screen.findByText('Delete file?')
    // No DELETE fired yet
    expect(fetchCalls.some(c => c.init?.method === 'DELETE')).toBe(false)
  })

  test('Cancel button in modal suppresses the DELETE', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('Delete')[1])
    await screen.findByText('Delete file?')
    fireEvent.click(screen.getByText('Cancel'))
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchCalls.some(c => c.init?.method === 'DELETE')).toBe(false)
  })

  test('confirming a folder delete uses recursive=true', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('my-dir')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('Delete')[0])  // my-dir (folder)
    // Modal calls it "folder" and warns about contents
    await screen.findByText('Delete folder?')
    expect(screen.getByText(/all its contents/)).toBeInTheDocument()
    // Click the danger "Delete" button (modal action, not row action)
    const modalButtons = screen.getAllByRole('button', { name: 'Delete' })
    fireEvent.click(modalButtons[modalButtons.length - 1])  // modal action is the last one
    await waitFor(() => {
      const del = fetchCalls.find(c => c.init?.method === 'DELETE')
      expect(del?.url).toContain('recursive=true')
      expect(del?.url).toContain('path=my-dir')
    })
  })

  test('confirming a file delete uses recursive=false', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('Delete')[1])  // a.txt
    await screen.findByText('Delete file?')
    const modalButtons = screen.getAllByRole('button', { name: 'Delete' })
    fireEvent.click(modalButtons[modalButtons.length - 1])
    await waitFor(() => {
      const del = fetchCalls.find(c => c.init?.method === 'DELETE')
      expect(del?.url).toContain('recursive=false')
      expect(del?.url).toContain('path=a.txt')
    })
  })
})


// ---------------------------------------------------------------------------
// Stage B: protected default subdirs
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: protected default subdirs', () => {
  test('protected default subdirs show lock badge, no rename/delete', async () => {
    setListResponse(sampleEntriesWithProtected)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())

    // 2 protected entries (notes, tool-outputs) + 1 non-protected dir +
    // 1 file. Rename/Delete should appear for the latter two only.
    // my-dir (non-protected dir) has rename+delete
    // free.txt (non-protected file) has rename+delete
    // → exactly 2 Rename buttons and 2 Delete buttons
    expect(screen.getAllByTitle('Rename')).toHaveLength(2)
    expect(screen.getAllByTitle('Delete')).toHaveLength(2)
  })

  test('protected subdir shows the lock indicator tooltip', async () => {
    setListResponse(sampleEntriesWithProtected)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())
    // At least 2 lock badges (one per protected entry)
    expect(screen.getAllByTitle(/Protected default folder/)).toHaveLength(2)
  })

  test('protected subdir is still clickable to navigate INTO it', async () => {
    setListResponse(sampleEntriesWithProtected)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())
    fireEvent.click(screen.getByText('notes'))
    await waitFor(() => {
      const lastList = fetchCalls.filter(c => c.url.includes('/workspace/list')).pop()
      expect(lastList?.url).toContain('path=notes')
    })
  })
})


// ---------------------------------------------------------------------------
// Stage B: new folder
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: new folder (mkdir)', () => {
  test('clicking the + folder button shows an inline input', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('New folder in current directory'))
    expect(await screen.findByPlaceholderText('new folder name')).toBeInTheDocument()
  })

  test('Enter commits via POST /api/agent/workspace/mkdir', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('New folder in current directory'))
    const input = await screen.findByPlaceholderText('new folder name')
    fireEvent.change(input, { target: { value: 'scratch' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      const call = fetchCalls.find(c => c.url.includes('/api/agent/workspace/mkdir'))
      expect(call).toBeDefined()
      expect(call?.init?.method).toBe('POST')
      const body = JSON.parse(call!.init!.body as string)
      expect(body).toEqual({ projectId: 'p1', path: 'scratch' })
    })
  })

  test('mkdir path is joined to currentPath (nested)', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" initialPath="notes/sub" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('New folder in current directory'))
    const input = await screen.findByPlaceholderText('new folder name')
    fireEvent.change(input, { target: { value: 'deeper' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      const call = fetchCalls.find(c => c.url.includes('/api/agent/workspace/mkdir'))
      const body = JSON.parse(call!.init!.body as string)
      expect(body.path).toBe('notes/sub/deeper')
    })
  })

  test('Escape cancels mkdir without firing a request', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('New folder in current directory'))
    const input = await screen.findByPlaceholderText('new folder name')
    fireEvent.change(input, { target: { value: 'cancelled' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchCalls.some(c => c.url.includes('/workspace/mkdir'))).toBe(false)
  })
})


// ---------------------------------------------------------------------------
// Stage B: upload (file picker)
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: upload', () => {
  test('upload streams the selected File to /api/agent/workspace/upload', async () => {
    // Track the most recent <input type="file"> created; the drawer creates
    // it on click and we need to fire `change` on it manually.
    let lastInput: HTMLInputElement | null = null
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'input') {
        lastInput = el as HTMLInputElement
        // Suppress the actual browser file picker
        ;(el as HTMLInputElement).click = vi.fn()
      }
      return el
    })

    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Upload file(s) to current directory'))
    expect(lastInput).not.toBeNull()

    // Synthesize a file selection event
    const fakeFile = new File(['hello'], 'upload.txt', { type: 'text/plain' })
    Object.defineProperty(lastInput!, 'files', { value: [fakeFile] })
    lastInput!.onchange?.(new Event('change'))

    await waitFor(() => {
      const call = fetchCalls.find(c => c.url.includes('/api/agent/workspace/upload'))
      expect(call).toBeDefined()
      expect(call?.init?.method).toBe('POST')
      const url = new URL(call!.url, 'http://localhost')
      expect(url.searchParams.get('projectId')).toBe('p1')
      expect(url.searchParams.get('path')).toBe('.')
      expect(url.searchParams.get('overwrite')).toBe('false')
      expect(url.searchParams.get('filename')).toBe('upload.txt')
      expect(call!.init!.body).toBe(fakeFile)
    })
  })

  test('409 response opens the overwrite confirm modal', async () => {
    // First response: 409 with code=exists. Drawer should NOT alert; it
    // should open the overwrite modal.
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/upload')) {
        return new Response(
          JSON.stringify({ error: 'exists', code: 'exists' }),
          { status: 409 }
        )
      }
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({ entries: sampleEntries }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    let lastInput: HTMLInputElement | null = null
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'input') {
        lastInput = el as HTMLInputElement
        ;(el as HTMLInputElement).click = vi.fn()
      }
      return el
    })

    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Upload file(s) to current directory'))
    const fakeFile = new File(['v'], 'a.txt', { type: 'text/plain' })
    Object.defineProperty(lastInput!, 'files', { value: [fakeFile] })
    lastInput!.onchange?.(new Event('change'))

    // Overwrite modal appears
    await screen.findByText('File already exists')
  })

  test('clicking Overwrite retries the upload with overwrite=true', async () => {
    let uploadCallCount = 0
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/upload')) {
        uploadCallCount++
        if (uploadCallCount === 1) {
          return new Response(
            JSON.stringify({ error: 'exists', code: 'exists' }),
            { status: 409 }
          )
        }
        return new Response(JSON.stringify({ path: 'a.txt' }), { status: 200 })
      }
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({ entries: sampleEntries }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    let lastInput: HTMLInputElement | null = null
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'input') {
        lastInput = el as HTMLInputElement
        ;(el as HTMLInputElement).click = vi.fn()
      }
      return el
    })

    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Upload file(s) to current directory'))
    const fakeFile = new File(['v'], 'a.txt', { type: 'text/plain' })
    Object.defineProperty(lastInput!, 'files', { value: [fakeFile] })
    lastInput!.onchange?.(new Event('change'))
    await screen.findByText('File already exists')
    fireEvent.click(screen.getByText('Overwrite'))

    await waitFor(() => {
      const uploadCalls = fetchCalls.filter(c => c.url.includes('/workspace/upload'))
      expect(uploadCalls.length).toBeGreaterThanOrEqual(2)
      const retry = uploadCalls[1]
      const retryUrl = new URL(retry.url, 'http://localhost')
      expect(retryUrl.searchParams.get('overwrite')).toBe('true')
      expect(retry.init?.body).toBe(fakeFile)
    })
  })
})


// ---------------------------------------------------------------------------
// Stage B: folder download (archive)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stage C: preview pane
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: preview pane', () => {
  function setPreviewResponse(payload: any) {
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({ entries: sampleEntries }), { status: 200 })
      }
      if (url.includes('/api/agent/workspace/preview')) {
        return new Response(JSON.stringify(payload), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
  }

  test('clicking a file row fetches preview and shows content', async () => {
    setPreviewResponse({
      path: 'a.txt', content: 'hello\nworld', isBinary: false,
      truncated: false, mime: 'text/plain', size: 11,
    })
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('a.txt'))
    // Preview request fires
    await waitFor(() => {
      const prev = fetchCalls.find(c => c.url.includes('/api/agent/workspace/preview'))
      expect(prev).toBeDefined()
      expect(prev!.url).toContain('path=a.txt')
    })
    // Content appears in the preview <pre>
    await waitFor(() => {
      expect(screen.getByText(/hello/)).toBeInTheDocument()
    })
  })

  test('clicking a folder navigates, does NOT open preview', async () => {
    setPreviewResponse({})
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('my-dir')).toBeInTheDocument())
    fireEvent.click(screen.getByText('my-dir'))
    await new Promise((r) => setTimeout(r, 50))
    // No preview request, just a directory list refetch
    expect(fetchCalls.some(c => c.url.includes('/api/agent/workspace/preview'))).toBe(false)
  })

  test('Back button returns to file list', async () => {
    setPreviewResponse({
      path: 'a.txt', content: 'hello', isBinary: false,
      truncated: false, mime: 'text/plain', size: 5,
    })
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('a.txt'))
    await waitFor(() => {
      expect(screen.getByText(/hello/)).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTitle('Back to files'))
    // File list is visible again
    await waitFor(() => {
      expect(screen.getByText('my-dir')).toBeInTheDocument()
    })
    // Preview content is gone
    expect(screen.queryByText('hello')).not.toBeInTheDocument()
  })

  test('truncation warning appears when truncated=true', async () => {
    setPreviewResponse({
      path: 'big.txt', content: 'first 1MB...', isBinary: false,
      truncated: true, mime: 'text/plain', size: 5_000_000,
    })
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('a.txt'))
    await waitFor(() => {
      expect(screen.getByText(/truncated/)).toBeInTheDocument()
    })
  })

  test('binary file shows download-instead hint, not base64 wall', async () => {
    setPreviewResponse({
      path: 'big.bin', content: 'AAECAwQ=', isBinary: true,
      truncated: false, mime: 'application/octet-stream', size: 5,
    })
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('big.bin')).toBeInTheDocument())
    fireEvent.click(screen.getByText('big.bin'))
    await waitFor(() => {
      expect(screen.getByText(/Binary file/)).toBeInTheDocument()
      expect(screen.getByText(/Use Download/)).toBeInTheDocument()
    })
    // Base64 string must NOT be displayed inline
    expect(screen.queryByText('AAECAwQ=')).not.toBeInTheDocument()
  })

  test('preview fetch error surfaces a clean error', async () => {
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({ entries: sampleEntries }), { status: 200 })
      }
      if (url.includes('/api/agent/workspace/preview')) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 400 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('a.txt'))
    await waitFor(() => {
      expect(screen.getByText(/Error.*not found/)).toBeInTheDocument()
    })
  })
})


// ---------------------------------------------------------------------------
// Stage C: properties popover
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: properties popover', () => {
  function setPropsResponse(payload: any) {
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({ entries: sampleEntries }), { status: 200 })
      }
      if (url.includes('/api/agent/workspace/properties')) {
        return new Response(JSON.stringify(payload), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
  }

  test('clicking Info opens the properties modal with sha256 for files', async () => {
    setPropsResponse({
      path: 'a.txt', type: 'file', size: 42, mtime: '2026-05-14T10:00:00+00:00',
      mode: '0o666', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    })
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle(/Properties/)[1])  // a.txt's Info button
    await waitFor(() => {
      expect(screen.getByText('SHA-256')).toBeInTheDocument()
      expect(screen.getByText(/2cf24dba/)).toBeInTheDocument()
    })
  })

  test('properties for dir omits sha256 row', async () => {
    setPropsResponse({
      path: 'my-dir', type: 'dir', size: 4096, mtime: '2026-05-14T10:00:00+00:00',
      mode: '0o777',
    })
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('my-dir')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle(/Properties/)[0])
    await waitFor(() => {
      expect(screen.getByText('Properties')).toBeInTheDocument()
    })
    // Dir entries don't have sha256 (backend omits it)
    expect(screen.queryByText('SHA-256')).not.toBeInTheDocument()
  })

  test('properties for symlink shows target', async () => {
    setPropsResponse({
      path: 'link', type: 'symlink', size: 0, mtime: '2026-05-14T10:00:00+00:00',
      mode: '0o777', target: '/etc/hosts',
    })
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle(/Properties/)[1])
    await waitFor(() => {
      expect(screen.getByText(/Symlink target/)).toBeInTheDocument()
      expect(screen.getByText('/etc/hosts')).toBeInTheDocument()
    })
  })

  test('Close button dismisses the properties modal', async () => {
    setPropsResponse({
      path: 'a.txt', type: 'file', size: 1, mtime: '2026-05-14T10:00:00+00:00', mode: '0o666',
    })
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle(/Properties/)[1])
    await waitFor(() => expect(screen.getByText('Properties')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Close'))
    await waitFor(() => {
      expect(screen.queryByText('Properties')).not.toBeInTheDocument()
    })
  })

  test('Info button is present for every row regardless of protection', async () => {
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({
          entries: [
            { name: 'notes', path: 'notes', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
            { name: 'my-dir', path: 'my-dir', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
            { name: 'a.txt', path: 'a.txt', isDir: false, isSymlink: false, size: 1, mtime: '2026-05-14T10:00:00Z' },
          ],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())
    // Info on every row including protected
    expect(screen.getAllByTitle(/Properties/)).toHaveLength(3)
  })
})


// ---------------------------------------------------------------------------
// Stage D: filter
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: filter', () => {
  test('typing in the filter input hides non-matching entries', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Filter files…'), {
      target: { value: 'big' },
    })
    // big.bin matches, a.txt + my-dir do not
    expect(screen.getByText('big.bin')).toBeInTheDocument()
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('my-dir')).not.toBeInTheDocument()
  })

  test('filter is case-insensitive', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Filter files…'), {
      target: { value: 'BIG' },
    })
    expect(screen.getByText('big.bin')).toBeInTheDocument()
  })

  test('empty filter result shows a hint', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Filter files…'), {
      target: { value: 'xyzzy-no-match' },
    })
    expect(screen.getByText(/No matches/)).toBeInTheDocument()
  })

  test('Clear filter button restores all entries', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Filter files…'), {
      target: { value: 'big' },
    })
    fireEvent.click(screen.getByTitle('Clear filter'))
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText('big.bin')).toBeInTheDocument()
  })

  test('navigating to a different path clears the filter', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    // Filter for 'my' so my-dir IS still visible to click
    fireEvent.change(screen.getByPlaceholderText('Filter files…'), {
      target: { value: 'my' },
    })
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('my-dir'))
    // After navigation, refetch + filter reset -> a.txt visible again
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    expect((screen.getByPlaceholderText('Filter files…') as HTMLInputElement).value).toBe('')
  })
})


// ---------------------------------------------------------------------------
// Stage D: sort
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: sort', () => {
  const sortSample = [
    // Intentionally unsorted; the renderer must reorder them.
    { name: 'beta.txt', path: 'beta.txt', isDir: false, isSymlink: false, size: 200, mtime: '2026-05-13T10:00:00Z' },
    { name: 'alpha.txt', path: 'alpha.txt', isDir: false, isSymlink: false, size: 50, mtime: '2026-05-15T10:00:00Z' },
    { name: 'gamma.txt', path: 'gamma.txt', isDir: false, isSymlink: false, size: 100, mtime: '2026-05-14T10:00:00Z' },
  ]

  function entryNamesInOrder(): string[] {
    return Array.from(document.querySelectorAll('[data-name]'))
      .map(el => el.getAttribute('data-name') || '')
  }

  test('default sort is by name ascending', async () => {
    setListResponse(sortSample)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('alpha.txt')).toBeInTheDocument())
    expect(entryNamesInOrder()).toEqual(['alpha.txt', 'beta.txt', 'gamma.txt'])
  })

  test('clicking Size header sorts by size ascending', async () => {
    setListResponse(sortSample)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('alpha.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^Size/ }))
    // alpha=50, gamma=100, beta=200
    expect(entryNamesInOrder()).toEqual(['alpha.txt', 'gamma.txt', 'beta.txt'])
  })

  test('clicking same column header toggles direction', async () => {
    setListResponse(sortSample)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('alpha.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^Size/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Size/ }))
    // descending: beta(200), gamma(100), alpha(50)
    expect(entryNamesInOrder()).toEqual(['beta.txt', 'gamma.txt', 'alpha.txt'])
  })

  test('sort by Modified uses ISO mtime comparison', async () => {
    setListResponse(sortSample)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('alpha.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^Modified/ }))
    // mtime asc: beta(05-13), gamma(05-14), alpha(05-15)
    expect(entryNamesInOrder()).toEqual(['beta.txt', 'gamma.txt', 'alpha.txt'])
  })

  test('dirs always sort above files regardless of column', async () => {
    setListResponse([
      { name: 'zzz-dir', path: 'zzz-dir', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-15T10:00:00Z' },
      { name: 'aaa-file.txt', path: 'aaa-file.txt', isDir: false, isSymlink: false, size: 999, mtime: '2026-05-15T10:00:00Z' },
    ])
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('aaa-file.txt')).toBeInTheDocument())
    // zzz-dir comes first even though aaa-file < zzz alphabetically
    expect(entryNamesInOrder()).toEqual(['zzz-dir', 'aaa-file.txt'])
  })
})


// ---------------------------------------------------------------------------
// Stage D: multi-select + bulk actions
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: multi-select + bulk', () => {
  test('clicking a checkbox toggles selection without navigating', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBe(3)  // 3 entries
    fireEvent.click(checkboxes[1])  // a.txt
    // No preview / no navigation happened
    const previewCalls = fetchCalls.filter(c => c.url.includes('/workspace/preview'))
    expect(previewCalls).toHaveLength(0)
    // Bulk bar appears
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  test('selecting multiple updates the counter', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[1])
    fireEvent.click(checkboxes[2])
    expect(screen.getByText('3 selected')).toBeInTheDocument()
  })

  test('Clear button clears selection + hides bulk bar', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Clear'))
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
  })

  test('bulk Download POSTs all selected paths to bulk-archive', async () => {
    const clickSpy = vi.fn()
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy
      return el
    })
    // bulk-archive returns a blob
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({ entries: sampleEntries }), { status: 200 })
      }
      if (url.includes('/api/agent/workspace/bulk-archive')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {
            'Content-Disposition': 'attachment; filename="bundle.tar.gz"',
            'Content-Type': 'application/gzip',
          },
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('checkbox')[1])  // a.txt
    fireEvent.click(screen.getAllByRole('checkbox')[2])  // big.bin
    // The bulk button uses a unique title; the per-row buttons use 'Download'
    fireEvent.click(screen.getByTitle(/Download selected as one tar\.gz/))

    await waitFor(() => {
      const bulk = fetchCalls.find(c => c.url.includes('/api/agent/workspace/bulk-archive'))
      expect(bulk).toBeDefined()
      const body = JSON.parse(bulk!.init!.body as string)
      expect(body.projectId).toBe('p1')
      expect(body.paths).toEqual(['a.txt', 'big.bin'])
      expect(body.format).toBe('tar.gz')
    })
    expect(clickSpy).toHaveBeenCalled()
  })

  test('bulk Delete opens confirm modal listing entries', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('checkbox')[1])  // a.txt
    fireEvent.click(screen.getAllByRole('checkbox')[2])  // big.bin
    fireEvent.click(screen.getByTitle(/Delete selected/))
    await screen.findByText(/Delete 2 entries\?/)
    // Each path appears in BOTH the entry list (background row) and the
    // modal's <li><code>. Confirm 2 occurrences each.
    expect(screen.getAllByText('a.txt').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('big.bin').length).toBeGreaterThanOrEqual(2)
  })

  test('bulk Delete confirm fires N DELETE calls + refetches', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getAllByRole('checkbox')[2])
    fireEvent.click(screen.getByTitle(/Delete selected/))
    await screen.findByText(/Delete 2 entries\?/)
    fireEvent.click(screen.getByRole('button', { name: /^Delete 2/ }))
    await waitFor(() => {
      const dels = fetchCalls.filter(c => c.init?.method === 'DELETE')
      expect(dels.length).toBe(2)
    })
  })

  test('bulk Delete with only-protected selection alerts + does NOT fire', async () => {
    setListResponse([
      { name: 'notes', path: 'notes', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
      { name: 'jobs', path: 'jobs', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
    ])
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByTitle(/Delete selected/))
    // The drawer now routes "nothing to delete" through alertWarning instead
    // of window.alert.
    expect(alertSpies.alertWarning).toHaveBeenCalled()
    expect(screen.queryByText(/Delete .* entries\?/)).not.toBeInTheDocument()
  })

  test('bulk Delete with mixed selection skips protected + warns in modal', async () => {
    setListResponse([
      { name: 'notes', path: 'notes', isDir: true, isSymlink: false, size: 0, mtime: '2026-05-14T10:00:00Z' },
      { name: 'free-file.txt', path: 'free-file.txt', isDir: false, isSymlink: false, size: 1, mtime: '2026-05-14T10:00:00Z' },
    ])
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('notes')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('checkbox')[0])  // notes (protected)
    fireEvent.click(screen.getAllByRole('checkbox')[1])  // free-file.txt
    fireEvent.click(screen.getByTitle(/Delete selected/))
    await screen.findByText(/Delete 1 entry\?/)
    expect(screen.getByText(/1 protected default folder/)).toBeInTheDocument()
  })
})


describe('FileSystemDrawer: folder download', () => {
  test('folder rows show an archive-download button', async () => {
    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('my-dir')).toBeInTheDocument())
    expect(screen.getAllByTitle(/Download folder as \.tar\.gz/)).toHaveLength(1)
  })

  test('file rows do NOT show an archive-download button', async () => {
    setListResponse([sampleEntries[1], sampleEntries[2]])  // files only
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    expect(screen.queryAllByTitle(/Download folder as/)).toHaveLength(0)
  })

  test('clicking folder download builds the correct archive URL via anchor', async () => {
    const clickSpy = vi.fn()
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy
      return el
    })

    setListResponse(sampleEntries)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('my-dir')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle(/Download folder as \.tar\.gz/))

    expect(clickSpy).toHaveBeenCalled()
    const lastAnchor = vi.mocked(document.createElement).mock.results.findLast(
      r => (r.value as HTMLElement).tagName === 'A'
    )?.value as HTMLAnchorElement | undefined
    expect(lastAnchor!.href).toContain('/api/agent/workspace/archive-download')
    expect(lastAnchor!.href).toContain('projectId=p1')
    expect(lastAnchor!.href).toContain('path=my-dir')
    expect(lastAnchor!.href).toContain('format=tar.gz')
    expect(lastAnchor!.download).toBe('my-dir.tar.gz')
  })
})

// ---------------------------------------------------------------------------
// Download - REGRESSION TEST: must not navigate the page on error
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: download', () => {
  test('download uses an anchor click, not window.location.href', async () => {
    // window.location.href = url would NAVIGATE THE PAGE if the server
    // returned an error response. An anchor element with download attribute
    // either downloads the file or downloads the JSON error - either way
    // the user stays on the page.
    setListResponse(sampleEntries)
    const createElementSpy = vi.spyOn(document, 'createElement')
    const locationSetter = vi.fn()
    // Track any attempt to set window.location.href
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new Proxy({} as any, {
        set: (_, prop, value) => {
          if (prop === 'href') locationSetter(value)
          return true
        },
        get: () => undefined,
      }),
    })

    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('Download')[0])  // a.txt download

    // Should have created an anchor
    const anchorCreates = createElementSpy.mock.calls.filter(c => c[0] === 'a')
    expect(anchorCreates.length).toBeGreaterThan(0)
    // Should NOT have set window.location.href
    expect(locationSetter).not.toHaveBeenCalled()
  })

  test('download URL forwards projectId and path', async () => {
    setListResponse(sampleEntries)
    const clickSpy = vi.fn()
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag)
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = clickSpy
      }
      return el
    })

    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="my-proj-id" />)
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('Download')[0])

    expect(clickSpy).toHaveBeenCalled()
    // The created anchor's href should contain the correct URL pieces
    const lastAnchor = vi.mocked(document.createElement).mock.results.findLast(
      r => (r.value as HTMLElement).tagName === 'A'
    )?.value as HTMLAnchorElement | undefined
    expect(lastAnchor).toBeDefined()
    expect(lastAnchor!.href).toContain('/api/agent/files')
    expect(lastAnchor!.href).toContain('projectId=my-proj-id')
    expect(lastAnchor!.href).toContain('path=a.txt')
  })
})

// ---------------------------------------------------------------------------
// Jobs tab
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: Jobs tab', () => {
  test('renders job rows with status badges', async () => {
    setJobsResponse(sampleJobs)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    fireEvent.click(screen.getByText('Jobs'))
    await waitFor(() => expect(screen.getByText('execute_nuclei')).toBeInTheDocument())
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.getByText('brute attempt')).toBeInTheDocument()  // uses label when set
  })

  test('Cancel button shows for running jobs only', async () => {
    setJobsResponse(sampleJobs)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    fireEvent.click(screen.getByText('Jobs'))
    await waitFor(() => expect(screen.getByText('execute_nuclei')).toBeInTheDocument())
    // 2 jobs but only 1 running -> 1 Cancel button
    const cancelButtons = screen.queryAllByTitle('Cancel job')
    expect(cancelButtons.length).toBe(1)
  })

  test('Cancel confirms then POSTs to /workspace/jobs/<id>/cancel', async () => {
    // dangerConfirm defaults to resolve(true) in beforeEach.
    setJobsResponse(sampleJobs)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    fireEvent.click(screen.getByText('Jobs'))
    await waitFor(() => expect(screen.getByText('execute_nuclei')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Cancel job'))
    await waitFor(() => {
      const cancelCall = fetchCalls.find(c =>
        c.url.includes('/workspace/jobs/aaa111/cancel') && c.init?.method === 'POST'
      )
      expect(cancelCall).toBeDefined()
    })
    expect(alertSpies.dangerConfirm).toHaveBeenCalled()
  })

  test('View Log switches to Files tab pointing at the jobs/ dir', async () => {
    setJobsResponse(sampleJobs)
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    fireEvent.click(screen.getByText('Jobs'))
    await waitFor(() => expect(screen.getByText('execute_nuclei')).toBeInTheDocument())
    fireEvent.click(screen.getAllByTitle('View log in Files tab')[0])
    // Now back on Files tab
    await waitFor(() => {
      const lastList = fetchCalls.filter(c => c.url.includes('/api/agent/workspace/list')).pop()
      expect(lastList?.url).toContain('path=jobs')
    })
  })

  test('View Log gracefully handles a job with empty output_path', async () => {
    setJobsResponse([{ ...sampleJobs[0], output_path: '' }])
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    fireEvent.click(screen.getByText('Jobs'))
    await waitFor(() => expect(screen.getByText('execute_nuclei')).toBeInTheDocument())
    // Should not throw; falls back to navigating to 'jobs'
    fireEvent.click(screen.getAllByTitle('View log in Files tab')[0])
    await waitFor(() => {
      const lastList = fetchCalls.filter(c => c.url.includes('/api/agent/workspace/list')).pop()
      expect(lastList?.url).toContain('path=jobs')
    })
  })
})

// ---------------------------------------------------------------------------
// Polling lifecycle
// ---------------------------------------------------------------------------

describe('FileSystemDrawer: polling lifecycle', () => {
  test('jobs tab polls every 5s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setJobsResponse([])
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    fireEvent.click(screen.getByText('Jobs'))
    await vi.waitFor(() => {
      const jobCalls = fetchCalls.filter(c => c.url.includes('/api/agent/workspace/jobs'))
      expect(jobCalls.length).toBeGreaterThanOrEqual(1)
    })
    const before = fetchCalls.filter(c => c.url.includes('/workspace/jobs')).length
    await act(async () => { vi.advanceTimersByTime(5500) })
    const after = fetchCalls.filter(c => c.url.includes('/workspace/jobs')).length
    expect(after).toBeGreaterThan(before)
  })

  test('switching back to Files clears the jobs polling interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setJobsResponse([])
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    fireEvent.click(screen.getByText('Jobs'))
    await vi.waitFor(() => {
      expect(fetchCalls.some(c => c.url.includes('/workspace/jobs'))).toBe(true)
    })
    fireEvent.click(screen.getByText('Files'))
    const before = fetchCalls.filter(c => c.url.includes('/workspace/jobs')).length
    await act(async () => { vi.advanceTimersByTime(10_000) })
    const after = fetchCalls.filter(c => c.url.includes('/workspace/jobs')).length
    // No additional jobs polls after switching away
    expect(after).toBe(before)
  })

  test('Files tab also polls every 5s while open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setListResponse([])
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await vi.waitFor(() => {
      const listCalls = fetchCalls.filter(c => c.url.includes('/api/agent/workspace/list'))
      expect(listCalls.length).toBeGreaterThanOrEqual(1)
    })
    const before = fetchCalls.filter(c => c.url.includes('/workspace/list')).length
    await act(async () => { vi.advanceTimersByTime(5500) })
    const after = fetchCalls.filter(c => c.url.includes('/workspace/list')).length
    expect(after).toBeGreaterThan(before)
  })

  test('Files-tab polling pauses while previewing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({ entries: sampleEntries }), { status: 200 })
      }
      if (url.includes('/api/agent/workspace/preview')) {
        return new Response(JSON.stringify({
          path: 'a.txt', content: 'hi', isBinary: false,
          truncated: false, mime: 'text/plain', size: 2,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await vi.waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('a.txt'))
    await vi.waitFor(() => expect(screen.getByText(/hi/)).toBeInTheDocument())
    const before = fetchCalls.filter(c => c.url.includes('/workspace/list')).length
    await act(async () => { vi.advanceTimersByTime(15_000) })
    const after = fetchCalls.filter(c => c.url.includes('/workspace/list')).length
    // No new list calls while preview is open
    expect(after).toBe(before)
  })

  test('Files-tab polling resumes after closing preview', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchHandler = async (url) => {
      if (url.includes('/api/agent/workspace/list')) {
        return new Response(JSON.stringify({ entries: sampleEntries }), { status: 200 })
      }
      if (url.includes('/api/agent/workspace/preview')) {
        return new Response(JSON.stringify({
          path: 'a.txt', content: 'hi', isBinary: false,
          truncated: false, mime: 'text/plain', size: 2,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    render(<FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />)
    await vi.waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    fireEvent.click(screen.getByText('a.txt'))
    await vi.waitFor(() => expect(screen.getByText(/hi/)).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Back to files'))
    await vi.waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    const before = fetchCalls.filter(c => c.url.includes('/workspace/list')).length
    await act(async () => { vi.advanceTimersByTime(5500) })
    const after = fetchCalls.filter(c => c.url.includes('/workspace/list')).length
    expect(after).toBeGreaterThan(before)
  })

  test('closing drawer clears the polling interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setJobsResponse([])
    const { rerender } = render(
      <FileSystemDrawer isOpen={true} onClose={() => {}} projectId="p1" />
    )
    fireEvent.click(screen.getByText('Jobs'))
    await vi.waitFor(() => {
      expect(fetchCalls.some(c => c.url.includes('/workspace/jobs'))).toBe(true)
    })
    rerender(<FileSystemDrawer isOpen={false} onClose={() => {}} projectId="p1" />)
    const before = fetchCalls.filter(c => c.url.includes('/workspace/jobs')).length
    await act(async () => { vi.advanceTimersByTime(10_000) })
    const after = fetchCalls.filter(c => c.url.includes('/workspace/jobs')).length
    expect(after).toBe(before)
  })
})
