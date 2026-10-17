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

  try {
    let bytes
    let relativePath = '<inline>'
    if (/^data:/i.test(url)) {
      const match = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(url)
      if (!match) throw new AnalysisError('The inline source map must use a JSON data URL')
      bytes = match[1] ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]), 'utf8')
    } else {
      const decodedUrl = decodeURIComponent(url)
      if (!decodedUrl || decodedUrl.length > 1_000 || /^[a-z][a-z0-9+.-]*:/i.test(decodedUrl)
          || decodedUrl.startsWith('/') || decodedUrl.includes('\\') || decodedUrl.includes('?') || decodedUrl.includes('#')) {
        throw new AnalysisError('The external source map URL must be a relative local path')
      }
      const segments = decodedUrl.split('/')
      if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new AnalysisError('The external source map URL contains an invalid path segment')
      }
      const sourceDirectory = path.dirname(input.candidate)
      const candidate = path.resolve(sourceDirectory, ...segments)
      if (!isWithin(sourceDirectory, candidate) || candidate === sourceDirectory) {
        throw new AnalysisError('The external source map is outside the bundle directory')
      }
      const resolved = await realpath(candidate)
      const info = await stat(resolved)
      if (!isWithin(sourceDirectory, resolved) || !info.isFile() || info.size <= 0 || info.size > MAX_SOURCE_MAP_BYTES) {
        throw new AnalysisError('The external source map is outside the configured size or path limit')
      }
      bytes = await readFile(resolved)
      relativePath = path.relative(sourceDirectory, resolved).replace(/\\/g, '/')
    }

    if (!bytes.length || bytes.length > MAX_SOURCE_MAP_BYTES) {
      throw new AnalysisError('The source map is empty or exceeds the configured size limit')
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text, bytes, relativePath, sha256: digest(bytes), sizeBytes: bytes.length, warning: '' }
  } catch (error) {
    return {
      text: '',
      relativePath: '',
      sha256: '',
      sizeBytes: 0,
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
    if (sourceMap?.bytes && sourceMap.sha256) {
      const evidenceRelativePath = `evidence/source-map-${sourceMap.sha256.slice(0, 16)}.json`
      const evidencePath = path.resolve(resolvedOutputDirectory, evidenceRelativePath)
      if (!isWithin(resolvedOutputDirectory, evidencePath) || evidencePath === resolvedOutputDirectory) {
        throw new AnalysisError('Source-map evidence path is invalid')
      }
      await mkdir(path.dirname(evidencePath), { recursive: true })
      await writeFile(evidencePath, sourceMap.bytes, { flag: 'wx' })
      sourceMapArtifactId = `${outputRelativeRoot}/${evidenceRelativePath}`
    }
    const rows = result.units.map((unit) => ({
      ...unit,
      codeArtifactId: `${outputRelativeRoot}/${unit.relativeName}`,
      ...(unit.origin === 'source-map' && sourceMapArtifactId ? { sourceMapArtifactId } : {}),
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
