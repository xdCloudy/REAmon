import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const projectId = 'browser-go-rename-fixture'
const userId = 'browser-go-rename-user'
const providerId = 'browser-go-rename-provider'
const artifactId = 'browser-go-rename-artifact'
const taskId = 'browser-go-rename-task'
const selectedUnitId = 'browser-go-rename-unit'
const siblingUnitId = 'browser-go-rename-sibling'
const commandUnitId = 'browser-go-rename-command'
const source = 'package pkg\nimport "example.test/dep"\ntype Worker struct{}\nfunc (Worker) Do() int { return dep.Value }\n'
const siblingSource = 'package pkg\nfunc local() int { return Worker{}.Do() }\n'
const commandSource = 'package main\nimport "example.test/fixture/pkg"\nfunc Run() int { return pkg.Worker{}.Do() }\nfunc Expr() func(pkg.Worker) int { return pkg.Worker.Do }\n'
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const root = process.env.REAMON_DERIVED_PATH || '/data/reamon-derived'
const runKey = `${projectId}/${artifactId}/${taskId}/run-1`

try {
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.user.create({ data: { id: userId, name: 'Go browser fixture', email: 'browser@example.test', role: 'admin' } })
  await prisma.project.create({ data: { id: projectId, userId, name: 'Go browser fixture', projectKind: 'REVERSE_ENGINEERING' } })
  await prisma.userLlmProvider.create({
    data: { id: providerId, userId, providerType: 'openai_compatible', name: 'Deterministic browser fixture', modelIdentifier: 'test/rename-model' },
  })
  await prisma.artifact.create({
    data: {
      id: artifactId, projectId, name: 'Go fixture', originalName: 'Go fixture', relativePath: 'fixture.go',
      storagePath: 'not-read-by-safe-renames', sha256: hash(source), sizeBytes: BigInt(Buffer.byteLength(source)),
      extension: '.go', profile: { format: 'go-source' },
    },
  })
  const goMod = await readFile(path.join(root, 'go.mod'), 'utf8')
  const goSum = await readFile(path.join(root, 'go.sum'), 'utf8')
  for (const [name, extension, content] of [['go.mod', '.mod', goMod], ['go.sum', '.sum', goSum]]) {
    await prisma.artifact.create({
      data: {
        projectId, name, originalName: name, relativePath: name, storagePath: name,
        sha256: hash(content), sizeBytes: BigInt(Buffer.byteLength(content)), extension,
      },
    })
  }
  await prisma.task.create({
    data: { id: taskId, projectId, artifactId, capability: 'decompile', title: 'Go package rename acceptance', status: 'COMPLETED' },
  })
  for (const [id, relativePath, sourceCode] of [
    [selectedUnitId, 'pkg/a.go', source], [siblingUnitId, 'pkg/b.go', siblingSource],
    [commandUnitId, 'cmd/main.go', commandSource],
  ]) {
    await prisma.reamonObservation.create({
      data: {
        id, projectId, taskId, artifactId, kind: 'entity', type: 'code_unit', stableKey: id,
        canonicalKey: id, label: relativePath, source: `browser-go-rename-${id}`,
        attributes: { language: 'Go', relativePath, qualifiedName: relativePath, codeArtifactId: `${runKey}/sources/${relativePath}` },
      },
    })
    const sourcePath = path.join(root, runKey, 'sources', relativePath)
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, sourceCode, 'utf8')
  }
  const acceptedSources = [
    [siblingUnitId, 'pkg/b.go', siblingSource], [commandUnitId, 'cmd/main.go', commandSource],
  ]
  for (const [unitId, relativePath, sourceCode] of acceptedSources) {
    const reviewId = `browser-go-rename-review-${unitId}`
    await prisma.reamonCodeReview.create({
      data: {
        id: reviewId, projectId, artifactId, codeUnitId: unitId, reviewerId: userId,
        decision: 'ACCEPTED', rationale: 'Synthetic accepted source for the isolated browser acceptance.',
        maintainedSourceHash: hash(sourceCode),
      },
    })
    await prisma.reamonMaintainedSource.create({
      data: {
        projectId, artifactId, codeUnitId: unitId, unitName: relativePath, language: 'Go',
        sourceCode, sourceHash: hash(sourceCode), acceptedReviewId: reviewId, relativePath,
      },
    })
  }
  process.stdout.write(JSON.stringify({ projectId, userId, providerId, selectedUnitId, siblingUnitId, commandUnitId, moduleSumSha256: hash(goSum) }))
} finally {
  await prisma.$disconnect()
}
