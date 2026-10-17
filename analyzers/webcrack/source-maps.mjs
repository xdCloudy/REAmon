import { createHash } from 'node:crypto'
import path from 'node:path'

const MAX_MAP_SOURCES = 500
const MAX_SECTIONS_PER_MAP = 500
const MAX_MAP_NODES = 1_024
const MAX_MAP_DEPTH = 8
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
  const sources = []
  const seen = new Set()
  const state = { recoveredBytes: 0, truncated: false, entriesSeen: 0, nodesSeen: 0, externalSections: 0, invalidMaps: 0, hasSources: false }
  function collect(map, depth = 0) {
    if (!map || typeof map !== 'object' || map.version !== 3) {
      state.invalidMaps += 1
      state.truncated = true
      return
    }
    state.nodesSeen += 1
    if (state.nodesSeen > MAX_MAP_NODES || depth > MAX_MAP_DEPTH) {
      state.truncated = true
      return
    }

    if (Array.isArray(map.sources)) {
      state.hasSources = true
      if (!Array.isArray(map.sourcesContent)) {
        state.truncated = true
      } else {
        const count = Math.min(map.sources.length, map.sourcesContent.length)
        if (map.sources.length !== map.sourcesContent.length) state.truncated = true
        for (let index = 0; index < count; index += 1) {
          state.entriesSeen += 1
          if (state.entriesSeen > MAX_MAP_SOURCES) {
            state.truncated = true
            return
          }
          const source = map.sources[index]
          const content = map.sourcesContent[index]
          if (typeof source !== 'string' || typeof content !== 'string') continue

          const relativeSourcePath = sourceName(map.sourceRoot, source)
          const language = sourceLanguage(relativeSourcePath)
          if (!language || seen.has(relativeSourcePath)) continue
          const sizeBytes = Buffer.byteLength(content, 'utf8')
          if (!sizeBytes || sizeBytes > MAX_SOURCE_BYTES || state.recoveredBytes + sizeBytes > maxOutputBytes) {
            state.truncated = true
            continue
          }
          seen.add(relativeSourcePath)
          state.recoveredBytes += sizeBytes
          sources.push({
            relativeSourcePath,
            language,
            content,
            sizeBytes,
            sourceSha256: digest(Buffer.from(content, 'utf8')),
          })
        }
      }
    }

    if (!Array.isArray(map.sections)) return
    const count = Math.min(map.sections.length, MAX_SECTIONS_PER_MAP)
    if (map.sections.length > MAX_SECTIONS_PER_MAP) state.truncated = true
    for (const section of map.sections.slice(0, count)) {
      if (section?.map && typeof section.map === 'object') collect(section.map, depth + 1)
      else if (typeof section?.url === 'string') state.externalSections += 1
    }
  }
  collect(parsed)

  const warningParts = sources.length
    ? ['Recovered source-map sources are build-provided sourceContent and may be stale or unrelated to the compiled artifact; review against the generated output.']
    : [state.hasSources ? 'The source map contains no supported TypeScript or JavaScript sourcesContent entries.' : 'The referenced source map contains no supported embedded source content.']
  if (state.invalidMaps) warningParts.push(`${state.invalidMaps} invalid embedded source-map section${state.invalidMaps === 1 ? ' was' : 's were'} skipped.`)
  if (state.externalSections) warningParts.push(`${state.externalSections} external indexed source-map section${state.externalSections === 1 ? ' was' : 's were'} skipped; only embedded section maps are read.`)
  return { sources, recoveredBytes: state.recoveredBytes, truncated: state.truncated, warning: warningParts.join(' ') }
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
