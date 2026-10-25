// Resolve a stored ai_transcript_ref (a path INSIDE the scan container) to the
// path where the webapp can read it, and refuse anything that escapes the output
// root (§9c). Pure + dependency-light so the traversal guard is unit-testable.
import path from 'path'

const posixPath = path.posix

// Where the scan container wrote the ref vs. where the webapp mounts it (ro).
export const CONTAINER_ROOT = '/app/ai_attack_surface_scan/output'
export const WEBAPP_ROOT = process.env.AI_ATTACK_OUTPUT_DIR || '/data/ai-attack-output'

// Only these native-report extensions are ever served.
const ALLOWED_EXT = new Set(['.json', '.jsonl', '.txt', '.html', '.log', '.md', '.csv'])

/**
 * Map a stored transcript ref to an absolute path under WEBAPP_ROOT, or return
 * null if the ref is missing, points outside the output root (path traversal),
 * or has a disallowed extension. Never throws.
 */
export function resolveTranscriptPath(ref: string | null | undefined): string | null {
  if (!ref || typeof ref !== 'string') return null
  const outputRoot = posixPath.resolve(WEBAPP_ROOT)
  const relativeTo = (root: string): string | null => {
    const normalizedRoot = posixPath.resolve(root)
    if (ref === normalizedRoot) return ''
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
    return ref.startsWith(prefix) ? ref.slice(normalizedRoot.length) : null
  }
  const rel = relativeTo(CONTAINER_ROOT) ?? relativeTo(outputRoot)
  if (rel === null || !ALLOWED_EXT.has(posixPath.extname(rel).toLowerCase())) return null

  // Resolve and confirm containment. path.resolve normalizes `.`/`..` lexically,
  // so any traversal collapses and the prefix check below rejects an escape.
  // (The mount is read-only and only holds tool output we write, so planted
  // symlinks are out of the threat model.)
  const candidate = posixPath.resolve(outputRoot, `.${rel.startsWith('/') ? rel : `/${rel}`}`)
  const prefix = outputRoot.endsWith('/') ? outputRoot : `${outputRoot}/`
  if (candidate !== outputRoot && !candidate.startsWith(prefix)) return null
  return candidate
}

// Content-type for the served native report (best-effort by extension).
// NB: HTML reports (e.g. garak's) can embed model output that itself contains
// attacker-controlled markup (echoed prompt-injection payloads). We never serve
// them as renderable text/html same-origin - see transcriptDisposition.
export function transcriptContentType(p: string): string {
  switch (posixPath.extname(p).toLowerCase()) {
    case '.json': return 'application/json'
    case '.csv': return 'text/csv'
    // .html is deliberately NOT 'text/html' - serve as text so it never renders.
    default: return 'text/plain'   // jsonl/txt/log/md/html render as inert text
  }
}

// Renderable HTML is forced to download (attachment) so it cannot execute in the
// webapp origin; inert types preview inline. Defends against transcript XSS.
export function transcriptDisposition(p: string): 'inline' | 'attachment' {
  return posixPath.extname(p).toLowerCase() === '.html' ? 'attachment' : 'inline'
}
