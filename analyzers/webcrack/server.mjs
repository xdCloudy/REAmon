import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { babelParserVersion } from './safe-renames.mjs'

const PORT = Number(process.env.PORT || 8015)
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_INPUT_BYTES = boundedNumber('WEBCRACK_MAX_INPUT_BYTES', 16 * 1024 * 1024, 1024, 64 * 1024 * 1024)
const MAX_OUTPUT_BYTES = boundedNumber('WEBCRACK_MAX_OUTPUT_BYTES', 64 * 1024 * 1024, 1024, 256 * 1024 * 1024)
const MAX_MODULES = boundedNumber('WEBCRACK_MAX_MODULES', 500, 1, 5000)
const MAX_SOURCE_MAP_BYTES = 8 * 1024 * 1024
const MAX_SOURCE_MAP_SET_BYTES = 16 * 1024 * 1024
const MAX_SOURCE_MAP_DOCUMENTS = 128
const TIMEOUT_MS = boundedNumber('WEBCRACK_TIMEOUT_MS', 120_000, 10_000, 600_000)
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function boundedNumber(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.floor(parsed))) : fallback
}

class AnalysisError extends Error {}

function safeId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new AnalysisError('Invalid analysis identifier')
  return value
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function readBody(request) {
  const size = Number(request.headers['content-length'] || 0)
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_REQUEST_BYTES) {
    throw new AnalysisError('Request body size is invalid')
  }
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_REQUEST_BYTES) throw new AnalysisError('Request body size is invalid')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}/`)
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function runWorker(code, stagingDirectory, signal, operation = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      void worker.terminate()
      finish(reject, new AnalysisError('JavaScript analysis was cancelled'))
    }
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { code, stagingDirectory, maxOutputBytes: MAX_OUTPUT_BYTES, maxModules: MAX_MODULES, ...operation },
      resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 },
    })
    const timeout = setTimeout(() => {
      void worker.terminate()
      finish(reject, new AnalysisError(`Webcrack exceeded the ${TIMEOUT_MS / 1000} second limit`))
    }, TIMEOUT_MS)
    worker.once('message', (message) => {
      if (message?.ok) finish(resolve, message.result)
      else finish(reject, new AnalysisError(message?.error || 'Webcrack could not process this source'))
    })
    worker.once('error', (error) => finish(reject, error))
    worker.once('exit', (code) => {
      if (code !== 0 || !settled) finish(reject, new AnalysisError(`Webcrack worker exited with status ${code}`))
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function resolveInput(value, extension) {
  const root = await realpath(process.env.REAMON_ARTIFACTS_PATH || '/data/reamon-artifacts')
  if (typeof value !== 'string' || !value || value.length > 4096) throw new AnalysisError('Invalid JavaScript artifact path')
  let candidate
  try {
    candidate = await realpath(value)
  } catch {
    throw new AnalysisError('Input is not available in the read-only artifact volume')
  }
  if (!isWithin(root, candidate)) throw new AnalysisError('Input is outside the read-only artifact volume')
  if (typeof extension !== 'string' || !['js', 'jsx', 'mjs', 'cjs'].includes(extension.toLowerCase().replace(/^\./, ''))) {
    throw new AnalysisError('Input profile must identify JavaScript source')
  }
  const info = await stat(candidate)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_INPUT_BYTES) throw new AnalysisError('JavaScript input size is outside the configured limit')
  const bytes = await readFile(candidate)
  let code
  try {
    code = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AnalysisError('Input is not valid UTF-8 JavaScript source')
  }
  return { candidate, bytes, code }
}

async function resolveSourceMap(input) {
  const directives = [...input.code.matchAll(/(?:\/\/[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)|\/\*[#@]\s*sourceMappingURL\s*=\s*([^*]+?)\s*\*\/)/g)]
  const url = directives.at(-1)?.[1]?.trim() || directives.at(-1)?.[2]?.trim() || ''
  if (!url) return null

  const bundleDirectory = path.dirname(input.candidate)
  const state = { totalBytes: 0, documents: [], documentByPath: new Map(), activePaths: new Set(), nodes: 0, warnings: [] }
  const readMapReference = async (reference, baseDirectory, inlineName) => {
    let bytes
    let absolutePath = ''
    let relativePath = inlineName
    if (/^data:/i.test(reference)) {
      const match = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(reference)
      if (!match) throw new AnalysisError('Source-map data URL must use application/json')
      bytes = match[1] ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]), 'utf8')
    } else {
      const decodedUrl = decodeURIComponent(reference)
      if (!decodedUrl || decodedUrl.length > 1_000 || /^[a-z][a-z0-9+.-]*:/i.test(decodedUrl)
          || path.isAbsolute(decodedUrl) || decodedUrl.startsWith('/') || decodedUrl.includes('\\')
          || decodedUrl.includes('?') || decodedUrl.includes('#')) {
        throw new AnalysisError('External source-map URLs must be relative local paths')
      }
      const candidate = path.resolve(baseDirectory, decodedUrl)
      if (!isWithin(bundleDirectory, candidate) || candidate === bundleDirectory) {
        throw new AnalysisError('External source map is outside the bundle directory')
      }
      absolutePath = await realpath(candidate)
      const info = await stat(absolutePath)
      if (!isWithin(bundleDirectory, absolutePath) || !info.isFile() || info.size <= 0 || info.size > MAX_SOURCE_MAP_BYTES) {
        throw new AnalysisError('External source map is outside the configured size or path limit')
      }
      relativePath = path.relative(bundleDirectory, absolutePath).replace(/\\/g, '/')
      const cached = state.documentByPath.get(absolutePath)
      if (cached) return cached
      bytes = await readFile(absolutePath)
    }

    if (!bytes.length || bytes.length > MAX_SOURCE_MAP_BYTES || state.totalBytes + bytes.length > MAX_SOURCE_MAP_SET_BYTES) {
      throw new AnalysisError('Source-map set is empty or exceeds the configured size limit')
    }
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new AnalysisError('Source map is not valid UTF-8')
    }
    let map
    try {
      map = JSON.parse(text)
    } catch {
      throw new AnalysisError('Source map is not valid JSON')
    }
    if (!map || typeof map !== 'object' || map.version !== 3) throw new AnalysisError('Source map is not a version 3 map')
    if (state.documents.length >= MAX_SOURCE_MAP_DOCUMENTS) {
      throw new AnalysisError('Indexed source-map document count exceeds the configured limit')
    }
    const document = { map, bytes, relativePath, sha256: digest(bytes), absolutePath }
    state.totalBytes += bytes.length
    state.documents.push(document)
    if (absolutePath) state.documentByPath.set(absolutePath, document)
    return document
  }
  const expandSections = async (document, depth = 0) => {
    state.nodes += 1
    if (state.nodes > 1_024 || depth > 8) {
      state.warnings.push('Indexed source-map expansion reached its section-depth or map-count limit.')
      return false
    }
    const map = document.map
    map.__reamonEvidence = { relativePath: document.relativePath, sha256: document.sha256, kind: depth ? 'section' : 'root' }
    if (!Array.isArray(map.sections)) return
    if (map.sections.length > 500) state.warnings.push('Indexed source-map sections were capped at 500 per map.')
    for (const section of map.sections.slice(0, 500)) {
      if (section?.map && typeof section.map === 'object') {
        await expandSections({ ...document, map: section.map }, depth + 1)
      } else if (typeof section?.url === 'string') {
        try {
          const child = await readMapReference(section.url, document.absolutePath ? path.dirname(document.absolutePath) : bundleDirectory, '<inline-section>')
          if (child.absolutePath && state.activePaths.has(child.absolutePath)) throw new AnalysisError('Indexed source-map section cycle')
          if (child.absolutePath) state.activePaths.add(child.absolutePath)
          let expanded
          try {
            expanded = await expandSections(child, depth + 1)
          } finally {
            if (child.absolutePath) state.activePaths.delete(child.absolutePath)
          }
          if (!expanded) throw new AnalysisError('Indexed source-map section exceeded expansion limits')
          section.map = child.map
          delete section.url
        } catch {
          state.warnings.push('Some external indexed source-map sections could not be loaded safely.')
        }
      }
    }
    return true
  }

  try {
    const root = await readMapReference(url, bundleDirectory, '<inline>')
    if (root.absolutePath) state.activePaths.add(root.absolutePath)
    await expandSections(root)
    if (root.absolutePath) state.activePaths.delete(root.absolutePath)
    return {
      text: JSON.stringify(root.map),
      bytes: root.bytes,
      relativePath: root.relativePath,
      sha256: root.sha256,
      sizeBytes: root.bytes.length,
      documents: state.documents.map(({ bytes, relativePath, sha256, absolutePath }) => ({ bytes, relativePath, sha256, absolutePath })),
      warning: state.warnings.join(' '),
    }
  } catch (error) {
    return {
      text: '',
      relativePath: '',
      sha256: '',
      sizeBytes: 0,
      documents: [],
      warning: `Source-map recovery was skipped: ${error instanceof AnalysisError ? error.message : 'the referenced local map could not be read safely'}.`,
    }
  }
}

async function analyze(body, signal) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AnalysisError('Request must be an object')
  const projectId = safeId(body.projectId)
  const artifactId = safeId(body.artifactId)
  const taskId = safeId(body.taskId)
  const runId = safeId(body.runId)
  const input = await resolveInput(body.artifactPath, body.extension)
  if (typeof body.artifactRelativePath !== 'string' || !body.artifactRelativePath || body.artifactRelativePath.length > 1000) {
    throw new AnalysisError('JavaScript logical path is invalid')
  }
  const sourcePath = body.artifactRelativePath.replace(/\\/g, '/')
  if (sourcePath.length > 1000) throw new AnalysisError('JavaScript artifact path exceeds the supported length')
  const sourceMap = await resolveSourceMap(input)

  const derivedRoot = await realpath(process.env.REAMON_DERIVED_PATH || '/data/reamon-derived')
  const sourceKey = digest(sourcePath).slice(0, 16)
  const outputRelativeRoot = `${projectId}/${artifactId}/${taskId}/${runId}/webcrack/${sourceKey}`
  const outputDirectory = `${derivedRoot}/${outputRelativeRoot}`
  await mkdir(outputDirectory, { recursive: true })
  const resolvedOutputDirectory = await realpath(outputDirectory)
  if (!isWithin(derivedRoot, resolvedOutputDirectory) || resolvedOutputDirectory === derivedRoot) {
    throw new AnalysisError('Output directory is outside the derived-data volume')
  }
  const stagingDirectory = await mkdtemp(`${resolvedOutputDirectory}/.webcrack-`)

  try {
    const result = await runWorker(input.code, stagingDirectory, signal, { sourceMap })
    let sourceMapArtifactId = ''
    const sourceMapSectionArtifacts = new Map()
    const savedEvidencePaths = new Set()
    for (const document of sourceMap?.documents || []) {
      const isRootMap = document.relativePath === sourceMap.relativePath && document.sha256 === sourceMap.sha256
      const evidenceRelativePath = isRootMap
        ? `evidence/source-map-${document.sha256.slice(0, 16)}.json`
        : `evidence/source-map-section-${digest(`${document.relativePath}\n${document.sha256}`).slice(0, 32)}.json`
      const evidencePath = path.resolve(resolvedOutputDirectory, evidenceRelativePath)
      if (!isWithin(resolvedOutputDirectory, evidencePath) || evidencePath === resolvedOutputDirectory) {
        throw new AnalysisError('Source-map evidence path is invalid')
      }
      if (!savedEvidencePaths.has(evidenceRelativePath)) {
        await mkdir(path.dirname(evidencePath), { recursive: true })
        await writeFile(evidencePath, document.bytes, { flag: 'wx' })
        savedEvidencePaths.add(evidenceRelativePath)
      }
      const evidenceArtifactId = `${outputRelativeRoot}/${evidenceRelativePath}`
      if (isRootMap) sourceMapArtifactId = evidenceArtifactId
      else sourceMapSectionArtifacts.set(`${document.relativePath}\n${document.sha256}`, evidenceArtifactId)
    }
    const rows = result.units.map((unit) => ({
      ...unit,
      codeArtifactId: `${outputRelativeRoot}/${unit.relativeName}`,
      ...(unit.origin === 'source-map' && sourceMapArtifactId ? { sourceMapArtifactId } : {}),
      ...(unit.origin === 'source-map' && unit.sourceMapSectionRelativePath && unit.sourceMapSectionSha256
        && sourceMapSectionArtifacts.has(`${unit.sourceMapSectionRelativePath}\n${unit.sourceMapSectionSha256}`)
        ? { sourceMapSectionArtifactId: sourceMapSectionArtifacts.get(`${unit.sourceMapSectionRelativePath}\n${unit.sourceMapSectionSha256}`) }
        : {}),
    }))
    for (const row of rows) {
      const destination = `${derivedRoot}/${row.codeArtifactId}`
      await mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true })
      await rename(`${stagingDirectory}/${row.relativeName}`, destination)
    }
    return {
      status: 'completed',
      toolVersion: '2.16.0',
      input: { relativePath: sourcePath, sha256: digest(input.bytes) },
      bundleType: result.bundleType,
      units: rows,
      codeBytes: result.codeBytes,
      truncated: result.truncated,
      sourceMap: result.sourceMap ? { ...result.sourceMap, artifactId: sourceMapArtifactId } : null,
      warnings: (result.warnings || '').slice(0, 4_000),
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}

let busy = false
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    json(response, 200, { status: 'ok', toolVersion: '2.16.0' })
    return
  }
  const operation = request.url === '/analyze'
    ? 'analyze'
    : request.url === '/rename/bindings'
      ? 'list-rename-bindings'
      : request.url === '/rename/apply'
        ? 'apply-safe-renames'
        : request.url === '/validate'
          ? 'validate-javascript-source'
        : ''
  if (request.method !== 'POST' || !operation) {
    json(response, 404, { error: 'Not found' })
    return
  }
  if (busy) {
    json(response, 429, { error: 'The JavaScript analyzer is busy' })
    return
  }
  busy = true
  const controller = new AbortController()
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  try {
    const body = await readBody(request)
    if (operation === 'analyze') {
      const result = await analyze(body, controller.signal)
      json(response, 200, result)
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.code !== 'string') {
      throw new AnalysisError('A JavaScript source string is required')
    }
    const result = await runWorker(body.code, '', controller.signal, {
      operation,
      expectedSha256: body.expectedSha256,
      renames: body.renames,
      parserVersion: babelParserVersion,
    })
    json(response, 200, result)
  } catch (error) {
    if (response.destroyed) return
    const invalidJson = error instanceof SyntaxError
    const message = error instanceof AnalysisError ? error.message : invalidJson ? 'Invalid JSON' : 'JavaScript deobfuscation failed unexpectedly'
    json(response, error instanceof AnalysisError ? 422 : invalidJson ? 400 : 500, { error: message.slice(0, 1000) })
  } finally {
    busy = false
  }
})

server.listen(PORT, '0.0.0.0')
