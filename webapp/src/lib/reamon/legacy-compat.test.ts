import { describe, expect, test } from 'vitest'
import { buildLegacyCompatibilityReport } from './legacy-compat'

describe('REAmon legacy compatibility report', () => {
  test('keeps legacy projects on an additive bridge', () => {
    const report = buildLegacyCompatibilityReport('LEGACY_SECURITY')
    expect(report).toMatchObject({ mode: 'bridge', dataPolicy: 'additive' })
    expect(report.surfaces.find((surface) => surface.id === 'legacy-routes')).toMatchObject({ status: 'BRIDGED' })
  })

  test('marks new reverse-engineering workspaces native without removing inherited surfaces', () => {
    const report = buildLegacyCompatibilityReport('REVERSE_ENGINEERING')
    expect(report.mode).toBe('native')
    expect(report.surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy-routes', status: 'BRIDGED' }),
      expect.objectContaining({ id: 'workspace-routes', status: 'AVAILABLE' }),
    ]))
  })
})
