import { pathToFileURL } from 'node:url'

const DEFAULT_POLL_SECONDS = 10
const DEFAULT_BATCH_SIZE = 1
const DEFAULT_STALE_AFTER_MINUTES = 30
const MAX_POLL_SECONDS = 300
const MAX_BATCH_SIZE = 10
const MAX_STALE_AFTER_MINUTES = 24 * 60

export class WorkerConfigurationError extends Error {}

function boundedNumber(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new WorkerConfigurationError(`Expected a finite number, received ${String(value)}`)
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

export function readWorkerConfig(env = process.env) {
  const internalKey = env.INTERNAL_API_KEY?.trim()
  if (!internalKey || internalKey === 'changeme') {
    throw new WorkerConfigurationError('INTERNAL_API_KEY must be set to a non-default value')
  }

  const webappUrl = (env.REAMON_WORKER_WEBAPP_URL || 'http://webapp:3000').trim().replace(/\/$/, '')
  try {
    const parsedUrl = new URL(webappUrl)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('unsupported protocol')
  } catch {
    throw new WorkerConfigurationError('REAMON_WORKER_WEBAPP_URL must be an http(s) URL')
  }

  return {
    webappUrl,
    internalKey,
    pollSeconds: boundedNumber(env.REAMON_WORKER_POLL_SECONDS, DEFAULT_POLL_SECONDS, 5, MAX_POLL_SECONDS),
    batchSize: boundedNumber(env.REAMON_WORKER_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE),
    staleAfterMinutes: boundedNumber(env.REAMON_WORKER_STALE_AFTER_MINUTES, DEFAULT_STALE_AFTER_MINUTES, 5, MAX_STALE_AFTER_MINUTES),
  }
}

export async function dispatchOnce(config, fetchImpl = fetch, logger = console) {
  const response = await fetchImpl(`${config.webappUrl}/api/internal/reamon/tasks/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': config.internalKey },
    body: JSON.stringify({
      limit: config.batchSize,
      recoverStale: true,
      staleAfterMinutes: config.staleAfterMinutes,
    }),
    signal: AbortSignal.timeout(20_000),
  })

  if (response.status === 401 || response.status === 403) {
    throw new WorkerConfigurationError(`Worker authentication rejected with HTTP ${response.status}`)
  }
  if (!response.ok) {
    logger.warn(`[reamon-worker] dispatch returned HTTP ${response.status}`)
    return null
  }

  const result = await response.json()
  if (result.recovered || result.selected) {
    logger.info(`[reamon-worker] recovered=${result.recovered || 0} selected=${result.selected || 0} completed=${(result.results || []).length}`)
  }
  return result
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function runWorker(config, { fetchImpl = fetch, sleepImpl = sleep, logger = console, shouldStop = () => false } = {}) {
  while (!shouldStop()) {
    try {
      await dispatchOnce(config, fetchImpl, logger)
    } catch (error) {
      if (error instanceof WorkerConfigurationError) throw error
      logger.error('[reamon-worker] dispatch failed; will retry', error)
    }
    if (!shouldStop()) await sleepImpl(config.pollSeconds * 1000)
  }
}

async function main() {
  const config = readWorkerConfig()
  let stopping = false
  const stop = () => { stopping = true }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  console.info(`[reamon-worker] polling every ${config.pollSeconds}s with batch size ${config.batchSize}`)
  await runWorker(config, { shouldStop: () => stopping })
  console.info('[reamon-worker] stopped')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[reamon-worker] ${error instanceof Error ? error.message : 'worker stopped unexpectedly'}`)
    process.exitCode = 1
  })
}
