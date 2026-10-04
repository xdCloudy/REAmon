import { describe, expect, test } from 'vitest'
import { isReasoningEffort, REASONING_EFFORTS } from './llmReasoning'

describe('OpenAI-compatible reasoning mode validation', () => {
  test('accepts every supported UI value', () => {
    expect(REASONING_EFFORTS).toEqual(['none', 'low', 'medium', 'high', 'max'])
    for (const effort of REASONING_EFFORTS) {
      expect(isReasoningEffort(effort)).toBe(true)
    }
  })

  test('rejects unknown wire values as selectable efforts', () => {
    expect(isReasoningEffort('extreme')).toBe(false)
    expect(isReasoningEffort(null)).toBe(false)
  })
})
