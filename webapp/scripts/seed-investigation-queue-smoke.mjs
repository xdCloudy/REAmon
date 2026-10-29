/** Seed a synthetic failed reconstruction case for the disposable browser acceptance stack. */
import { PrismaClient } from '@prisma/client'

const projectId = process.env.REAMON_BROWSER_PROJECT_ID
if (!projectId) throw new Error('REAMON_BROWSER_PROJECT_ID is required')

const prisma = new PrismaClient()
try {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  })
  if (!project) throw new Error('Browser acceptance project does not exist')

  const artifact = await prisma.artifact.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, sha256: true },
  })
  if (!artifact) throw new Error('Browser acceptance project has no imported artifact')

  const task = await prisma.task.create({
    data: {
      projectId,
      artifactId: artifact.id,
      capability: 'decompile',
      title: 'Browser investigation queue smoke',
      status: 'FAILED',
      progressMessage: 'Synthetic browser acceptance fixture',
      error: 'Synthetic failed reconstruction fixture',
      completedAt: new Date(),
    },
    select: { id: true },
  })
  const investigation = await prisma.reamonInvestigationCase.create({
    data: {
      projectId,
      taskId: task.id,
      artifactId: artifact.id,
      artifactSha256: artifact.sha256.toLowerCase(),
      capability: 'decompile',
      status: 'QUEUED',
      failureEvidence: { schemaVersion: 1, taskId: task.id, synthetic: true },
      history: [{ event: 'QUEUED', at: new Date().toISOString(), requestedBy: project.userId }],
      requestedBy: project.userId,
    },
    select: { id: true },
  })

  const runningCreatedAt = new Date(Date.now() - 1000)
  const completedCreatedAt = new Date()
  await prisma.reamonCodeAttempt.createMany({
    data: [
      {
        projectId,
        ownerUserId: project.userId,
        artifactId: artifact.id,
        runKey: task.id,
        codeUnitId: `investigation:${investigation.id}:unit:running`,
        unitName: 'decode_entry',
        language: 'C',
        sourceHash: 'a'.repeat(64),
        providerName: 'browser-smoke-fixture',
        modelIdentifier: 'synthetic',
        scope: 'manual-investigation',
        status: 'RUNNING',
        timeoutMs: 10_000,
        createdAt: runningCreatedAt,
      },
      {
        projectId,
        ownerUserId: project.userId,
        artifactId: artifact.id,
        runKey: task.id,
        codeUnitId: `investigation:${investigation.id}:unit:completed`,
        unitName: 'decode_footer',
        language: 'C',
        sourceHash: 'b'.repeat(64),
        providerName: 'browser-smoke-fixture',
        modelIdentifier: 'synthetic',
        scope: 'manual-investigation',
        status: 'SUCCEEDED',
        resultSource: 'int decode_footer(void) { return 3; }',
        validationStatus: 'UNAVAILABLE',
        timeoutMs: 10_000,
        createdAt: completedCreatedAt,
        completedAt: completedCreatedAt,
      },
    ],
  })
  console.log('PASS: synthetic mixed-status investigation fixture seeded')
} finally {
  await prisma.$disconnect()
}
