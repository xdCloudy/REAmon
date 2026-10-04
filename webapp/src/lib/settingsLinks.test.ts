import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SETTINGS_TABS, settingsHref, SETTINGS_KEYS_HREF, SETTINGS_SKILLS_HREF,
} from './settingsLinks'

const PAGE = join(process.cwd(), 'src/app/settings/page.tsx')

/** The `validTabs` array the settings page validates `?tab=` against. */
function pageValidTabs(): string[] {
  const src = readFileSync(PAGE, 'utf8')
  const m = src.match(/const validTabs = \[([^\]]+)\]/)
  if (!m) throw new Error('validTabs not found in settings/page.tsx - update this test')
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}

describe('settingsHref', () => {
  test('builds a tab-anchored href', () => {
    expect(settingsHref(SETTINGS_TABS.system)).toBe('/settings?tab=system')
    expect(SETTINGS_KEYS_HREF).toBe('/settings?tab=providers')
    expect(SETTINGS_SKILLS_HREF).toBe('/settings?tab=providers')
  })

  // The whole point of these links is landing on a specific tab. An id the page
  // does not recognise falls back to 'providers' WITHOUT any error, so a typo
  // or a renamed tab would quietly restore the bug this module fixes.
  test('every exported tab id is one the settings page accepts', () => {
    const valid = pageValidTabs()
    for (const id of Object.values(SETTINGS_TABS)) {
      expect(valid, `'${id}' is not in the page's validTabs`).toContain(id)
    }
  })

  test('the page has no tab this module cannot link to', () => {
    const exported = Object.values(SETTINGS_TABS) as string[]
    for (const id of pageValidTabs()) {
      expect(exported, `page tab '${id}' has no SETTINGS_TABS entry`).toContain(id)
    }
  })
})
