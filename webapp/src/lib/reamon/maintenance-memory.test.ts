import { describe, expect, it } from 'vitest'
import { buildProjectSymbolContext, extractMaintainedSymbols } from './maintenance-memory'

describe('maintained-source project memory', () => {
  it('indexes declared names from saved source', () => {
    expect(extractMaintainedSymbols(`package example; public class AccountRunner { private final AccountStore accountStore; public void refreshAccount() {} }`)).toEqual([
      'AccountRunner', 'accountStore', 'refreshAccount',
    ])
  })

  it('indexes unqualified native and Kotlin function declarations', () => {
    expect(extractMaintainedSymbols(`
      int decode_packet(const unsigned char *data, size_t length) {
        return 0;
      }
      static char *lookup_name(int identifier) {
        return 0;
      }
    `, 'C')).toEqual(['decode_packet', 'lookup_name'])

    expect(extractMaintainedSymbols(`
      fun loadAccount(accountId: String): Account {
        return repository.load(accountId)
      }
    `, 'Kotlin')).toEqual(['loadAccount'])
  })

  it('ignores declaration-shaped text in comments and string literals', () => {
    const source = `/* public class Commented { private String ghostField; } */
      class AccountRunner {
        // public void ghostMethod() {}
        private String accountName = "public void stringMethod() {}";
        public void refreshAccount() {}
      }`

    expect(extractMaintainedSymbols(source, 'Java')).toEqual(['accountName', 'AccountRunner', 'refreshAccount'])
  })

  it('ignores declarations inside multiline Python string literals', () => {
    const source = `class AccountRunner:
    """def fake_method(): pass"""
    def refresh_account(self):
        return True
`

    expect(extractMaintainedSymbols(source, 'Python')).toEqual(['AccountRunner', 'refresh_account'])
  })

  it('puts saved related names first and respects the prompt budget', () => {
    const context = buildProjectSymbolContext([
      { codeUnitId: 'unrelated-unit', unitName: 'other.Unrelated', language: 'Java', symbolIndex: ['unrelatedMethod'] },
      { codeUnitId: 'related-unit', unitName: 'example.AccountStore', language: 'Java', symbolIndex: ['loadAccount', 'saveAccount'] },
    ], new Set(['related-unit']), 400)

    expect(context.split('\n')[0]).toContain('example.AccountStore')
    expect(context.length).toBeLessThanOrEqual(400)
  })

  it('keeps same-named units from different artifacts distinct', () => {
    const context = buildProjectSymbolContext([
      { codeUnitId: 'unit-v1', artifactId: 'artifact-v1', artifactName: 'app.apk', artifactHash: '111111111111aaaa', unitName: 'example.ProductStore', language: 'Java', symbolIndex: ['loadProduct'] },
      { codeUnitId: 'unit-v2', artifactId: 'artifact-v2', artifactName: 'app.apk', artifactHash: '222222222222bbbb', unitName: 'example.ProductStore', language: 'Java', symbolIndex: ['fetchProduct', 'saveProduct'] },
    ], new Set())

    expect(context).toContain('example.ProductStore (Java; other artifact app.apk #111111111111; decompiler-output lineage was not recorded for this accepted source): symbols: loadProduct')
    expect(context).toContain('example.ProductStore (Java; other artifact app.apk #222222222222; decompiler-output lineage was not recorded for this accepted source): symbols: fetchProduct, saveProduct')
  })
})
