#!/usr/bin/env node
/**
 * Prepare one already-approved task as a stale lease for the deployment-level
 * worker failover drill. This utility is shipped in the image for the CI and
 * operator preflight only; it is never an HTTP endpoint.
 */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const [taskId, leaseOwner = 'reamon-failover-worker', staleAfterRaw = '5'] = process.argv.slice(2)
const staleAfterMinutes = Number(staleAfterRaw)

if (!taskId || !Number.isInteger(staleAfterMinutes) || staleAfterMinutes < 5 || staleAfterMinutes > 1440) {
  console.error('Usage: reamon-seed-stale-task.mjs <task-id> <lease-owner> <stale-after-minutes>=5')
  process.exit(2)
}

const prisma = new PrismaClient()

try {
  const staleAt = new Date(Date.now() - (staleAfterMinutes + 1) * 60 * 1000)
  const updated = await prisma.task.updateMany({
    where: { id: taskId, status: 'QUEUED' },
    data: {
      status: 'RUNNING',
      progress: 10,
      startedAt: staleAt,
      leaseHeartbeatAt: staleAt,
      leaseOwner: leaseOwner.slice(0, 128),
      runToken: randomUUID(),
      completedAt: null,
      error: '',
    },
  })
  if (updated.count !== 1) throw new Error(`task ${taskId} was not queued or does not exist`)
  console.log(JSON.stringify({ taskId, leaseOwner: leaseOwner.slice(0, 128), staleAfterMinutes, staleAt: staleAt.toISOString() }))
} finally {
  await prisma.$disconnect()
}
