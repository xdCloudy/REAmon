const DEFAULT_ALERT_TIMEOUT_MS = 5_000
const MAX_ALERT_ERROR_LENGTH = 500
const MAX_ALERT_TOKEN_LENGTH = 512

export class WorkerAlertConfigurationError extends Error {}

export interface WorkerAlertConfig {
  url: string
  token?: string
}

export interface WorkerAlertInput {
  workerId: string
  recovered: number
  selected: number
  completed: number
  failed: number
  durationMs: number
  error?: string
}

export interface WorkerAlertResult {
  configured: boolean
  delivered: boolean
  reason?: 'healthy' | 'not_configured' | 'invalid_configuration' | 'delivery_failed'
}

export function readWorkerAlertConfig(env: Record<string, string | undefined> = process.env): WorkerAlertConfig | null {
  const rawUrl = env.REAMON_WORKER_ALERT_WEBHOOK_URL?.trim()
  if (!rawUrl) return null

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new WorkerAlertConfigurationError('REAMON_WORKER_ALERT_WEBHOOK_URL must be an absolute http(s) URL')
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new WorkerAlertConfigurationError('REAMON_WORKER_ALERT_WEBHOOK_URL must be an http(s) URL without credentials')
  }

  const token = env.REAMON_WORKER_ALERT_WEBHOOK_TOKEN?.trim()
  if (token && token.length > MAX_ALERT_TOKEN_LENGTH) {
    throw new WorkerAlertConfigurationError('REAMON_WORKER_ALERT_WEBHOOK_TOKEN is too long')
  }

  return { url: parsed.toString(), ...(token ? { token } : {}) }
}

function boundedError(error: string | undefined): string | undefined {
  const value = error?.trim()
  if (!value) return undefined
  return value.slice(0, MAX_ALERT_ERROR_LENGTH)
}

export async function notifyWorkerAlert(
  input: WorkerAlertInput,
  { fetchImpl = fetch, logger = console, env = process.env }: {
    fetchImpl?: typeof fetch
    logger?: Pick<Console, 'warn'>
    env?: Record<string, string | undefined>
  } = {},
): Promise<WorkerAlertResult> {
  if (input.failed <= 0 && !input.error?.trim()) return { configured: false, delivered: false, reason: 'healthy' }

  let config: WorkerAlertConfig | null
  try {
    config = readWorkerAlertConfig(env)
  } catch (error) {
    logger.warn(`[reamon-alert] invalid webhook configuration: ${error instanceof Error ? error.message : 'unknown error'}`)
    return { configured: false, delivered: false, reason: 'invalid_configuration' }
  }
  if (!config) return { configured: false, delivered: false, reason: 'not_configured' }

  const payload = {
    source: 'reamon',
    event: 'worker.degraded',
    severity: 'error',
    occurredAt: new Date().toISOString(),
    workerId: input.workerId,
    recovered: input.recovered,
    selected: input.selected,
    completed: input.completed,
    failed: input.failed,
    durationMs: input.durationMs,
    error: boundedError(input.error),
  }

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'REAmon-worker-alert/1',
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DEFAULT_ALERT_TIMEOUT_MS),
    })
    if (!response.ok) {
      logger.warn(`[reamon-alert] webhook returned HTTP ${response.status}`)
      return { configured: true, delivered: false, reason: 'delivery_failed' }
    }
    return { configured: true, delivered: true }
  } catch (error) {
    logger.warn(`[reamon-alert] webhook delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    return { configured: true, delivered: false, reason: 'delivery_failed' }
  }
}
