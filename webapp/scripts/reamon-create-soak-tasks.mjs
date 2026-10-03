#!/usr/bin/env node
/** Create bounded, non-production worker soak tasks for the staging gate. */

import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const [artifactId, countRaw = '4'] = process.argv.slice(2)
const count = Number(countRaw)
if (!artifactId || !Number.isInteger(count) || count < 1 || count > 20) {
  console.error('Usage: reamon-create-soak-tasks.mjs <artifact-id> <count 1..20>')
  process.exit(2)
}

const prisma = new PrismaClient()

try {
  const artifact = await prisma.artifact.findUnique({
    where: { id: artifactId },
    select: { id: true, projectId: true, targetId: true },
  })
  const provider = await prisma.reamonProvider.findUnique({ where: { pluginId: 'reamon-json-inspector' }, select: { id: true } })
  if (!artifact || !provider) throw new Error('soak artifact or JSON provider was not found')

  const tasks = await prisma.$transaction(async (tx) => Promise.all(Array.from({ length: count }, (_, index) => tx.task.create({
    data: {
      projectId: artifact.projectId,
      targetId: artifact.targetId,
      artifactId: artifact.id,
      providerId: provider.id,
      capability: 'extract_metadata',
      title: `Worker soak task ${index + 1}`,
      category: 'static_analysis',
      status: 'QUEUED',
      progress: 0,
      options: {},
      idempotencyKey: `drill:worker-soak:${artifact.id}:${randomUUID()}`,
    },
    select: { id: true },
  }))))
  console.log(JSON.stringify({ artifactId, projectId: artifact.projectId, taskIds: tasks.map((task) => task.id) }))
} finally {
  await prisma.$disconnect()
}
