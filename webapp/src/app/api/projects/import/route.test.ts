/**
 * D10 — project import zip-bomb caps: oversize upload -> 413; too many entries
 * or over-declared-uncompressed -> 400; a normal small export passes the caps.
 *
 * Run: npx vitest run --no-file-parallelism src/app/api/projects/import/route.test.ts
 * @vitest-environment node
 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import JSZip from 'jszip'
import path from 'path'

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: vi.fn().mockResolvedValue({ userId: 'u1', role: 'user' }),
}))
vi.mock('@/lib/prisma', () => ({ default: {} }))
vi.mock('@/app/api/graph/neo4j', () => ({ getGraphSession: vi.fn() }))
vi.mock('@/lib/orchestrator', () => ({ orchestratorFetch: vi.fn() }))

import { importedReportStoragePath, POST } from './route'

function formReq(file: File): NextRequest {
  const fd = new FormData()
  fd.set('file', file)
  // NextRequest accepts a FormData body; it sets the multipart boundary itself.
  return new NextRequest('http://localhost:3000/api/projects/import', {
    method: 'POST',
    body: fd,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('PROJECT_IMPORT_MAX_UPLOAD_BYTES', '2000')
  vi.stubEnv('PROJECT_IMPORT_MAX_ENTRIES', '3')
  vi.stubEnv('PROJECT_IMPORT_MAX_UNCOMPRESSED_BYTES', '4096')
})

describe('POST /api/projects/import (D10 caps)', () => {
  test('oversize upload -> 413', async () => {
    const big = new File(['A'.repeat(5000)], 'big.zip', { type: 'application/zip' })
    const res = await POST(formReq(big))
    expect(res.status).toBe(413)
  })

  test('too many entries -> 400', async () => {
    const zip = new JSZip()
    for (let i = 0; i < 10; i++) zip.file(`f${i}.txt`, 'x')
    const buf = await zip.generateAsync({ type: 'uint8array' })
    const f = new File([buf], 'many.zip', { type: 'application/zip' })
    const res = await POST(formReq(f))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/too many entries/)
  })

  test('over-declared uncompressed size -> 400', async () => {
    const zip = new JSZip()
    zip.file('big.txt', 'A'.repeat(8192)) // > 4096 cap
    const buf = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    const f = new File([buf], 'bomb.zip', { type: 'application/zip' })
    const res = await POST(formReq(f))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/decompresses too large/)
  })

  test('a small archive passes the caps (fails later on missing manifest, not the caps)', async () => {
    const zip = new JSZip()
    zip.file('a.txt', 'hi') // no manifest.json -> route returns 400 "missing manifest"
    const buf = await zip.generateAsync({ type: 'uint8array' })
    const f = new File([buf], 'small.zip', { type: 'application/zip' })
    const res = await POST(formReq(f))
    // NOT a cap rejection: the caps passed, so the error is the manifest check.
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/manifest/i)
  })
})

describe('imported report storage paths', () => {
  test('isolates identical report names across projects and rows', () => {
    const firstProject = importedReportStoragePath('project-a', 'report.html', 'row-a')
    const secondProject = importedReportStoragePath('project-b', 'report.html', 'row-b')
    const duplicateInFirstProject = importedReportStoragePath('project-a', 'report.html', 'row-c')

    expect(path.dirname(firstProject)).not.toBe(path.dirname(secondProject))
    expect(firstProject).not.toBe(duplicateInFirstProject)
    expect(path.basename(firstProject)).toBe('row-a-report.html')
  })
})
