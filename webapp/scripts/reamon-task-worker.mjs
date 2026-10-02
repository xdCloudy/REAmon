import { pathToFileURL } from 'node:url'

const DEFAULT_POLL_SECONDS = 10
const DEFAULT_BATCH_SIZE = 1
const DEFAULT_STALE_AFTER_MINUTES = 30
const MAX_POLL_SECONDS = 300
const MAX_BATCH_SIZE = 10
const MAX_STALE_AFTER_MINUTES = 24 * 60
const MAX_WORKER_ID_LENGTH = 128
const MAX_PROJECTION_PAGES = 100

export class WorkerConfigurationError extends Error {}

function boundedNumber(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new WorkerConfigurationError(`Expected a finite number, received ${String(value)}`)
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function boundedWorkerId(value, fallback = 'reamon-worker') {
  const workerId = (value || fallback).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId) || workerId.length > MAX_WORKER_ID_LENGTH) {
    throw new WorkerConfigurationError('REAMON_WORKER_ID must be a bounded identifier')
  }
  return workerId
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
    workerId: boundedWorkerId(env.REAMON_WORKER_ID || env.HOSTNAME),
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
      workerId: config.workerId || 'reamon-worker',
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
    logger.info(`[reamon-worker:${config.workerId || 'reamon-worker'}] recovered=${result.recovered || 0} selected=${result.selected || 0} completed=${(result.results || []).length}`)
  }
  return result
}

export async function projectOnce(config, projectId, fetchImpl = fetch, logger = console, offset = 0, projectionRunId = null) {
  const body = { projectId, ...(offset > 0 ? { offset } : {}), ...(projectionRunId ? { projectionRunId } : {}) }
  const response = await fetchImpl(`${config.webappUrl}/api/internal/reamon/graph/project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key': config.internalKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })

  if (response.status === 401 || response.status === 403) {
    throw new WorkerConfigurationError(`Graph projection authentication rejected with HTTP ${response.status}`)
  }
  if (!response.ok) {
    logger.warn(`[reamon-worker] graph projection returned HTTP ${response.status} for project ${projectId}`)
    return null
  }
  const result = await response.json()
  logger.info(`[reamon-worker] projected project=${projectId} offset=${result.offset || 0} nodes=${result.nodes || 0} relationships=${result.relationships || 0}`)
  return result
}

async function projectAllPages(config, projectId, fetchImpl, logger) {
  let offset = 0
  let projectionRunId = null
  for (let page = 0; page < MAX_PROJECTION_PAGES; page += 1) {
    const result = await projectOnce(config, projectId, fetchImpl, logger, offset, projectionRunId)
    if (!result?.truncated) return
    if (typeof result.projectionRunId === 'string' && result.projectionRunId) projectionRunId = result.projectionRunId
    const nextOffset = Number(result.nextOffset)
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) {
      logger.warn(`[reamon-worker] graph projection returned an invalid continuation for project ${projectId}`)
      return
    }
    offset = nextOffset
  }
  logger.warn(`[reamon-worker] graph projection reached the ${MAX_PROJECTION_PAGES}-page safety limit for project ${projectId}`)
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function runWorker(config, { fetchImpl = fetch, sleepImpl = sleep, logger = console, shouldStop = () => false } = {}) {
  while (!shouldStop()) {
    try {
      const result = await dispatchOnce(config, fetchImpl, logger)
      const projectIds = [...new Set((result?.results || [])
        .filter((entry) => entry?.outcome === 'COMPLETED' && typeof entry.task?.projectId === 'string')
        .map((entry) => entry.task.projectId))]
      for (const projectId of projectIds) {
        await projectAllPages(config, projectId, fetchImpl, logger)
      }
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
  console.info(`[reamon-worker:${config.workerId}] polling every ${config.pollSeconds}s with batch size ${config.batchSize}`)
  await runWorker(config, { shouldStop: () => stopping })
  console.info('[reamon-worker] stopped')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[reamon-worker] ${error instanceof Error ? error.message : 'worker stopped unexpectedly'}`)
    process.exitCode = 1
  })
}
