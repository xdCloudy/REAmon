import prisma from '@/lib/prisma'

const DEFAULT_STALE_SECONDS = 90
const MAX_STALE_SECONDS = 60 * 60
const HISTORICAL_AFTER_SECONDS = 24 * 60 * 60
// Task execution heartbeats default to 60 seconds. Allow two intervals plus
// a small scheduling margin before treating a RUNNING task lease as stale.
const TASK_LEASE_FRESH_SECONDS = 150

function staleAfterSeconds(): number {
  const parsed = Number(process.env.REAMON_WORKER_STALE_SECONDS)
  if (!Number.isFinite(parsed)) return DEFAULT_STALE_SECONDS
  return Math.min(MAX_STALE_SECONDS, Math.max(15, Math.floor(parsed)))
}

export interface WorkerDispatchHealthInput {
  workerId: string
  recovered: number
  selected: number
  completed: number
  failed: number
  durationMs: number
  error?: string
}

export interface WorkerHealthStatusInput {
  workerId: string
  status: string
}

export interface WorkerTaskLivenessInput {
  status: string
  leaseHeartbeatAt: string | null
}

export function summarizeWorkerAttention(
  workers: WorkerHealthStatusInput[],
  tasks: WorkerTaskLivenessInput[] = [],
  now = Date.now(),
) {
  const responsive = workers.filter((worker) => worker.status !== 'STALE' && worker.status !== 'HISTORICAL')
  const degraded = responsive.filter((worker) => worker.status === 'DEGRADED')
  const historicalWorkerCount = workers.filter((worker) => worker.status === 'HISTORICAL').length
  const historicalSummary = historicalWorkerCount > 0 ? { historicalWorkerCount } : {}
  const recentStaleWorkers = workers.filter((worker) => worker.status === 'STALE')
  if (responsive.length > 0) return degraded.length ? { kind: 'degraded' as const, workers: degraded, ...historicalSummary } : null

  const freshRunningTasks = tasks.filter((task) => {
    if (task.status !== 'RUNNING' || !task.leaseHeartbeatAt) return false
    const heartbeatAt = Date.parse(task.leaseHeartbeatAt)
    return Number.isFinite(heartbeatAt) && heartbeatAt >= now - TASK_LEASE_FRESH_SECONDS * 1000
  }).length
  const queuedTasks = tasks.filter((task) => task.status === 'QUEUED').length
  if (freshRunningTasks > 0 && queuedTasks === 0) {
    return { kind: 'active-task' as const, workers: recentStaleWorkers, activeTaskCount: freshRunningTasks, ...historicalSummary }
  }
  if (freshRunningTasks > 0 && queuedTasks > 0) {
    return { kind: 'queued-with-active-task' as const, workers: recentStaleWorkers, activeTaskCount: freshRunningTasks, queuedTaskCount: queuedTasks, ...historicalSummary }
  }
  if (recentStaleWorkers.length > 0) {
    return queuedTasks > 0
      ? { kind: 'stale' as const, workers: recentStaleWorkers, queuedTaskCount: queuedTasks, ...historicalSummary }
      : { kind: 'stale' as const, workers: recentStaleWorkers, ...historicalSummary }
  }
  if (queuedTasks > 0) return { kind: 'unavailable' as const, workers: [], queuedTaskCount: queuedTasks, ...historicalSummary }
  return { kind: 'unavailable' as const, workers: [], ...historicalSummary }
}

export async function recordWorkerDispatch(input: WorkerDispatchHealthInput) {
  const now = new Date()
  const status = input.failed > 0 || input.error ? 'DEGRADED' : 'IDLE'
  return prisma.reamonWorker.upsert({
    where: { workerId: input.workerId },
    create: {
      workerId: input.workerId,
      status,
      lastSeenAt: now,
      lastDispatchAt: now,
      lastDispatchDurationMs: input.durationMs,
      lastRecovered: input.recovered,
      lastSelected: input.selected,
      lastCompleted: input.completed,
      lastFailed: input.failed,
      lastError: input.error || '',
    },
    update: {
      status,
      lastSeenAt: now,
      lastDispatchAt: now,
      lastDispatchDurationMs: input.durationMs,
      lastRecovered: input.recovered,
      lastSelected: input.selected,
      lastCompleted: input.completed,
      lastFailed: input.failed,
      lastError: input.error || '',
    },
  })
}

/** Refresh process liveness independently of synchronous task dispatches. */
export async function recordWorkerHeartbeat(workerId: string) {
  return prisma.reamonWorker.upsert({
    where: { workerId },
    create: {
      workerId,
      status: 'IDLE',
      lastSeenAt: new Date(),
    },
    update: {
      lastSeenAt: new Date(),
    },
  })
}

export async function getWorkerHeartbeatStatus(workerId: string, now = Date.now()) {
  const worker = await prisma.reamonWorker.findUnique({
    where: { workerId },
    select: { workerId: true, status: true, lastSeenAt: true },
  })
  if (!worker) return { healthy: false as const, workerId, reason: 'missing' as const }

  const ageMs = now - worker.lastSeenAt.getTime()
  const healthy = ageMs >= -5_000 && ageMs <= staleAfterSeconds() * 1000
  return {
    healthy,
    workerId: worker.workerId,
    status: worker.status,
    lastSeenAt: worker.lastSeenAt.toISOString(),
    ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
    ...(healthy ? {} : { reason: 'stale' as const }),
  }
}

export async function listWorkerHealth() {
  const workers = await prisma.reamonWorker.findMany({
    orderBy: { lastSeenAt: 'desc' },
    take: 50,
    select: {
      workerId: true,
      status: true,
      lastSeenAt: true,
      lastDispatchAt: true,
      lastDispatchDurationMs: true,
      lastRecovered: true,
      lastSelected: true,
      lastCompleted: true,
      lastFailed: true,
      lastError: true,
    },
  })
  const now = Date.now()
  const staleBefore = now - staleAfterSeconds() * 1000
  const historicalBefore = now - HISTORICAL_AFTER_SECONDS * 1000
  return workers.map((worker) => ({
    workerId: worker.workerId,
    status: worker.lastSeenAt.getTime() < historicalBefore
      ? 'HISTORICAL'
      : worker.lastSeenAt.getTime() < staleBefore ? 'STALE' : worker.status,
    lastSeenAt: worker.lastSeenAt.toISOString(),
    lastDispatchAt: worker.lastDispatchAt?.toISOString() || null,
    lastDispatchDurationMs: worker.lastDispatchDurationMs,
    lastRecovered: worker.lastRecovered,
    lastSelected: worker.lastSelected,
    lastCompleted: worker.lastCompleted,
    lastFailed: worker.lastFailed,
    lastError: worker.lastError,
  }))
}
