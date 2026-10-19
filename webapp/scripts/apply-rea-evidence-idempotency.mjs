/**
 * Prepare REA Evidence's nullable idempotency reference before Prisma db push.
 * Prisma treats adding this unique index as a potential data-loss operation,
 * even though NULL rows remain distinct. Creating it first is additive and
 * idempotent; on a fresh database the table is absent and db push creates the
 * complete model normally.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

try {
  const [table] = await prisma.$queryRawUnsafe('SELECT to_regclass($1)::text AS name', 'public.reamon_evidence')
  if (!table?.name) {
    console.log('[rea-evidence] table not created yet; Prisma will create the model')
  } else {
    await prisma.$executeRawUnsafe('ALTER TABLE "reamon_evidence" ADD COLUMN IF NOT EXISTS "source_reference" TEXT')
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "reamon_evidence_project_id_source_source_reference_key" ON "reamon_evidence"("project_id", "source", "source_reference")')
    console.log('[rea-evidence] nullable idempotency reference and unique index are ready')
  }
} catch (error) {
  console.error('[rea-evidence] migration failed; refusing to continue to db push:', error?.message || error)
  process.exitCode = 1
} finally {
  await prisma.$disconnect().catch(() => {})
}
