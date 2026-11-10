import { createHmac, createHash } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'

const PROJECT_ID = 'browser-go-rename-fixture'
const USER_ID = 'browser-go-rename-user'
const PROVIDER_ID = 'browser-go-rename-provider'
const UNIT_ID = 'browser-go-rename-unit'
const SIBLING_UNIT_ID = 'browser-go-rename-sibling'
const SOURCE = 'package sample\nimport "example.test/dep"\nfunc fn(value int) int { return dep.Value + value }\n'
const RENAMED_SOURCE = 'package sample\nimport "example.test/dep"\nfunc calculate(value int) int { return dep.Value + value }\n'
const SIBLING_SOURCE = 'package sample\nfunc run() int { return fn(1) }\n'

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function mintToken(secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: string) => Buffer.from(value).toString('base64url')
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = encode(JSON.stringify({ sub: USER_ID, role: 'admin', iat: now, exp: now + 600 }))
  const content = `${header}.${payload}`
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`
}

const inventory = {
  scope: 'verified-whole-project-go-source-snapshot', complete: true, sourceFileCount: 2, packageCount: 1,
  privatePackageSymbolCount: 2, referencedPrivatePackageSymbols: 1, unreferencedPrivateSymbols: 1,
  exportedPackageSymbolCount: 0, unsupportedPackageSymbolCount: 0,
  fileScopeSymbolCount: 1, referencedFileScopeSymbols: 1, unreferencedFileScopeSymbols: 0, unsupportedFileScopeSymbolCount: 0,
  localSymbolCount: 1, referencedLocalSymbols: 1, unreferencedLocalSymbols: 0, unsupportedLocalSymbolCount: 0,
  renameBindingCatalogTruncated: false, entryCount: 4, entriesTruncated: false,
  entries: [
    { id: '0123456789abcdef01234567', name: 'fn', kind: 'package function', scope: 'package', relativePath: 'pkg/a.go', declarationStart: 42, referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'private-package-symbol-with-resolved-references', nameAssessment: 'unassessed' },
    { id: 'abcdef0123456789abcdef02', name: 'dep', kind: 'file import alias', scope: 'file', relativePath: 'pkg/a.go', declarationStart: 21, referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'file-import-alias-with-resolved-references', nameAssessment: 'unassessed' },
    { id: 'abcdef0123456789abcdef03', name: 'value', kind: 'local variable', scope: 'local', relativePath: 'pkg/a.go', declarationStart: 49, referenceCount: 1, exported: false, classification: 'eligible', classificationReason: 'local-symbol-with-resolved-references', nameAssessment: 'unassessed' },
    { id: 'abcdef0123456789abcdef04', name: 'run', kind: 'package function', scope: 'package', relativePath: 'pkg/b.go', declarationStart: 20, referenceCount: 0, exported: false, classification: 'excluded', classificationReason: 'unreferenced-package-symbol', nameAssessment: 'unassessed' },
  ],
}

async function installApiFixtures(page: Page, requests: Array<{ operation: string; body: Record<string, unknown> }>) {
  await page.route('**/api/user/preferences', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { id: USER_ID, name: 'Browser fixture', email: 'browser@example.test', role: 'admin' } }))
  await page.route('**/api/system/stats', (route) => route.fulfill({ json: {} }))
  await page.route(`**/api/projects/${PROJECT_ID}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname

    if (pathname.endsWith('/workspace')) {
      return route.fulfill({ json: { workspace: { id: PROJECT_ID, name: 'Go browser fixture' }, tasks: [] } })
    }
    if (pathname.endsWith('/visualizer/providers')) {
      return route.fulfill({ json: { providers: [{ id: PROVIDER_ID, name: 'Fixture provider', modelIdentifier: 'fixture/model' }] } })
    }
    if (pathname.endsWith('/visualizer') && request.method() === 'GET') {
      return route.fulfill({ json: { units: [{
        id: UNIT_ID, name: 'pkg/a.go', address: '', sizeBytes: SOURCE.length, coveragePercent: 100,
        language: 'Go', unitType: 'file', artifactId: 'go-fixture-artifact', disassemblyArtifactId: null,
        disassemblyLanguage: null, artifactPath: 'pkg/a.go', source: 'fixture',
        codeArtifactId: `${PROJECT_ID}/go-fixture-artifact/task/run-1/sources/pkg/a.go`,
        codeArtifactSha256: digest(SOURCE), updatedAt: new Date().toISOString(),
      }, {
        id: SIBLING_UNIT_ID, name: 'pkg/b.go', address: '', sizeBytes: SIBLING_SOURCE.length, coveragePercent: 100,
        language: 'Go', unitType: 'file', artifactId: 'go-fixture-artifact', disassemblyArtifactId: null,
        disassemblyLanguage: null, artifactPath: 'pkg/b.go', source: 'fixture',
        codeArtifactId: `${PROJECT_ID}/go-fixture-artifact/task/run-1/sources/pkg/b.go`,
        codeArtifactSha256: digest(SIBLING_SOURCE), updatedAt: new Date().toISOString(),
      }], total: 2, hasMore: false } })
    }
    if (pathname.includes('/artifacts/') && pathname.includes('/decompiled/')) {
      return route.fulfill({ status: 200, contentType: 'text/plain', body: SOURCE })
    }
    if (pathname.endsWith('/visualizer/safe-renames') && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      requests.push({ operation: String(body.operation), body })
      if (body.operation === 'suggest') {
        return route.fulfill({ json: {
          sourceSha256: digest(SOURCE), providerId: PROVIDER_ID, providerName: 'Fixture provider', model: 'fixture/model',
          attemptId: 'browser-suggestion-attempt', projectSymbolContextSha256: 'b'.repeat(64), scope: 'project', candidates: 1,
          projectInventory: inventory,
          renames: [{ bindingId: inventory.entries[0].id, oldName: 'fn', newName: 'calculate', kind: 'package function', referenceCount: 1, rationale: 'Describe the calculation.' }],
        } })
      }
      if (body.operation === 'apply') {
        return route.fulfill({ json: {
          sourceCode: RENAMED_SOURCE, attemptId: 'browser-apply-attempt', draftId: 'browser-selected-draft',
          draftUpdatedAt: new Date().toISOString(), providerName: 'Fixture provider', model: 'fixture/model',
          syntaxValidated: true, validationStatus: 'PASSED', validationMethod: 'fixture', renamedBindings: [{ oldName: 'fn', newName: 'calculate' }],
          projectChanges: [
            { unitId: UNIT_ID, relativePath: 'pkg/a.go', draftId: 'browser-selected-draft', outputSha256: digest(RENAMED_SOURCE) },
            { unitId: SIBLING_UNIT_ID, relativePath: 'pkg/b.go', draftId: 'browser-sibling-draft', outputSha256: digest(SIBLING_SOURCE.replace('fn(1)', 'calculate(1)')) },
          ],
        } })
      }
      return route.fulfill({ status: 400, json: { error: `Unexpected operation: ${String(body.operation)}` } })
    }
    if (pathname.endsWith('/visualizer/maintained/')) return route.fulfill({ json: { exists: false, sourceCode: null } })
    if (pathname.includes('/visualizer/drafts/')) return route.fulfill({ json: { exists: false, draft: null, attempts: [] } })
    if (pathname.includes('/visualizer/notes/')) return route.fulfill({ json: { unitId: UNIT_ID, note: '', stale: false, updatedAt: null } })
    if (pathname.includes('/visualizer/deobfuscate/attempts')) return route.fulfill({ json: { attempts: [] } })
    if (pathname.includes('/visualizer/alternates')) return route.fulfill({ json: { alternates: [] } })
    if (pathname.includes('/visualizer/coverage')) return route.fulfill({ json: { taskId: 'task', codeUnitCount: 0, maintainedUnitCount: 0, coveragePercent: 0, reviewedUnitCount: 0, validatedUnitCount: 0, unmatchedLegacyValidationUnitCount: 0, reviewedPercent: 0, validatedPercent: 0, decompilationCoveragePercent: null, sourceLinkedPercent: 0, codeBytes: 0, measuredBytes: 0 } })
    return route.fulfill({ json: {} })
  })
}

