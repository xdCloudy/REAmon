/**
 * Supported deep links into REAmon Global Settings. Retired feature-specific
 * links intentionally resolve to the providers page for old, unreachable
 * callers instead of exposing removed pentest configuration tabs.
 */

export const SETTINGS_TABS = {
  providers: 'providers',
  system: 'system',
} as const

export type SettingsTab = (typeof SETTINGS_TABS)[keyof typeof SETTINGS_TABS]

/** Href for a specific Global Settings tab. */
export function settingsHref(tab: SettingsTab): string {
  return `/settings?tab=${tab}`
}

/** Compatibility target for retired credential links. */
export const SETTINGS_KEYS_HREF = settingsHref(SETTINGS_TABS.providers)

/** Agent Skills - where user-uploaded .md skill files live. */
export const SETTINGS_SKILLS_HREF = settingsHref(SETTINGS_TABS.providers)

/** MCP Server - the INBOUND credentials other agents connect in with. */
export const SETTINGS_MCP_TOKENS_HREF = settingsHref(SETTINGS_TABS.providers)
