/**
 * Unit tests for the transcript path guard (§9c). The traversal/containment
 * checks are security-critical, so they are tested directly.
 */
import { describe, test, expect } from 'vitest'
import { resolveTranscriptPath, transcriptContentType, transcriptDisposition, CONTAINER_ROOT, WEBAPP_ROOT } from './aiAttackTranscript'

describe('resolveTranscriptPath', () => {
  test('maps a container ref under the output root to the webapp mount', () => {
    const ref = `${CONTAINER_ROOT}/run1/promptfoo/slug/promptfoo_results.json`
    expect(resolveTranscriptPath(ref)).toBe(`${WEBAPP_ROOT}/run1/promptfoo/slug/promptfoo_results.json`)
  })

  test('accepts a ref already under the webapp root', () => {
    const ref = `${WEBAPP_ROOT}/run1/garak/slug/garak_run.report.jsonl`
    expect(resolveTranscriptPath(ref)).toBe(ref)
  })

  test('rejects path traversal escaping the root', () => {
    expect(resolveTranscriptPath(`${CONTAINER_ROOT}/../../etc/passwd.json`)).toBeNull()
    expect(resolveTranscriptPath(`${CONTAINER_ROOT}/run1/../../../../etc/shadow.txt`)).toBeNull()
  })

  test('rejects refs outside any known root', () => {
    expect(resolveTranscriptPath('/etc/passwd')).toBeNull()
    expect(resolveTranscriptPath('/data/recon-output/x.json')).toBeNull()
    expect(resolveTranscriptPath(`${CONTAINER_ROOT}-backup/run1/report.json`)).toBeNull()
    expect(resolveTranscriptPath(`${WEBAPP_ROOT}-backup/run1/report.json`)).toBeNull()
  })

  test('rejects disallowed extensions', () => {
    expect(resolveTranscriptPath(`${CONTAINER_ROOT}/run1/tool/slug/evil.sh`)).toBeNull()
    expect(resolveTranscriptPath(`${CONTAINER_ROOT}/run1/tool/slug/binary`)).toBeNull()
  })

  test('rejects empty / non-string refs', () => {
    expect(resolveTranscriptPath('')).toBeNull()
    expect(resolveTranscriptPath(null)).toBeNull()
    expect(resolveTranscriptPath(undefined)).toBeNull()
  })

  test('allows the native-report extensions we actually write', () => {
    for (const ext of ['json', 'jsonl', 'txt', 'html', 'log', 'md', 'csv']) {
      expect(resolveTranscriptPath(`${CONTAINER_ROOT}/r/t/s/report.${ext}`)).not.toBeNull()
    }
  })
})

describe('transcriptContentType', () => {
  test('maps extensions to sensible content types', () => {
    expect(transcriptContentType('/x/a.json')).toBe('application/json')
    expect(transcriptContentType('/x/a.jsonl')).toBe('text/plain')   // jsonl renders as text
    expect(transcriptContentType('/x/a.csv')).toBe('text/csv')
    expect(transcriptContentType('/x/a.log')).toBe('text/plain')
  })

  test('NEVER serves html as renderable text/html (XSS guard)', () => {
    expect(transcriptContentType('/x/report.html')).toBe('text/plain')
  })
})

describe('transcriptDisposition', () => {
  test('forces html to download; everything else previews inline', () => {
    expect(transcriptDisposition('/x/report.html')).toBe('attachment')
    expect(transcriptDisposition('/x/a.json')).toBe('inline')
    expect(transcriptDisposition('/x/a.jsonl')).toBe('inline')
    expect(transcriptDisposition('/x/a.txt')).toBe('inline')
  })
})
