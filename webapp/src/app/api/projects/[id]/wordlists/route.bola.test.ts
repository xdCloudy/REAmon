/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  guardProjectStrict: vi.fn(),
  existsSync: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  guardProjectStrict: (...args: unknown[]) => h.guardProjectStrict(...args),
}))
vi.mock('fs', () => ({ existsSync: (...args: unknown[]) => h.existsSync(...args) }))
vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => h.mkdir(...args),
  readdir: (...args: unknown[]) => h.readdir(...args),
  stat: (...args: unknown[]) => h.stat(...args),
  unlink: (...args: unknown[]) => h.unlink(...args),
  writeFile: (...args: unknown[]) => h.writeFile(...args),
}))

import { DELETE, GET, POST } from './route'

const params = { params: Promise.resolve({ id: 'p1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.guardProjectStrict.mockResolvedValue(null)
  h.existsSync.mockReturnValue(false)
  h.mkdir.mockResolvedValue(undefined)
  h.readdir.mockResolvedValue([])
  h.stat.mockResolvedValue({ size: 12 })
  h.unlink.mockResolvedValue(undefined)
  h.writeFile.mockResolvedValue(undefined)
})

describe('project wordlist ownership', () => {
  test.each([
    ['GET', () => GET(new NextRequest('http://test'), params)],
    ['POST', () => POST(new NextRequest('http://test', { method: 'POST', body: new FormData() }), params)],
    ['DELETE', () => DELETE(new NextRequest('http://test?name=mine.txt', { method: 'DELETE' }), params)],
  ])('rejects cross-project %s before filesystem access', async (_method, invoke) => {
    h.guardProjectStrict.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
    const response = await invoke()
    expect(response.status).toBe(404)
    expect(h.existsSync).not.toHaveBeenCalled()
    expect(h.readdir).not.toHaveBeenCalled()
    expect(h.mkdir).not.toHaveBeenCalled()
    expect(h.unlink).not.toHaveBeenCalled()
    expect(h.writeFile).not.toHaveBeenCalled()
  })

  test('the owner can list their project wordlists', async () => {
    h.existsSync.mockReturnValue(true)
    h.readdir.mockResolvedValue(['mine.txt', 'ignored.json'])
    const response = await GET(new NextRequest('http://test'), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      wordlists: [{ name: 'mine.txt', path: '/app/recon/wordlists/p1/mine.txt', size: 12 }],
    })
  })
})
