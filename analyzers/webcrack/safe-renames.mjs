import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'
import traverse from '@babel/traverse'
import generate from '@babel/generator'
import * as t from '@babel/types'

const MAX_SOURCE_BYTES = 512 * 1024
const MAX_BINDINGS = 5_000
const MAX_RENAMES = 200
export const babelParserVersion = JSON.parse(readFileSync(new URL('./node_modules/@babel/parser/package.json', import.meta.url), 'utf8')).version

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parseSource(code) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('JavaScript source is empty')
  if (Buffer.byteLength(code, 'utf8') > MAX_SOURCE_BYTES) throw new Error('JavaScript source exceeds the safe-rename size limit')
  return parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: ['jsx', 'typescript', 'decorators-legacy', 'importAttributes'],
  })
}

export function validateSource(code) {
  parseSource(code)
  return { sourceSha256: digest(code), parserVersion: babelParserVersion }
}

function bindingId(binding) {
  return digest(`${binding.identifier.start}:${binding.identifier.name}`).slice(0, 24)
}

function collectBindings(ast) {
  const bindings = new Map()
  const scopes = new Set()
  const exportedBindings = new Set()
  traverse(ast, {
    ExportNamedDeclaration(path) {
      const declaration = path.node.declaration
      if (declaration) {
        for (const name of Object.keys(t.getBindingIdentifiers(declaration))) {
          const binding = path.scope.getBinding(name)
          if (binding?.identifier && Number.isInteger(binding.identifier.start)) exportedBindings.add(bindingId(binding))
        }
      }
      for (const specifier of path.node.specifiers) {
        if (!t.isExportSpecifier(specifier) || !t.isIdentifier(specifier.local)) continue
        const binding = path.scope.getBinding(specifier.local.name)
        if (binding?.identifier && Number.isInteger(binding.identifier.start)) exportedBindings.add(bindingId(binding))
      }
    },
    ExportDefaultDeclaration(path) {
      const declaration = path.node.declaration
      if (!t.isIdentifier(declaration)) return
      const binding = path.scope.getBinding(declaration.name)
      if (binding?.identifier && Number.isInteger(binding.identifier.start)) exportedBindings.add(bindingId(binding))
    },
    Scopable(path) {
      const scope = path.scope
      scopes.add(scope)
      for (const binding of Object.values(scope.bindings)) {
        if (!binding.identifier || !Number.isInteger(binding.identifier.start)) continue
        const id = bindingId(binding)
        if (bindings.has(id)) continue
        bindings.set(id, {
          id,
          name: binding.identifier.name,
          kind: binding.kind,
          declarationStart: binding.identifier.start,
          referenceCount: binding.referencePaths.length,
          scopeType: scope.path.type,
          exported: exportedBindings.has(id),
          binding,
        })
      }
    },
  })
  const rows = [...bindings.values()].sort((left, right) => left.declarationStart - right.declarationStart)
  if (rows.length > MAX_BINDINGS) throw new Error('JavaScript source contains too many lexical bindings to safely rename')
  return { bindings: rows, scopes }
}

function hiddenBindingCollision(target, newName, scopes) {
  const direct = target.binding.scope.getBinding(newName)
  if (direct && direct !== target.binding) return true
  for (const scope of scopes) {
    if (scope === target.binding.scope || !scope.bindings[newName]) continue
    let parent = scope
    while (parent && parent !== target.binding.scope) parent = parent.parent
    if (parent === target.binding.scope) return true
  }
  return false
}

export function listRenameBindings(code) {
  const ast = parseSource(code)
  const { bindings } = collectBindings(ast)
  return {
    sourceSha256: digest(code),
    bindings: bindings.map(({ id, name, kind, declarationStart, referenceCount, scopeType, exported }) => ({
      id, name, kind, declarationStart, referenceCount, scopeType, exported,
    })),
    truncated: false,
  }
}

export function applySafeRenames(code, expectedSha256, renameRequests) {
  const sourceSha256 = digest(code)
  if (typeof expectedSha256 !== 'string' || expectedSha256.toLowerCase() !== sourceSha256) {
    throw new Error('Source hash changed; reload the source and generate fresh rename suggestions')
  }
  if (!Array.isArray(renameRequests) || renameRequests.length === 0 || renameRequests.length > MAX_RENAMES) {
    throw new Error(`Choose between 1 and ${MAX_RENAMES} rename proposals`)
  }

  const ast = parseSource(code)
  const { bindings, scopes } = collectBindings(ast)
  const byId = new Map(bindings.map((binding) => [binding.id, binding]))
  const seen = new Set()
  const accepted = []
  for (const request of renameRequests) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || typeof request.bindingId !== 'string' || typeof request.newName !== 'string') {
      throw new Error('Each rename must identify a source binding and a new name')
    }
    const target = byId.get(request.bindingId)
    const newName = request.newName.trim()
    if (!target) throw new Error('A proposed binding is no longer present in this source version')
    if (target.exported) throw new Error(`Exported binding “${target.name}” is protected to preserve the module API`)
    if (seen.has(target.id)) throw new Error('A binding can only be renamed once per operation')
    if (!t.isValidIdentifier(newName)) throw new Error(`“${newName.slice(0, 80)}” is not a valid JavaScript identifier`)
    if (newName === target.name) throw new Error(`The proposed name for “${target.name}” is unchanged`)
    if (hiddenBindingCollision(target, newName, scopes)) {
      throw new Error(`Renaming “${target.name}” to “${newName}” would collide with or shadow another binding`)
    }
    seen.add(target.id)
    accepted.push({ target, newName })
  }

  for (const { target, newName } of accepted) target.binding.scope.rename(target.name, newName)
  const output = generate(ast, { comments: true, retainLines: true, compact: false }, code).code
  parseSource(output)
  return {
    sourceCode: output,
    sourceSha256,
    outputSha256: digest(output),
    parserVersion: babelParserVersion,
    renamedBindings: accepted.map(({ target, newName }) => ({
      bindingId: target.id,
      oldName: target.name,
      newName,
      kind: target.kind,
      referenceCount: target.referenceCount,
    })),
  }
}
