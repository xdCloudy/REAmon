import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import prisma from '@/lib/prisma'
import { artifactRoot } from '@/lib/reamon/artifact-storage'

export const runtime = 'nodejs'

export async function GET() {
  const checks = {
    database: 'unavailable',
    artifacts: 'unavailable',
  }

  try {
    await prisma.$queryRaw`SELECT 1`
    checks.database = 'ok'
  } catch (error) {
    console.error('REAmon readiness database check failed:', error)
  }

  try {
    await access(artifactRoot(), constants.R_OK | constants.W_OK)
    checks.artifacts = 'ok'
  } catch (error) {
    console.error('REAmon readiness artifact-volume check failed:', error)
  }

  const ready = Object.values(checks).every((status) => status === 'ok')
  return Response.json({ status: ready ? 'ready' : 'not_ready', checks }, {
    status: ready ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
