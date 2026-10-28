import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import prisma from '@/lib/prisma'
import { artifactRoot } from '@/lib/reamon/artifact-storage'
import { verifyConnection } from '@/app/api/graph/neo4j'

export const runtime = 'nodejs'

export async function GET() {
  const checks = {
    database: 'unavailable',
    neo4j: 'unavailable',
    artifacts: 'unavailable',
  }

  const [databaseReady, neo4jReady, artifactsReady] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch((error) => {
      console.error('REAmon readiness database check failed:', error)
      return false
    }),
    verifyConnection().catch((error) => {
      console.error('REAmon readiness Neo4j check failed:', error)
      return false
    }),
    access(artifactRoot(), constants.R_OK | constants.W_OK).then(() => true).catch((error) => {
      console.error('REAmon readiness artifact-volume check failed:', error)
      return false
    }),
  ])
  if (databaseReady) checks.database = 'ok'
  if (neo4jReady) checks.neo4j = 'ok'
  if (artifactsReady) checks.artifacts = 'ok'

  const ready = Object.values(checks).every((status) => status === 'ok')
  const configuredRevision = process.env.REAMON_BUILD_SHA || ''
  const revision = /^[a-f\d]{7,40}$/i.test(configuredRevision)
    ? configuredRevision
    : 'unknown'
  const dirtyValue = process.env.REAMON_BUILD_DIRTY
  const dirty = dirtyValue === 'true' ? true : dirtyValue === 'false' ? false : null
  return Response.json({
    status: ready ? 'ready' : 'not_ready',
    checks,
    build: { revision, dirty },
  }, {
    status: ready ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  })
}
