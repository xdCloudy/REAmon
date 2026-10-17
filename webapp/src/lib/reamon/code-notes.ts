export const REAMON_CODE_NOTE_SOURCE = 'reamon-code-note'
export const REAMON_CODE_NOTE_TYPE = 'code_unit_note'
export const MAX_REAMON_CODE_NOTE_CHARS = 3_000

export function codeNoteText(value: unknown, currentSourceHash?: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  const savedSourceHash = typeof record.sourceHash === 'string' && /^[a-f0-9]{64}$/i.test(record.sourceHash)
    ? record.sourceHash.toLowerCase()
    : null
  if (!savedSourceHash || !currentSourceHash || savedSourceHash !== currentSourceHash.toLowerCase()) return ''
  const note = record.note
  return typeof note === 'string' ? note.slice(0, MAX_REAMON_CODE_NOTE_CHARS) : ''
}
