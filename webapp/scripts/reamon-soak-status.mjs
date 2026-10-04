#!/usr/bin/env node
/** Return one aggregate status query for a bounded worker soak batch. */

import { PrismaClient } from '@prisma/client'

const taskIds = process.argv.slice(2)
if (!taskIds.length || taskIds.length > 20 || taskIds.some((taskId) => !/^[A-Za-z0-9_-]{1,128}$/.test(taskId))) {
  console.error('Usage: reamon-soak-status.mjs <task-id> [task-id ...]')
  process.exit(2)
}

const prisma = new PrismaClient()

try {
  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds } },
    select: { id: true, status: true, progress: true },
  })
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const missing = taskIds.filter((taskId) => !byId.has(taskId))
  const failed = tasks.filter((task) => task.status === 'FAILED').length
  const completed = tasks.filter((task) => task.status === 'COMPLETED').length
  console.log(JSON.stringify({ requested: taskIds.length, found: tasks.length, completed, failed, missing, tasks }))
} finally {
  await prisma.$disconnect()
}
