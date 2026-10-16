import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

const PORT = Number(process.env.PORT || 8018)
const ARTIFACT_ROOT = path.resolve(process.env.REAMON_ARTIFACTS_PATH || '/data/reamon-artifacts')
const DERIVED_ROOT = path.resolve(process.env.REAMON_DERIVED_PATH || '/data/reamon-derived')
const TIMEOUT_MS = boundedNumber('UNLUAC_RS_TIMEOUT_MS', 180_000, 10_000, 600_000)
const MAX_INPUT_BYTES = boundedNumber('UNLUAC_RS_MAX_INPUT_BYTES', 16 * 1024 * 1024, 1024, 128 * 1024 * 1024)
const MAX_OUTPUT_BYTES = boundedNumber('UNLUAC_RS_MAX_OUTPUT_BYTES', 32 * 1024 * 1024, 1024, 64 * 1024 * 1024)
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TOOL_VERSION = 'unluac-rs@1.3.1'

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
  if (!Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024) throw new AnalysisError('Request body size is invalid')
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > 32 * 1024) throw new AnalysisError('Request body size is invalid')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AnalysisError('Invalid JSON')
  }
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

async function resolveInput(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new AnalysisError('Invalid Lua bytecode path')
  let candidate
  try {
    candidate = await realpath(value)
  } catch {
    throw new AnalysisError('Input is not available in the read-only artifact volume')
  }
  if (!isWithin(ARTIFACT_ROOT, candidate)) throw new AnalysisError('Input is outside the read-only artifact volume')
  const info = await stat(candidate)
  if (!info.isFile() || info.size < 5 || info.size > MAX_INPUT_BYTES) throw new AnalysisError('Lua bytecode size is outside the configured limit')
  const prefix = Buffer.alloc(5)
  const file = await open(candidate, 'r')
  try {
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0)
    if (bytesRead !== prefix.length || prefix[0] !== 0x1b || prefix.toString('ascii', 1, 4) !== 'Lua' || prefix[4] !== 0x55) {
      throw new AnalysisError('Input is not Lua 5.5 bytecode')
    }
  } finally {
    await file.close()
  }
  return { candidate, size: info.size }
}

function runDecompiler(bytes, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { bytes },
      resourceLimits: { maxOldGenerationSizeMb: 384, stackSizeMb: 4 },
    })
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      void worker.terminate()
      finish(reject, new AnalysisError('Lua decompilation was cancelled'))
    }
    const timeout = setTimeout(() => {
      void worker.terminate()
      finish(reject, new AnalysisError(`Lua decompilation exceeded the ${TIMEOUT_MS / 1000} second limit`))
    }, TIMEOUT_MS)
    worker.once('message', (message) => {
      if (message?.ok && typeof message.source === 'string' && Array.isArray(message.functions)
        && message.functions.length <= 100 && Number.isSafeInteger(message.protoCount)
        && message.protoCount >= message.functions.length && typeof message.metadataTruncated === 'boolean') finish(resolve, message)
      else finish(reject, new AnalysisError(typeof message?.error === 'string' ? message.error.slice(0, 1000) : 'Lua bytecode could not be decompiled'))
    })
    worker.once('error', (error) => finish(reject, error))
    worker.once('exit', (code) => {
      if (code !== 0 || !settled) finish(reject, new AnalysisError(`unluac-rs worker exited with status ${code}`))
    })
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function analyze(body, signal) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AnalysisError('Request must be an object')
  const projectId = safeId(body.projectId)
  const artifactId = safeId(body.artifactId)
  const taskId = safeId(body.taskId)
  const runId = safeId(body.runId)
  const input = await resolveInput(body.artifactPath)
  if (typeof body.artifactRelativePath !== 'string' || !body.artifactRelativePath || body.artifactRelativePath.length > 1000) {
    throw new AnalysisError('Lua bytecode logical path is invalid')
  }
  const relativePath = body.artifactRelativePath.replaceAll('\\', '/')
  const bytes = await readFile(input.candidate)
  if (bytes.length > MAX_INPUT_BYTES) throw new AnalysisError('Lua bytecode size is outside the configured limit')
  const decompilation = await runDecompiler(bytes, signal)
  const source = decompilation.source
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  if (sourceBytes <= 0 || sourceBytes > MAX_OUTPUT_BYTES) throw new AnalysisError('Decompiled Lua source exceeded the configured output limit')

  const sourceKey = createHash('sha256').update(relativePath).digest('hex').slice(0, 16)
  const basename = path.posix.basename(relativePath, path.posix.extname(relativePath)).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'module'
  const relativeOutput = `${projectId}/${artifactId}/${taskId}/${runId}/unluac-rs/${sourceKey}/${basename}.lua`
  const outputPath = path.join(DERIVED_ROOT, ...relativeOutput.split('/'))
  await mkdir(path.dirname(outputPath), { recursive: true })
  const resolvedOutputDirectory = await realpath(path.dirname(outputPath))
  if (!isWithin(DERIVED_ROOT, resolvedOutputDirectory) || resolvedOutputDirectory === DERIVED_ROOT) {
    throw new AnalysisError('Output directory is outside the derived-data volume')
  }
  const temporaryPath = `${outputPath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, source, { mode: 0o644, flag: 'wx' })
    await rename(temporaryPath, outputPath)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }

  return {
    status: 'completed',
    toolVersion: TOOL_VERSION,
    input: { relativePath, sha256: createHash('sha256').update(bytes).digest('hex') },
    unit: {
      name: `${basename}.lua`,
      relativePath,
      codeArtifactId: relativeOutput,
      sizeBytes: sourceBytes,
    },
    functions: decompilation.functions,
    protoCount: decompilation.protoCount,
    metadataTruncated: decompilation.metadataTruncated,
    codeBytes: sourceBytes,
    warnings: 'Lua 5.5 source was reconstructed by unluac-rs; original names and behavior are not guaranteed.',
  }
}

let busy = false
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    json(response, 200, { status: 'ok', toolVersion: TOOL_VERSION })
    return
  }
  if (request.method !== 'POST' || request.url !== '/analyze') {
    json(response, 404, { error: 'Not found' })
    return
  }
  if (busy) {
    json(response, 429, { error: 'The Lua 5.5 analyzer is busy' })
    return
  }
  busy = true
  const controller = new AbortController()
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  try {
    json(response, 200, await analyze(await readBody(request), controller.signal))
  } catch (error) {
    if (response.destroyed) return
    const message = error instanceof AnalysisError ? error.message : 'Lua 5.5 decompilation failed unexpectedly'
    json(response, error instanceof AnalysisError ? 422 : 500, { error: message.slice(0, 1000) })
  } finally {
    busy = false
  }
})

server.listen(PORT, '0.0.0.0')
