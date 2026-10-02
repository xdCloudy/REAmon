import prisma from '@/lib/prisma'

const DEFAULT_STALE_SECONDS = 90
const MAX_STALE_SECONDS = 60 * 60

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
  const staleBefore = Date.now() - staleAfterSeconds() * 1000
  return workers.map((worker) => ({
    workerId: worker.workerId,
    status: worker.lastSeenAt.getTime() < staleBefore ? 'STALE' : worker.status,
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
