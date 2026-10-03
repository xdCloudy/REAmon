#!/usr/bin/env node
/** Return machine-readable task and recovery activity state for staging drills. */

import { PrismaClient } from '@prisma/client'

const [taskId] = process.argv.slice(2)
if (!taskId) {
  console.error('Usage: reamon-task-status.mjs <task-id>')
  process.exit(2)
}

const prisma = new PrismaClient()

try {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      status: true,
      progress: true,
      leaseOwner: true,
      leaseHeartbeatAt: true,
      startedAt: true,
      completedAt: true,
    },
  })
  if (!task) throw new Error(`task ${taskId} was not found`)
  const activities = await prisma.workspaceActivity.findMany({
    where: { projectId: task.projectId, eventType: { in: ['analysis.task.recovered', 'analysis.task.completed'] } },
    select: { eventType: true, data: true },
  })
  const forTask = activities.filter((activity) => activity.data && typeof activity.data === 'object' && !Array.isArray(activity.data) && activity.data.taskId === taskId)
  const recoveryEvents = forTask.filter((activity) => activity.eventType === 'analysis.task.recovered').length
  const completionEvents = forTask.filter((activity) => activity.eventType === 'analysis.task.completed').length
  console.log(JSON.stringify({
    ...task,
    leaseHeartbeatAt: task.leaseHeartbeatAt?.toISOString() || null,
    startedAt: task.startedAt?.toISOString() || null,
    completedAt: task.completedAt?.toISOString() || null,
    recoveryEvents,
    completionEvents,
  }))
} finally {
  await prisma.$disconnect()
}
