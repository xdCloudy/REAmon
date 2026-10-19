import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { agentFetch } from '@/lib/agentFetch'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { applySafeRenameBindings, listSafeRenameBindings, type SafeRenameBinding, type SafeRenameCatalog, type SafeRenameResult } from '@/lib/reamon/webcrack'
import { buildProjectSymbolContext } from '@/lib/reamon/maintenance-memory'

interface RouteParams { params: Promise<{ id: string }> }

const MAX_SOURCE_BYTES = 512 * 1024
const MAX_SUGGESTION_SOURCE_BYTES = 64 * 1024
const MAX_CANDIDATES = 200
const MAX_PROJECT_SYMBOL_SCAN = 4_096

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function digest(source: Buffer): string {
  return createHash('sha256').update(source).digest('hex')
}

async function listPythonRenameBindings(sourceCode: string): Promise<SafeRenameCatalog> {
  const response = await agentFetch('/reamon/code/python/bindings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_code: sourceCode }),
  }, { timeoutMs: 30_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
  if (!response.ok || typeof payload?.source_sha256 !== 'string' || payload.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
      || bindings.length > 5_000 || typeof payload.truncated !== 'boolean'
      || !bindings.every((value) => {
        const binding = plainObject(value)
        return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
          && typeof binding.name === 'string' && binding.name.length > 0 && binding.name.length <= 256
          && typeof binding.kind === 'string' && binding.kind.length <= 80
          && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
          && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
          && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) >= 0
          && binding.exported === false
      })) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Python refactoring service returned an invalid binding catalog')
  }
  return {
    sourceSha256: payload.source_sha256,
    bindings: bindings as SafeRenameBinding[],
    truncated: payload.truncated,
  }
}

async function applyPythonRenameBindings(
  sourceCode: string,
  expectedSha256: string,
  renames: Array<{ bindingId: string; newName: string }>,
): Promise<SafeRenameResult> {
  const response = await agentFetch('/reamon/code/python/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_code: sourceCode,
      expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })),
    }),
  }, { timeoutMs: 30_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const sourceCodeResult = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamedBindings = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(sourceCodeResult, 'utf8')) !== outputSha256 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(parserVersion)
      || Buffer.byteLength(sourceCodeResult, 'utf8') > MAX_SOURCE_BYTES || renamedBindings.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Python refactoring service returned an invalid transformed source')
  }
  return {
    sourceCode: sourceCodeResult,
    sourceSha256: expectedSha256,
    outputSha256,
    parserVersion,
    renamedBindings: renamedBindings as SafeRenameResult['renamedBindings'],
  }
}

async function refactorPhpBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/php/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 120_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 200
        || payload?.parser_version !== '2026.10.07.0'
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[a-z_][A-Za-z0-9_]{0,127}$/.test(binding.name)
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Phpactor returned an invalid binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: Boolean(payload.truncated) }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || payload?.parser_version !== '2026.10.07.0'
      || payload?.validation_status !== 'PASSED' || typeof payload.validation_method !== 'string'
      || !/^php-\d+\.\d+(?:\.\d+)?-syntax-check$/.test(payload.validation_method)
      || typeof payload.validation_message !== 'string'
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Phpactor returned invalid transformed PHP source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion: String(payload.parser_version), renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorRubyBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/ruby/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 120_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 200
        || payload?.parser_version !== '0.60.4'
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.name)
            && ['variable', 'parameter'].includes(String(binding.kind))
            && binding.scopeType === 'local'
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Solargraph returned an invalid Ruby binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: payload.truncated }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || payload?.parser_version !== '0.60.4'
      || payload?.validation_status !== 'PASSED' || typeof payload.validation_method !== 'string'
      || !/^ruby-\d+\.\d+(?:\.\d+)?-syntax-check$/.test(payload.validation_method)
      || typeof payload.validation_message !== 'string'
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Solargraph returned invalid transformed Ruby source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion: '0.60.4', renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function listGoRenameBindings(sourceCode: string): Promise<SafeRenameCatalog> {
  const response = await agentFetch('/reamon/code/go/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'bindings', source_code: sourceCode }),
  }, { timeoutMs: 30_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
  if (!response.ok || typeof payload?.source_sha256 !== 'string' || payload.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
      || bindings.length > 5_000 || typeof payload.truncated !== 'boolean'
      || typeof payload.parser_version !== 'string' || !/^go\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(payload.parser_version)
      || !bindings.every((value) => {
        const binding = plainObject(value)
        return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
          && typeof binding.name === 'string' && binding.name.length > 0 && binding.name.length <= 256
          && typeof binding.kind === 'string' && binding.kind.length <= 80
          && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
          && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
          && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) >= 0
          && binding.exported === false
      })) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Go refactoring service returned an invalid binding catalog')
  }
  return { sourceSha256: payload.source_sha256, bindings: bindings as SafeRenameBinding[], truncated: payload.truncated }
}

