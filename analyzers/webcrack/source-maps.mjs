import { createHash } from 'node:crypto'
import path from 'node:path'

const MAX_MAP_SOURCES = 500
const MAX_SOURCE_BYTES = 4 * 1024 * 1024

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sourceLanguage(sourcePath) {
  const pathWithoutQuery = sourcePath.split(/[?#]/, 1)[0].toLowerCase()
  if (pathWithoutQuery.endsWith('.tsx')) return 'TypeScript JSX'
  if (/\.(?:ts|mts|cts)$/.test(pathWithoutQuery)) return 'TypeScript'
  if (pathWithoutQuery.endsWith('.jsx')) return 'JavaScript JSX'
  if (/\.(?:js|mjs|cjs)$/.test(pathWithoutQuery)) return 'JavaScript'
  return null
}

function sourceName(sourceRoot, source) {
  const combined = [sourceRoot, source].filter((part) => typeof part === 'string' && part.length).join('/')
  const withoutScheme = combined.replace(/\\/g, '/').replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '').replace(/^\/+/, '')
  return withoutScheme.split('/').filter((part) => part && part !== '.').map((part) => part === '..' ? '_parent_' : part).join('/').slice(0, 2_000)
}

export function recoverSourcesFromMap(sourceMap, maxOutputBytes) {
  if (!sourceMap || typeof sourceMap !== 'object' || typeof sourceMap.text !== 'string') {
    return { sources: [], recoveredBytes: 0, truncated: false, warning: '' }
  }
  if (!sourceMap.text) return { sources: [], recoveredBytes: 0, truncated: false, warning: sourceMap.warning || '' }

  let parsed
  try {
    parsed = JSON.parse(sourceMap.text)
  } catch {
    return { sources: [], recoveredBytes: 0, truncated: false, warning: 'The referenced source map is not valid JSON.' }
  }
  if (!parsed || parsed.version !== 3 || !Array.isArray(parsed.sources) || !Array.isArray(parsed.sourcesContent)) {
    return { sources: [], recoveredBytes: 0, truncated: false, warning: 'The referenced source map has no version 3 sourcesContent table.' }
  }

  const sources = []
  const seen = new Set()
  let recoveredBytes = 0
  let truncated = false
  const count = Math.min(parsed.sources.length, parsed.sourcesContent.length, MAX_MAP_SOURCES)
  if (parsed.sources.length > MAX_MAP_SOURCES || parsed.sourcesContent.length > MAX_MAP_SOURCES) truncated = true

  for (let index = 0; index < count; index += 1) {
    const source = parsed.sources[index]
    const content = parsed.sourcesContent[index]
    if (typeof source !== 'string' || typeof content !== 'string') continue

    const relativeSourcePath = sourceName(parsed.sourceRoot, source)
    const language = sourceLanguage(relativeSourcePath)
    if (!language || seen.has(relativeSourcePath)) continue
    const sizeBytes = Buffer.byteLength(content, 'utf8')
    if (!sizeBytes || sizeBytes > MAX_SOURCE_BYTES || recoveredBytes + sizeBytes > maxOutputBytes) {
      truncated = true
      continue
    }
    seen.add(relativeSourcePath)
    recoveredBytes += sizeBytes
    sources.push({
      relativeSourcePath,
      language,
      content,
      sizeBytes,
      sourceSha256: digest(Buffer.from(content, 'utf8')),
    })
  }

  const warning = sources.length
    ? 'Recovered source-map sources are build-provided sourceContent and may be stale or unrelated to the compiled artifact; review against the generated output.'
    : 'The source map contains no supported TypeScript or JavaScript sourcesContent entries.'
  return { sources, recoveredBytes, truncated, warning }
}

export function sourceMapOutputPath(sourcePath) {
  const normalized = sourcePath.replace(/\\/g, '/')
  const basename = path.posix.basename(normalized.split(/[?#]/, 1)[0]) || 'source'
  const extension = path.posix.extname(basename).toLowerCase()
  const safeExtension = /^\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(extension) ? extension : '.js'
  const slug = basename.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[.-]+/, '').slice(0, 80) || 'source'
  const sourceId = digest(normalized).slice(0, 16)
  return `sources/${sourceId}-${slug}${safeExtension}`
}
