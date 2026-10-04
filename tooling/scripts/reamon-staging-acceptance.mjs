#!/usr/bin/env node
/**
 * Run the REAmon production acceptance path against an already-running
 * staging Compose deployment. The command creates a disposable RE workspace,
 * imports representative JSON and source files, exercises approval-gated
 * analysis, dispatches two workers concurrently, projects observations into
 * Neo4j, and verifies the authenticated workspace snapshot.
 *
 * Required environment:
 *   REAMON_ACCEPTANCE_INTERNAL_KEY
 *   REAMON_ACCEPTANCE_EMAIL
 *   REAMON_ACCEPTANCE_PASSWORD
 *
 * Optional:
 *   REAMON_ACCEPTANCE_BASE_URL (default: http://127.0.0.1:3000)
 */

const baseUrl = (process.env.REAMON_ACCEPTANCE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const internalKey = process.env.REAMON_ACCEPTANCE_INTERNAL_KEY || ''
const email = process.env.REAMON_ACCEPTANCE_EMAIL || ''
const password = process.env.REAMON_ACCEPTANCE_PASSWORD || ''
const stateFile = process.env.REAMON_ACCEPTANCE_STATE_FILE || ''

if (!internalKey || !email || !password) {
  console.error('FAIL: REAMON_ACCEPTANCE_INTERNAL_KEY, REAMON_ACCEPTANCE_EMAIL, and REAMON_ACCEPTANCE_PASSWORD are required')
  process.exit(2)
}

function fail(message) {
  throw new Error(message)
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie') || ''
  const match = setCookie.match(/(?:^|,\s*)redamon-auth=([^;]+)/)
  return match ? `redamon-auth=${match[1]}` : ''
}

async function request(path, options = {}, expectedStatuses = [200]) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.headers || {}) },
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!expectedStatuses.includes(response.status)) {
    const detail = typeof body === 'string' ? body.slice(0, 240) : JSON.stringify(body).slice(0, 400)
    fail(`${options.method || 'GET'} ${path} returned ${response.status}: ${detail}`)
  }
  return { response, body }
}

function jsonOptions(method, body, cookie, extraHeaders = {}) {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  }
}

function expect(condition, message) {
  if (!condition) fail(message)
}