async function applyGoRenameBindings(
  sourceCode: string,
  expectedSha256: string,
  renames: Array<{ bindingId: string; newName: string }>,
): Promise<SafeRenameResult> {
  const response = await agentFetch('/reamon/code/go/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation: 'rename', source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })),
    }),
  }, { timeoutMs: 30_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || !/^go\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(parserVersion)
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Go refactoring service returned an invalid transformed source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion, renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorRustBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/rust/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 120_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 5_000
        || payload?.parser_version !== '2026-10-12'
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && binding.name.length > 0 && binding.name.length <= 256
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'rust-analyzer returned an invalid binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: Boolean(payload.truncated) }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || payload?.parser_version !== '2026-10-12'
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'rust-analyzer returned an invalid transformed source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion: '2026-10-12', renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorLuaBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  runtime: string,
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/lua/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operation,
      runtime,
      source_code: sourceCode,
      expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })),
    }),
  }, { timeoutMs: 120_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || typeof payload?.source_sha256 !== 'string' || payload.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || bindings.length > 200 || typeof payload.truncated !== 'boolean'
        || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(payload.parser_version || ''))
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.name)
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) {
      throw new Error(typeof payload?.error === 'string' ? payload.error : 'LuaLS returned an invalid binding catalog')
    }
    return { sourceSha256: payload.source_sha256, bindings: bindings as SafeRenameBinding[], truncated: payload.truncated }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parserVersion)
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'LuaLS returned an invalid transformed source')
  }
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion, renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorCSharpBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/csharp/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 40_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 5_000
        || !/^\d+\.\d+\.\d+$/.test(String(payload?.parser_version || ''))
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.name)
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Roslyn returned an invalid binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: Boolean(payload.truncated) }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || !/^\d+\.\d+\.\d+$/.test(parserVersion)
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length)
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Roslyn returned an invalid transformed source')
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion, renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

