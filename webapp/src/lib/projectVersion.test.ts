/**
 * C-2: the settings form's concurrency token.
 *
 * PUT /api/projects/[id] refuses a full save whose `updatedAt` is stale, so the
 * form must move that value forward on EVERY write it causes itself - its full
 * save, a workflow toggle's auto-save, a preset load, and an upload made from
 * one of its sections. Missing any one of them turns the operator's own write
 * into a 409 on their next save.
 *
 * The form half is asserted at the source, like the preset paths in
 * project-preset-utils.test.ts: rendering ProjectForm needs the whole provider
 * tree, and what can go wrong here is a path that forgets to adopt.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, test, expect, vi } from 'vitest'

import { STALE_SAVE_MESSAGE, announceProjectWrite, onProjectWrite, versionOf } from './projectVersion'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('the announcement channel', () => {
  test('a write is delivered to that project\'s listener only', () => {
    const mine = vi.fn()
    const other = vi.fn()
    const offMine = onProjectWrite('p1', mine)
    const offOther = onProjectWrite('p2', other)
    announceProjectWrite('p1', '2026-09-29T10:00:00.000Z')
    expect(mine).toHaveBeenCalledWith('2026-09-29T10:00:00.000Z')
    expect(other).not.toHaveBeenCalled()
    offMine()
    offOther()
  })

  test('after unsubscribing nothing is delivered', () => {
    const listener = vi.fn()
    onProjectWrite('p1', listener)()
    announceProjectWrite('p1', '2026-09-29T10:00:00.000Z')
    expect(listener).not.toHaveBeenCalled()
  })

  test('a missing or unparseable value announces nothing', () => {
    // An upload into a project that does not exist yet has no row to report.
    const listener = vi.fn()
    const off = onProjectWrite('p1', listener)
    announceProjectWrite('p1', null)
    announceProjectWrite('p1', 'not a date')
    announceProjectWrite(undefined, '2026-09-29T10:00:00.000Z')
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  test('versionOf accepts the JSON string and a Date, as the same ISO value', () => {
    const iso = '2026-09-29T10:00:00.000Z'
    expect(versionOf(iso)).toBe(iso)
    expect(versionOf(new Date(iso))).toBe(iso)
    expect(versionOf(undefined)).toBeNull()
  })

  test('the stale-save message tells the operator what happened and what to do', () => {
    expect(STALE_SAVE_MESSAGE).toMatch(/changed since you opened it/)
    expect(STALE_SAVE_MESSAGE).toMatch(/Reload/)
  })
})

describe('ProjectForm adopts the updatedAt of every write it causes', () => {
  const form = read('../components/projects/ProjectForm/ProjectForm.tsx')
  const autoSave = form.slice(form.indexOf('const autoSaveField'), form.indexOf('const updateMultipleFields'))
  const loadPreset = form.slice(form.indexOf('const loadPreset = async'), form.indexOf('const ensureProviderConfigured'))
  const submit = form.slice(form.indexOf('const handleSubmit = async'), form.indexOf('const handleSaveAndStay = async'))
  const stay = form.slice(form.indexOf('const handleSaveAndStay = async'), form.indexOf('const updateSettingsFromSection'))

  test('both full saves send the token back, in edit mode only', () => {
    for (const body of [submit, stay]) {
      expect(body).toContain("...(mode === 'edit' && savedVersionRef.current ? { updatedAt: savedVersionRef.current } : {})")
    }
  })

  test('both full saves adopt the saved row', () => {
    expect(submit).toContain('adoptSavedVersion(await onSubmit(submitData))')
    expect(stay).toContain('adoptSavedVersion(await onSaveAndStay(submitData))')
  })

  test('a toggle auto-save and a preset load adopt theirs', () => {
    expect(autoSave).toContain('adoptSavedVersion(')
    expect(loadPreset).toContain('adoptSavedVersion(await presetSaveMutation.mutateAsync(')
  })

  test('it listens for the upload sections\' writes', () => {
    expect(form).toContain('onProjectWrite(projectId,')
  })

  test('the settings page hands the saved row back', () => {
    const page = read('../app/projects/[id]/settings/page.tsx')
    expect(page).toContain('redirect(`/projects/${encodeURIComponent(id)}`)')
    expect(page).not.toContain('saveProject')
  })

  test('a refused save reaches the form, which keeps the edit unsaved', () => {
    // The page used to catch every error, alert it and resolve, so the form ran
    // setBaseline after a 409 that saved nothing and read "No unsaved changes".
    const page = read('../app/projects/[id]/settings/page.tsx')
    const handler = page.slice(page.indexOf('const handleSubmit = async'), page.indexOf('const handleSaveAndStay'))
    expect(handler).not.toMatch(/catch\s*\(/)
    expect(submit).toMatch(/adoptSavedVersion\(await onSubmit\(submitData\)\)\s*\n[\s\S]*setBaseline\(formData\)[\s\S]*catch \(error\)[\s\S]*alertError\(message\)/)
  })
})

describe('every upload that writes the row announces it', () => {
  const cases: Array<[string, number]> = [
    ['../components/projects/ProjectForm/sections/JsReconSection.tsx', 4],
    ['../components/projects/ProjectForm/sections/SupplyChainScanSection.tsx', 2],
    ['../components/projects/ProjectForm/WorkflowView/PartialReconModal.tsx', 2],
  ]
  for (const [file, count] of cases) {
    test(`${file.split('/').pop()} announces each of its ${count} row writes`, () => {
      expect(read(file).match(/announceProjectWrite\(projectId,/g) ?? []).toHaveLength(count)
    })
  }

  test('each upload route reports the row\'s new updatedAt', () => {
    for (const route of [
      '../app/api/js-recon/[projectId]/upload/route.ts',
      '../app/api/js-recon/[projectId]/custom-files/route.ts',
      '../app/api/supply-chain/[projectId]/upload/route.ts',
    ]) {
      expect(read(route).match(/projectUpdatedAt/g)?.length ?? 0, route).toBeGreaterThanOrEqual(2)
    }
  })
})