test('renders the Go rename review and submits a selected project rename with a saved-draft receipt', async ({ page, context, baseURL }, testInfo) => {
  const secret = process.env.REDAMON_E2E_AUTH_SECRET
  test.skip(!secret, 'Run through run-go-safe-renames-isolated.ps1 to use a disposable app and database')
  if (!secret) throw new Error('REDAMON_E2E_AUTH_SECRET is required for the isolated browser stack')
  const requests: Array<{ operation: string; body: Record<string, unknown> }> = []
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`${message.text()} ${message.location().url}`) })
  await context.addCookies([{
    name: 'redamon-auth', value: mintToken(secret), domain: new URL(baseURL!).hostname,
    path: '/', httpOnly: true, sameSite: 'Lax',
  }])
  await page.addInitScript(() => {
    localStorage.setItem('reamon-v3-onboarding', JSON.stringify({ version: '2026-10-04-v3', acceptedAt: new Date().toISOString() }))
    localStorage.setItem('redamon-github-star-dismissed', '1')
  })
  await installApiFixtures(page, requests)

  await page.goto(`/projects/${PROJECT_ID}/visualizer`)
  await page.getByRole('button', { name: /pkg\/a\.go, 100% decompiled/ }).click()
  await expect(page.getByRole('heading', { name: /Reverse engineer into maintainable code/ })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Editable maintained source' })).toHaveValue(SOURCE)
  await page.getByRole('checkbox', { name: /Include same-package files and references/ }).check()
  await page.getByRole('button', { name: 'Suggest scope-safe renames' }).click()
  await expect(page.getByText(/Go whole-project inventory: 2 source files across 1 packages/)).toBeVisible()
  await expect(page.getByText('fn → calculate')).toBeVisible()

  await page.getByRole('button', { name: 'Apply 1 selected rename' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Applied 1 scope-safe rename' })).toContainText('Saved review drafts for pkg/a.go, pkg/b.go')
  await expect(page.getByRole('textbox', { name: 'Editable maintained source' })).toHaveValue(RENAMED_SOURCE)
  await expect.poll(() => requests.map(({ operation }) => operation)).toEqual(['suggest', 'apply'])
  expect(requests[0].body).toMatchObject({ operation: 'suggest', providerId: PROVIDER_ID, crossFileGo: true })
  expect(requests[1].body).toMatchObject({
    operation: 'apply', providerId: PROVIDER_ID, expectedSha256: digest(SOURCE),
    suggestionAttemptId: 'browser-suggestion-attempt', crossFileGo: true,
    renames: [{ bindingId: inventory.entries[0].id, oldName: 'fn', newName: 'calculate' }],
  })
  expect(browserErrors).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('go-safe-renames.png'), fullPage: true })
})