async function refactorJavaBindings(
  sourceCode: string,
  operation: 'bindings' | 'rename',
  expectedSha256 = '',
  renames: Array<{ bindingId: string; newName: string }> = [],
): Promise<SafeRenameCatalog | SafeRenameResult> {
  const response = await agentFetch('/reamon/code/java/refactor', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, source_code: sourceCode, expected_sha256: expectedSha256,
      renames: renames.map((rename) => ({ binding_id: rename.bindingId, new_name: rename.newName })) }),
  }, { timeoutMs: 40_000 })
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (operation === 'bindings') {
    const bindings = Array.isArray(payload?.bindings) ? payload.bindings : []
    if (!response.ok || payload?.source_sha256 !== digest(Buffer.from(sourceCode, 'utf8'))
        || typeof payload?.truncated !== 'boolean' || bindings.length > 5_000
        || !/^\d+\.\d+\.\d+$/.test(String(payload?.parser_version || ''))
        || !bindings.every((value) => {
          const binding = plainObject(value)
          return /^[a-f0-9]{24}$/i.test(String(binding.id || ''))
            && typeof binding.name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(binding.name)
            && typeof binding.kind === 'string' && binding.kind.length <= 80
            && typeof binding.scopeType === 'string' && binding.scopeType.length <= 80
            && Number.isSafeInteger(binding.declarationStart) && Number(binding.declarationStart) >= 0
            && Number.isSafeInteger(binding.referenceCount) && Number(binding.referenceCount) > 0
            && binding.exported === false
        })) throw new Error(typeof payload?.error === 'string' ? payload.error : 'javac returned an invalid binding catalog')
    return { sourceSha256: String(payload.source_sha256), bindings: bindings as SafeRenameBinding[], truncated: Boolean(payload.truncated) }
  }
  const output = typeof payload?.source_code === 'string' ? payload.source_code : ''
  const renamed = Array.isArray(payload?.renamed_bindings) ? payload.renamed_bindings : []
  const outputSha256 = typeof payload?.output_sha256 === 'string' ? payload.output_sha256 : ''
  const parserVersion = typeof payload?.parser_version === 'string' ? payload.parser_version : ''
  if (!response.ok || payload?.source_sha256 !== expectedSha256 || !/^[a-f0-9]{64}$/i.test(outputSha256)
      || digest(Buffer.from(output, 'utf8')) !== outputSha256 || !/^\d+\.\d+\.\d+$/.test(parserVersion)
      || Buffer.byteLength(output, 'utf8') > MAX_SOURCE_BYTES || renamed.length !== renames.length)
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'javac returned an invalid transformed source')
  return { sourceCode: output, sourceSha256: expectedSha256, outputSha256, parserVersion, renamedBindings: renamed as SafeRenameResult['renamedBindings'] }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    let rawBody: unknown
    try { rawBody = await request.json() } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    const body = plainObject(rawBody)
    const operation = body.operation
    const unitId = typeof body.unitId === 'string' ? body.unitId.trim() : ''
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
    if (!unitId || unitId.length > 128 || !['suggest', 'apply'].includes(String(operation))) {
      return NextResponse.json({ error: 'A code unit and safe-rename operation are required' }, { status: 400 })
    }

    const observation = await prisma.reamonObservation.findFirst({
      where: { id: unitId, projectId, type: 'code_unit' },
      select: { id: true, artifactId: true, taskId: true, label: true, attributes: true },
    })
    if (!observation?.artifactId) return NextResponse.json({ error: 'Code unit not found' }, { status: 404 })
    const attributes = plainObject(observation.attributes)
    const language = typeof attributes.language === 'string' ? attributes.language.trim() : ''
    const normalizedLanguage = language.toLowerCase()
    const isPython = ['python', 'python 3', 'python3'].includes(normalizedLanguage)
    const isPhp = ['php', 'php source'].includes(normalizedLanguage)
    const isRuby = ['ruby', 'ruby source', 'rb'].includes(normalizedLanguage)
    const isRust = ['rust', 'rust source', 'rustlang'].includes(normalizedLanguage)
    const isJava = ['java', 'java source'].includes(normalizedLanguage)
    const isCSharp = ['c#', 'csharp', 'cs'].includes(normalizedLanguage)
    const isGo = ['go', 'golang'].includes(normalizedLanguage)
    const dialect = typeof attributes.dialect === 'string' ? attributes.dialect.toLowerCase().replace(/\s+/g, '') : ''
    const isLuau = ['luau', 'luau source'].includes(normalizedLanguage) || dialect === 'luau'
    const isLua = ['lua', 'lua source'].includes(normalizedLanguage) || /^lua(?: source)?\s+5\.[1-5]$/.test(normalizedLanguage)
    const luaRuntime = isLuau ? 'Luau' : dialect === 'luajit' ? 'LuaJIT' : /^lua5\.[1-5]$/.test(dialect) ? `Lua ${dialect.slice(3)}`
      : (normalizedLanguage.match(/5\.[1-5]/)?.[0] ? `Lua ${normalizedLanguage.match(/5\.[1-5]/)?.[0]}` : 'Lua 5.5')
    if (isLua && !isLuau && dialect && dialect !== 'luajit' && !/^lua5\.[1-5]$/.test(dialect)) {
      return NextResponse.json({ error: 'LuaLS scope-safe renaming supports Lua 5.1–5.5 and LuaJIT; this source dialect is not supported' }, { status: 415 })
    }
    if (!['javascript', 'typescript', 'jsx', 'tsx', 'python', 'python 3', 'python3', 'php', 'php source', 'ruby', 'ruby source', 'rb', 'go', 'golang', 'lua', 'lua source'].includes(normalizedLanguage)
        && !isLua && !isLuau && !isCSharp && !isJava && !isRust) {
      return NextResponse.json({ error: 'Scope-safe renaming currently supports JavaScript, TypeScript, Python, PHP, Ruby, Go, Lua, Luau, Java, C#, and Rust source' }, { status: 415 })
    }
    const codeArtifactId = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
    const selection = await getActiveWorkspaceImportSelection(projectId)
    const artifact = await prisma.artifact.findFirst({
      where: { AND: [{ id: observation.artifactId, projectId }, selection.artifactWhere] },
      select: { id: true, sha256: true },
    })
    if (!artifact) return NextResponse.json({ error: 'Code unit is not part of the active workspace' }, { status: 404 })
    const prefix = `${projectId}/${artifact.id}/`
    const segments = codeArtifactId.split('/')
    if (!codeArtifactId.startsWith(prefix) || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
      return NextResponse.json({ error: 'Code unit has no valid linked source artifact' }, { status: 404 })
    }
    const root = derivedArtifactRoot()
    const candidatePath = resolveDerivedArtifactPath(codeArtifactId)
    const [rootRealPath, sourceRealPath] = await Promise.all([realpath(root), realpath(candidatePath).catch(() => null)])
    if (!sourceRealPath || !isInside(rootRealPath, sourceRealPath)) return NextResponse.json({ error: 'Linked source path is invalid' }, { status: 404 })
    const info = await stat(sourceRealPath)
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return NextResponse.json({ error: `Linked ${isJava ? 'Java' : isCSharp ? 'C#' : isGo ? 'Go' : isPython ? 'Python' : isPhp ? 'PHP' : isRuby ? 'Ruby' : isRust ? 'Rust' : isLua ? 'Lua' : 'JavaScript'} source exceeds the safe-rename limit` }, { status: 413 })
    const sourceBytes = await readFile(sourceRealPath)
    const sourceCode = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
    const artifactSourceSha256 = digest(sourceBytes)
    const workingSource = typeof body.sourceCode === 'string' ? body.sourceCode : sourceCode
    const workingBytes = Buffer.from(workingSource, 'utf8')
    if (workingBytes.byteLength > MAX_SOURCE_BYTES) return NextResponse.json({ error: `Editable ${isJava ? 'Java' : isCSharp ? 'C#' : isGo ? 'Go' : isPython ? 'Python' : isPhp ? 'PHP' : isRuby ? 'Ruby' : isRust ? 'Rust' : isLua ? 'Lua' : 'JavaScript'} source exceeds the safe-rename limit` }, { status: 413 })
    const workingSourceSha256 = digest(workingBytes)
    const runKey = segments.slice(0, 4).join('/')
    const unitName = (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
      || (typeof attributes.name === 'string' && attributes.name)
      || `Selected ${isJava ? 'Java' : isCSharp ? 'C#' : isGo ? 'Go' : isPython ? 'Python' : isPhp ? 'PHP' : isRuby ? 'Ruby' : isRust ? 'Rust' : isLua ? 'Lua' : 'JavaScript'} unit`

    if (operation === 'suggest') {
      if (!providerId || providerId.length > 128) return NextResponse.json({ error: 'Choose a saved AI provider' }, { status: 400 })
      if (workingBytes.byteLength > MAX_SUGGESTION_SOURCE_BYTES) return NextResponse.json({ error: 'This source is too large for AI rename suggestions' }, { status: 413 })
      const provider = await prisma.userLlmProvider.findFirst({
        where: { id: providerId, userId: user.userId, providerType: 'openai_compatible' },
        select: { id: true, modelIdentifier: true },
      })
      if (!provider) return NextResponse.json({ error: 'Saved OpenAI-compatible provider not found' }, { status: 404 })

      const catalog = isJava
        ? await refactorJavaBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isCSharp
        ? await refactorCSharpBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isGo
        ? await listGoRenameBindings(workingSource)
        : isPhp ? await refactorPhpBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isRuby ? await refactorRubyBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isRust ? await refactorRustBindings(workingSource, 'bindings') as SafeRenameCatalog
        : isPython ? await listPythonRenameBindings(workingSource)
        : isLuau ? await refactorLuaBindings(workingSource, 'bindings', luaRuntime) as SafeRenameCatalog
          : isLua ? await refactorLuaBindings(workingSource, 'bindings', luaRuntime) as SafeRenameCatalog
            : await listSafeRenameBindings(workingSource)
      const candidates = catalog.bindings
        .filter((binding) => !binding.exported && binding.kind !== 'module' && binding.referenceCount > 0
          && (binding.name.length <= 3 || /^_?(?:0x[\da-f]{4,}|[\da-f]{6,})$/i.test(binding.name)))
        .slice(0, MAX_CANDIDATES)
      if (!candidates.length) {
        const projectSymbolContextSha256 = digest(Buffer.alloc(0))
        const savedAttempt = await prisma.reamonCodeAttempt.create({
          data: {
            projectId, ownerUserId: user.userId, artifactId: artifact.id, runKey, codeUnitId: observation.id,
            unitName: unitName.slice(0, 500), language, sourceHash: artifactSourceSha256,
            providerName: 'REAmon scope-safe rename suggestions', modelIdentifier: provider.modelIdentifier.slice(0, 128),
            question: (typeof body.question === 'string' ? body.question : '').slice(0, 1000),
            scope: 'rename-suggestions', status: 'SUCCEEDED',
            requestPayload: { operation: 'scope-safe-rename-suggestions', providerId: provider.id, modelIdentifier: provider.modelIdentifier, inputSha256: workingSourceSha256, artifactSourceSha256, inputSource: workingSource, bindings: [], projectSymbolContext: '', projectSymbolContextSha256, renames: [] },
            syntaxValidated: false, validationStatus: 'UNAVAILABLE', validationMethod: 'proposal-only',
            validationMessage: 'No eligible obfuscated local bindings were found; no rename proposal was generated.', completedAt: new Date(),
          },
          select: { id: true },
        })
        return NextResponse.json({ sourceSha256: workingSourceSha256, providerId: provider.id, providerName: 'REAmon scope-safe renames', model: provider.modelIdentifier, attemptId: savedAttempt.id, projectSymbolContextSha256, candidates: 0, renames: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
      }

      const priorAttempts = await prisma.reamonCodeAttempt.findMany({
        where: {
          projectId,
          artifactId: artifact.id,
          runKey,
          codeUnitId: observation.id,
          sourceHash: artifactSourceSha256,
          scope: 'rename-suggestions',
          status: 'SUCCEEDED',
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, createdAt: true, requestPayload: true },
      })
      const priorSuggestionContext = priorAttempts.flatMap((attempt) => {
        const payload = plainObject(attempt.requestPayload)
        if (payload.operation !== 'scope-safe-rename-suggestions' || payload.inputSha256 !== workingSourceSha256
            || !Array.isArray(payload.renames)) return []
        const proposals = payload.renames.flatMap((value) => {
          const rename = plainObject(value)
          if (typeof rename.bindingId !== 'string' || typeof rename.oldName !== 'string' || typeof rename.newName !== 'string'
              || typeof rename.kind !== 'string' || typeof rename.rationale !== 'string') return []
          return [{ bindingId: rename.bindingId.slice(0, 128), oldName: rename.oldName.slice(0, 256), newName: rename.newName.slice(0, 128), kind: rename.kind.slice(0, 80), rationale: rename.rationale.slice(0, 400) }]
        }).slice(0, 80)
        return proposals.length ? [{ id: attempt.id, createdAt: attempt.createdAt.toISOString(), proposals }] : []
      })
      const priorSuggestionText = priorSuggestionContext.length
        ? JSON.stringify({ notice: 'These are unreviewed prior proposals, not accepted names or evidence. Use only as weak consistency hints and independently verify every suggestion in the current source.', attempts: priorSuggestionContext })
        : ''
      let boundedPriorSuggestionText = priorSuggestionText
      while (Buffer.byteLength(boundedPriorSuggestionText, 'utf8') > 8 * 1024 && priorSuggestionContext.length) {
        const latest = priorSuggestionContext[priorSuggestionContext.length - 1]
        latest.proposals.pop()
        if (!latest.proposals.length) priorSuggestionContext.pop()
        boundedPriorSuggestionText = priorSuggestionContext.length
          ? JSON.stringify({ notice: 'These are unreviewed prior proposals, not accepted names or evidence. Use only as weak consistency hints and independently verify every suggestion in the current source.', attempts: priorSuggestionContext })
          : ''
      }

      const [currentArtifactSymbolRows, otherProjectSymbolRows] = await Promise.all([
        prisma.reamonMaintainedSource.findMany({
          where: { projectId, artifactId: artifact.id },
          select: { codeUnitId: true, artifactId: true, unitName: true, language: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: MAX_PROJECT_SYMBOL_SCAN + 1,
        }),
        prisma.reamonMaintainedSource.findMany({
          where: { projectId, artifactId: { not: artifact.id } },
          select: { codeUnitId: true, artifactId: true, unitName: true, language: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: MAX_PROJECT_SYMBOL_SCAN + 1,
        }),
      ])
      const projectSymbolScanTruncated = currentArtifactSymbolRows.length > MAX_PROJECT_SYMBOL_SCAN
        || otherProjectSymbolRows.length > MAX_PROJECT_SYMBOL_SCAN
      const symbolRows = [...currentArtifactSymbolRows.slice(0, MAX_PROJECT_SYMBOL_SCAN), ...otherProjectSymbolRows.slice(0, MAX_PROJECT_SYMBOL_SCAN)]
      const reviewIds = [...new Set(symbolRows.flatMap((row) => row.acceptedReviewId ? [row.acceptedReviewId] : []))]
      const reviews = reviewIds.length ? await prisma.reamonCodeReview.findMany({
        where: { projectId, id: { in: reviewIds }, decision: 'ACCEPTED' },
        select: { id: true, artifactId: true, codeUnitId: true, maintainedSourceHash: true, validationStatus: true, validationMethod: true },
      }) : []
      const reviewById = new Map(reviews.map((review) => [review.id, review]))
      const trustedRows = symbolRows.filter((row) => {
        if (!row.acceptedReviewId || !row.sourceHash) return false
        const receipt = reviewById.get(row.acceptedReviewId)
        return receipt?.artifactId === row.artifactId
          && receipt.codeUnitId === row.codeUnitId
          && receipt.maintainedSourceHash === row.sourceHash
      })
      const artifactIds = [...new Set(trustedRows.map((row) => row.artifactId))]
      const artifacts = artifactIds.length ? await prisma.artifact.findMany({
        where: { projectId, id: { in: artifactIds } },
        select: { id: true, originalName: true, sha256: true },
      }) : []
      const artifactById = new Map(artifacts.map((row) => [row.id, row]))
      const projectSymbolContext = buildProjectSymbolContext(trustedRows.map((row) => {
        const receipt = row.acceptedReviewId ? reviewById.get(row.acceptedReviewId) : undefined
        return {
          ...row,
          artifactName: artifactById.get(row.artifactId)?.originalName,
          artifactHash: artifactById.get(row.artifactId)?.sha256,
          validationStatus: receipt?.validationStatus,
          validationMethod: receipt?.validationMethod,
        }
      }), new Set(), 6_000, artifact.sha256 || undefined, undefined, projectSymbolScanTruncated,
      candidates.map(({ name, kind }) => ({ language, name, kind })))
      const response = await agentFetch('/reamon/code/suggest-renames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `custom/${provider.id}`,
          user_id: user.userId,
          unit_name: unitName,
          language: isJava ? 'Java' : isCSharp ? 'C#' : isGo ? 'Go' : isPython ? 'Python' : isPhp ? 'PHP' : isRust ? 'Rust' : isLua ? 'Lua' : language,
          source_code: workingSource,
          bindings: candidates,
          project_symbol_context: projectSymbolContext,
          prior_suggestion_context: boundedPriorSuggestionText,
          question: typeof body.question === 'string' ? body.question.slice(0, 1000) : '',
        }),
      }, { timeoutMs: 120_000 })
      const result = await response.json().catch(() => null) as { renames?: unknown; error?: string } | null
      if (!response.ok || !result || !Array.isArray(result.renames)) {
        return NextResponse.json({ error: result?.error || 'Could not generate rename suggestions' }, { status: response.status || 502 })
      }
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
      const renames = result.renames.flatMap((value) => {
        const rename = plainObject(value)
        const binding = typeof rename.bindingId === 'string' ? candidateById.get(rename.bindingId) : undefined
        if (!binding || rename.oldName !== binding.name || typeof rename.newName !== 'string' || rename.newName.length > 128
            || typeof rename.rationale !== 'string') return []
        return [{
          bindingId: binding.id,
          oldName: binding.name,
          newName: rename.newName,
          kind: binding.kind,
          referenceCount: binding.referenceCount,
          rationale: rename.rationale.slice(0, 400),
        }]
      }).slice(0, 80)
      const projectSymbolContextSha256 = digest(Buffer.from(projectSymbolContext, 'utf8'))
      const savedAttempt = await prisma.reamonCodeAttempt.create({
        data: {
          projectId,
          ownerUserId: user.userId,
          artifactId: artifact.id,
          runKey,
          codeUnitId: observation.id,
          unitName: unitName.slice(0, 500),
          language,
          sourceHash: artifactSourceSha256,
          providerName: 'REAmon scope-safe rename suggestions',
          modelIdentifier: provider.modelIdentifier.slice(0, 128),
          question: (typeof body.question === 'string' ? body.question : '').slice(0, 1000),
          scope: 'rename-suggestions',
          status: 'SUCCEEDED',
          requestPayload: {
            operation: 'scope-safe-rename-suggestions',
            providerId: provider.id,
            modelIdentifier: provider.modelIdentifier,
            engine: 'AI rename proposals grounded in immutable source and accepted project-symbol memory',
            inputSha256: workingSourceSha256,
            artifactSourceSha256,
            inputSource: workingSource,
            bindings: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, kind: candidate.kind, scopeType: candidate.scopeType, referenceCount: candidate.referenceCount, exported: candidate.exported })),
            projectSymbolContext,
            projectSymbolContextSha256,
            projectSymbolScanTruncated,
            priorSuggestionContext: boundedPriorSuggestionText,
            renames,
          },
          syntaxValidated: false,
          validationStatus: 'UNAVAILABLE',
          validationMethod: 'proposal-only',
          validationMessage: 'Suggestions are saved as unreviewed proposals. Syntax and binding validation runs only after selected names are applied.',
          completedAt: new Date(),
        },
        select: { id: true },
      })
      return NextResponse.json({
        sourceSha256: workingSourceSha256,
        providerId: provider.id,
        providerName: 'REAmon scope-safe renames',
        model: provider.modelIdentifier,
        attemptId: savedAttempt.id,
        projectSymbolContextSha256,
        candidates: candidates.length,
        renames,
      }, { headers: { 'Cache-Control': 'private, no-store' } })
    }

    const expectedSha256 = typeof body.expectedSha256 === 'string' ? body.expectedSha256.toLowerCase() : ''
    if (expectedSha256 !== workingSourceSha256) return NextResponse.json({ error: 'The source changed after rename suggestions were generated. Reload and retry.' }, { status: 409 })
    if (!providerId || providerId.length > 128) return NextResponse.json({ error: 'Choose the saved provider used for rename suggestions' }, { status: 400 })
    const provider = await prisma.userLlmProvider.findFirst({
      where: { id: providerId, userId: user.userId, providerType: 'openai_compatible' },
      select: { id: true, name: true, modelIdentifier: true },
    })
    if (!provider) return NextResponse.json({ error: 'Saved OpenAI-compatible provider not found' }, { status: 404 })
    const suggestionAttemptId = typeof body.suggestionAttemptId === 'string' ? body.suggestionAttemptId : ''
    if (!suggestionAttemptId || suggestionAttemptId.length > 128) return NextResponse.json({ error: 'The saved rename proposal is missing; generate suggestions again' }, { status: 400 })
    const suggestionAttempt = await prisma.reamonCodeAttempt.findFirst({
      where: {
        id: suggestionAttemptId,
        projectId,
        artifactId: artifact.id,
        runKey,
        codeUnitId: observation.id,
        sourceHash: artifactSourceSha256,
        scope: 'rename-suggestions',
        status: 'SUCCEEDED',
        providerName: 'REAmon scope-safe rename suggestions',
      },
      select: { id: true, requestPayload: true },
    })
    const proposalPayload = plainObject(suggestionAttempt?.requestPayload)
    const savedRenames = Array.isArray(proposalPayload.renames) ? proposalPayload.renames : []
    if (!suggestionAttempt || proposalPayload.operation !== 'scope-safe-rename-suggestions' || proposalPayload.providerId !== provider.id
        || proposalPayload.modelIdentifier !== provider.modelIdentifier || proposalPayload.inputSha256 !== workingSourceSha256
        || typeof proposalPayload.projectSymbolContext !== 'string' || typeof proposalPayload.projectSymbolContextSha256 !== 'string'
        || proposalPayload.projectSymbolContextSha256 !== digest(Buffer.from(proposalPayload.projectSymbolContext, 'utf8'))) {
      return NextResponse.json({ error: 'The saved rename proposal does not match this source and project context; generate suggestions again' }, { status: 409 })
    }

    const requests = Array.isArray(body.renames) ? body.renames : []
    if (requests.length < 1 || requests.length > 80) return NextResponse.json({ error: 'Select between 1 and 80 rename suggestions' }, { status: 400 })
    const catalog = isJava
      ? await refactorJavaBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isCSharp
      ? await refactorCSharpBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isGo
      ? await listGoRenameBindings(workingSource)
      : isPhp ? await refactorPhpBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isRuby ? await refactorRubyBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isRust ? await refactorRustBindings(workingSource, 'bindings') as SafeRenameCatalog
      : isPython ? await listPythonRenameBindings(workingSource)
        : isLua ? await refactorLuaBindings(workingSource, 'bindings', luaRuntime) as SafeRenameCatalog
          : await listSafeRenameBindings(workingSource)
    const available = new Map(catalog.bindings.map((binding) => [binding.id, binding]))
    for (const rename of requests) {
      const item = plainObject(rename)
      const binding = typeof item.bindingId === 'string' ? available.get(item.bindingId) : undefined
      const saved = savedRenames.map(plainObject).find((proposal) => proposal.bindingId === item.bindingId)
      if (!binding || binding.exported || typeof item.newName !== 'string' || item.oldName !== binding.name
          || typeof item.rationale !== 'string' || item.rationale.length > 400
          || !saved || saved.oldName !== item.oldName || saved.newName !== item.newName || saved.kind !== binding.kind || saved.rationale !== item.rationale) {
        return NextResponse.json({ error: 'A selected rename no longer matches the current source bindings' }, { status: 409 })
      }
    }
    const selectedRenames = requests.map((rename) => {
      const item = plainObject(rename)
      return { bindingId: String(item.bindingId), newName: String(item.newName) }
    })
    const transformed = isJava
      ? await refactorJavaBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isCSharp
      ? await refactorCSharpBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isGo
      ? await applyGoRenameBindings(workingSource, workingSourceSha256, selectedRenames)
      : isPhp ? await refactorPhpBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isRuby ? await refactorRubyBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isRust ? await refactorRustBindings(workingSource, 'rename', workingSourceSha256, selectedRenames) as SafeRenameResult
      : isPython ? await applyPythonRenameBindings(workingSource, workingSourceSha256, selectedRenames)
        : isLuau ? await refactorLuaBindings(workingSource, 'rename', luaRuntime, workingSourceSha256, selectedRenames) as SafeRenameResult
        : isLua ? await refactorLuaBindings(workingSource, 'rename', luaRuntime, workingSourceSha256, selectedRenames) as SafeRenameResult
          : await applySafeRenameBindings(workingSource, workingSourceSha256, selectedRenames)
    const validationMethod = isPhp
      ? `phpactor-${transformed.parserVersion}+php-scope-safe-rename`
      : isRuby
      ? `solargraph-${transformed.parserVersion}+ruby-scope-safe-rename`
      : isJava
      ? `javac-${transformed.parserVersion}-release17+java-scope-safe-rename`
      : isCSharp
      ? `roslyn-${transformed.parserVersion}+csharp-scope-safe-rename`
      : isGo
      ? `${transformed.parserVersion}+go-ast-types-scope-safe-rename`
      : isRust ? `rust-analyzer-${transformed.parserVersion}+lsp-semantic-local-rename`
      : isPython ? `libcst-${transformed.parserVersion}+scope-safe-rename`
        : isLuau ? `luau-lsp-${transformed.parserVersion}+scope-safe-rename`
        : isLua ? `luals-${transformed.parserVersion}+tree-sitter-lua-scope-safe-rename`
          : `babel-parser-${transformed.parserVersion}+scope-safe-rename`
    const validationMessage = isPhp
      ? `Phpactor ${transformed.parserVersion} resolved selected local PHP bindings and PHP lint parsed the rewritten source without executing it. This does not verify project dependencies, dynamic lookups, or behavior.`
      : isRuby
      ? `Solargraph ${transformed.parserVersion} resolved same-file local and parameter bindings, Ripper constrained every edit to local identifier tokens, and Ruby syntax validation passed without executing the source. Keyword labels, cross-file references, project dependencies, and behavior are not validated.`
      : isJava
      ? `javac ${transformed.parserVersion} resolved selected Java bindings and the output was reparsed with selected references checked against their declarations. This is syntax and binding evidence only; it does not validate project dependencies or runtime equivalence.`
      : isCSharp
      ? `Roslyn ${transformed.parserVersion} resolved selected C# local bindings and parsed the renamed output. This confirms syntax only; it does not validate project references, compilation, or runtime equivalence.`
      : isGo
      ? `Go ${transformed.parserVersion} parsed the output after object-identity-based local binding renames. This confirms syntax only; missing package dependencies, build behavior, and runtime equivalence are not validated.`
      : isRust
      ? `rust-analyzer ${transformed.parserVersion} resolved the selected local binding and returned the complete same-file reference set; Tree-sitter parsed the output. This does not validate project dependencies, build behavior, or runtime equivalence.`
      : isPython
        ? `LibCST ${transformed.parserVersion} applied scope-aware local-binding renames and parsed the output. This confirms structure only, not module-level references or behavior equivalence.`
        : isLuau
          ? `Luau LSP ${transformed.parserVersion} resolved the selected Luau binding and applied its single-source rename edits; syntax was checked without executing the source. This does not verify project API definitions or runtime behavior.`
        : isLua
          ? `LuaLS ${transformed.parserVersion} resolved the selected local binding and applied its single-source rename edits; Tree-sitter parsed the output. LuaLS references and parsing do not prove behavior equivalence.`
          : `Babel ${transformed.parserVersion} parsed the output after scope-aware renaming and rejected binding collisions. This confirms syntax only, not behavior equivalence.`
    const attempt = await prisma.reamonCodeAttempt.create({
      data: {
        projectId,
        ownerUserId: user.userId,
        artifactId: artifact.id,
        runKey,
        codeUnitId: observation.id,
        unitName: unitName.slice(0, 500),
        language,
        sourceHash: artifactSourceSha256,
        providerName: 'REAmon scope-safe renames',
        modelIdentifier: provider.modelIdentifier.slice(0, 128),
        question: 'Apply accepted evidence-backed identifier rename proposals',
        scope: 'file',
        status: 'SUCCEEDED',
        requestPayload: {
          operation: isPhp ? 'phpactor-php-lsp-scope-safe-renames' : isRuby ? 'solargraph-ruby-semantic-local-renames' : isJava ? 'javac-java-scope-safe-renames' : isCSharp ? 'roslyn-csharp-scope-safe-renames' : isGo ? 'go-types-scope-safe-renames' : isRust ? 'rust-analyzer-rust-lsp-semantic-local-renames' : isPython ? 'libcst-scope-safe-renames' : isLuau ? 'luau-lsp-semantic-local-renames' : isLua ? 'luals-scope-safe-renames' : 'humanify-style-scope-safe-renames',
          engine: isPhp ? `Phpactor ${transformed.parserVersion} LSP semantic rename; PHP lint` : isRuby ? `Solargraph ${transformed.parserVersion} references resolved by binding path; Ripper token allowlist; ruby -c` : isJava ? `JDK javac ${transformed.parserVersion} --release 17 Trees/Element symbol identity` : isCSharp ? `Roslyn ${transformed.parserVersion} semantic model and symbol identity` : isGo ? `Go ${transformed.parserVersion} AST and go/types object identity` : isRust ? `rust-analyzer ${transformed.parserVersion} LSP references + rename` : isPython ? `LibCST ${transformed.parserVersion} ScopeProvider/RenameCommand` : isLuau ? `Luau LSP ${transformed.parserVersion} semantic rename + Luau compiler parse` : isLua ? `LuaLS ${transformed.parserVersion} LSP rename + Tree-sitter Lua parse` : `Babel ${transformed.parserVersion} scope.rename (Humanify two-stage design)`,
          inputSha256: workingSourceSha256,
          artifactSourceSha256,
          inputSource: workingSource,
          suggestionAttemptId: suggestionAttempt.id,
          projectSymbolContextSha256: proposalPayload.projectSymbolContextSha256,
          outputSha256: transformed.outputSha256,
          renames: transformed.renamedBindings.map((binding) => ({
            ...binding,
            rationale: String(plainObject(requests.find((rename) => plainObject(rename).bindingId === binding.bindingId)).rationale || '').slice(0, 400),
          })),
        },
        resultSource: transformed.sourceCode,
        syntaxValidated: true,
        validationStatus: 'PASSED',
        validationMethod,
        validationMessage,
        completedAt: new Date(),
      },
      select: { id: true },
    })
    return NextResponse.json({
      sourceCode: transformed.sourceCode,
      sourceSha256: workingSourceSha256,
      outputSha256: transformed.outputSha256,
      renamedBindings: transformed.renamedBindings,
      attemptId: attempt.id,
      providerName: 'REAmon scope-safe renames',
      model: provider.modelIdentifier,
      syntaxValidated: true,
      validationStatus: 'PASSED',
      validationMethod,
      validationMessage,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to apply REAmon safe renames:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Could not process safe rename request' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