async function writeState(state) {
  if (!stateFile) return
  const { writeFile } = await import('node:fs/promises')
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function main() {
  await request('/api/health/ready')
  const unauthenticatedProjects = await request('/api/projects', {}, [401])
  expect(unauthenticatedProjects.response.status === 401, 'unauthenticated project listing was not rejected')
  const unauthenticatedInternal = await request('/api/internal/reamon/tasks/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }, [401])
  expect(unauthenticatedInternal.response.status === 401, 'internal dispatch accepted a request without its key')
  console.log('PASS: readiness and unauthenticated boundary checks')

  const login = await request('/api/auth/login', jsonOptions('POST', { email, password }, ''))
  const cookie = cookieFrom(login.response)
  expect(cookie, 'login did not return the REAmon auth cookie')
  console.log('PASS: operator login')

  const project = await request('/api/projects', jsonOptions('POST', {
    name: `REAmon staging acceptance ${new Date().toISOString()}`,
    projectKind: 'REVERSE_ENGINEERING',
  }, cookie), [201])
  const projectId = project.body?.id
  expect(typeof projectId === 'string' && projectId.length > 0, 'project creation did not return an id')

  const jsonBytes = Buffer.from(JSON.stringify({
    version: 1,
    target: 'staging-fixture',
    indicators: ['alpha.example', 'sha256:fixture'],
    nested: { source: 'acceptance' },
  }, null, 2))
  const sourceBytes = Buffer.from('int main(void) { return 42; }\nconst staging_marker = "reamon-acceptance";\n')
  const recoveryBytes = Buffer.from(JSON.stringify({ recovery: true, source: 'worker-failover' }, null, 2))
  const manifest = [
    { relativePath: 'fixtures/sample.json', size: jsonBytes.length, lastModified: Date.now() },
    { relativePath: 'src/main.c', size: sourceBytes.length, lastModified: Date.now() },
    { relativePath: 'fixtures/recovery.json', size: recoveryBytes.length, lastModified: Date.now() },
  ]
  const createdImport = await request(`/api/projects/${projectId}/imports`, jsonOptions('POST', {
    rootName: 'staging-fixture',
    sourceType: 'BROWSER_DIRECTORY',
    files: manifest,
  }, cookie), [201])
  const importId = createdImport.body?.id
  expect(typeof importId === 'string' && importId.length > 0, 'import creation did not return an id')

  for (const [entry, bytes, mime] of [
    [manifest[0], jsonBytes, 'application/json'],
    [manifest[1], sourceBytes, 'text/plain'],
    [manifest[2], recoveryBytes, 'application/json'],
  ]) {
    const form = new FormData()
    form.set('relativePath', entry.relativePath)
    form.set('file', new Blob([bytes], { type: mime }), entry.relativePath.split('/').pop())
    const uploaded = await request(`/api/projects/${projectId}/imports/${importId}/artifacts`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    }, [201])
    expect(uploaded.body?.artifact?.id, `artifact upload failed for ${entry.relativePath}`)
  }
  const finalized = await request(`/api/projects/${projectId}/imports/${importId}/finalize`, {
    method: 'POST',
    headers: { cookie },
  })
  expect(finalized.body?.status === 'COMPLETED', 'workspace import did not complete')
  console.log(`PASS: representative import and profiling project=${projectId}`)

  const plan = await request(`/api/projects/${projectId}/workspace/analysis-plan`, {
    headers: { cookie },
  })
  expect(Array.isArray(plan.body?.steps) && plan.body.steps.length >= 2, 'analysis plan did not expose both representative artifacts')
  const artifacts = finalized.body?.profile ? (await request(`/api/projects/${projectId}/workspace/files?limit=10`, { headers: { cookie } })).body?.artifacts : null
  expect(Array.isArray(artifacts) && artifacts.length >= 2, 'workspace inventory did not expose the imported artifacts')
  const jsonArtifact = artifacts.find((artifact) => artifact.relativePath === 'fixtures/sample.json')
  const sourceArtifact = artifacts.find((artifact) => artifact.relativePath === 'src/main.c')
  const recoveryArtifact = artifacts.find((artifact) => artifact.relativePath === 'fixtures/recovery.json')
  expect(jsonArtifact?.id && sourceArtifact?.id && recoveryArtifact?.id, 'representative artifacts were not discoverable')

  const scheduled = await Promise.all([
    request(`/api/projects/${projectId}/workspace/analysis-plan/schedule`, jsonOptions('POST', {
      artifactId: jsonArtifact.id,
      providerId: 'reamon-json-inspector',
      capability: 'extract_metadata',
      approvalRequired: true,
    }, cookie), [201]),
    request(`/api/projects/${projectId}/workspace/analysis-plan/schedule`, jsonOptions('POST', {
      artifactId: sourceArtifact.id,
      providerId: 'reamon-source-inspector',
      capability: 'extract_strings',
      approvalRequired: true,
    }, cookie), [201]),
  ])
  const taskIds = scheduled.map((item) => item.body?.task?.id)
  expect(taskIds.every((id) => typeof id === 'string'), 'analysis scheduling did not return both task ids')

  const pending = await request(`/api/projects/${projectId}/approvals?status=PENDING`, { headers: { cookie } })
  const approvals = pending.body?.approvals || []
  const projectApprovals = approvals.filter((item) => taskIds.includes(item.task?.id))
  expect(projectApprovals.length === 2, 'approval gate did not create one approval per analysis task')
  for (const item of projectApprovals) {
    await request(`/api/projects/${projectId}/approvals/${item.approval?.id}`, jsonOptions('POST', {
      decision: 'approve',
      reason: 'Staging acceptance approval',
    }, cookie))
  }
  console.log('PASS: approval-gated analysis scheduling')

  const failoverScheduled = await request(`/api/projects/${projectId}/workspace/analysis-plan/schedule`, jsonOptions('POST', {
    artifactId: recoveryArtifact.id,
    providerId: 'reamon-json-inspector',
    capability: 'extract_metadata',
    approvalRequired: true,
  }, cookie), [201])
  const failoverTaskId = failoverScheduled.body?.task?.id
  expect(typeof failoverTaskId === 'string' && failoverTaskId.length > 0, 'worker failover task was not scheduled')
  await writeState({ projectId, importId, taskIds, failoverTaskId, recoveryArtifactId: recoveryArtifact.id, projectName: project.body?.name })
  console.log(`PASS: controlled worker failover task queued for browser approval task=${failoverTaskId}`)

  const dispatch = (workerId) => request('/api/internal/reamon/tasks/dispatch', jsonOptions('POST', {
    projectId,
    limit: 1,
    recoverStale: false,
    workerId,
  }, '', { 'x-internal-key': internalKey }))
  const dispatches = await Promise.all([dispatch('reamon-acceptance-a'), dispatch('reamon-acceptance-b')])
  const claimed = dispatches.flatMap((item) => item.body?.results || [])
    .filter((result) => result.outcome !== 'SKIPPED')
    .map((result) => result.task?.id)
    .filter(Boolean)
  expect(new Set(claimed).size === claimed.length, 'concurrent dispatchers returned a duplicate task claim')
  expect(new Set(claimed).size === 2, `concurrent dispatchers did not execute both tasks (claimed ${claimed.length})`)
  expect(dispatches.every((item) => (item.body?.results || []).every((result) => result.outcome === 'COMPLETED')), 'a representative provider task did not complete')
  console.log('PASS: concurrent worker contention and provider execution')

  const projection = await request('/api/internal/reamon/graph/project', jsonOptions('POST', {
    projectId,
    limit: 100,
    batchSize: 100,
  }, '', { 'x-internal-key': internalKey }))
  expect(projection.body?.status !== 'FAILED' && Number(projection.body?.nodes) > 0, 'graph projection did not persist provider observations')
  expect(projection.body?.reconciled === true, 'graph projection did not complete reconciliation')

  const snapshot = await request(`/api/projects/${projectId}/workspace`, { headers: { cookie } })
  const workspace = snapshot.body
  expect(workspace?.imports?.some((item) => item.id === importId && item.status === 'COMPLETED'), 'workspace snapshot omitted the completed import')
  expect(workspace?.tasks?.filter((task) => taskIds.includes(task.id)).every((task) => task.status === 'COMPLETED'), 'workspace snapshot omitted completed task state')
  expect(workspace?.approvalSummary?.approved >= 2, 'workspace snapshot omitted approved analysis state')
  expect(workspace?.approvalSummary?.pending >= 1, 'workspace snapshot omitted the controlled failover approval')
  expect(workspace?.observations?.length >= 2, 'workspace snapshot omitted provider observations')
  expect(workspace?.projectionRuns?.some((run) => run.status === 'COMPLETED' && run.reconciled === true), 'workspace snapshot omitted reconciled graph state')
  expect(workspace?.compatibility?.mode === 'native', 'reverse-engineering workspace is not in native compatibility mode')
  console.log(`PASS: authenticated workspace, provider, graph, and compatibility snapshot project=${projectId}`)
  console.log('PASS: REAmon staging acceptance complete')
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
