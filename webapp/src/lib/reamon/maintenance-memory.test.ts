import { describe, expect, it } from 'vitest'
import { buildProjectSymbolContext, extractMaintainedSymbols } from './maintenance-memory'

describe('maintained-source project memory', () => {
  it('indexes declared names from saved source', () => {
    expect(extractMaintainedSymbols(`package example; public class AccountRunner { private final AccountStore accountStore; public void refreshAccount() {} }`)).toEqual([
      'AccountRunner', 'accountStore', 'refreshAccount',
    ])
  })

  it('puts saved related names first and respects the prompt budget', () => {
    const context = buildProjectSymbolContext([
      { unitName: 'other.Unrelated', language: 'Java', symbolIndex: ['unrelatedMethod'] },
      { unitName: 'example.AccountStore', language: 'Java', symbolIndex: ['loadAccount', 'saveAccount'] },
    ], new Set(['example.AccountStore']), 100)

    expect(context.split('\n')[0]).toContain('example.AccountStore')
    expect(context.length).toBeLessThanOrEqual(100)
  })
})
