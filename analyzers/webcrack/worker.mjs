import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { createIsolate } from './sandbox.mjs'
import { applySafeRenames, listRenameBindings, validateSource } from './safe-renames.mjs'
import { recoverSourcesFromMap, sourceMapOutputPath } from './source-maps.mjs'
import { analyzeJavaScript } from './webcrack-runner.mjs'

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeSlug(value) {
  const slug = String(value || 'module').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[.-]+/, '').slice(0, 96)
  return slug || 'module'
}

async function store(units, relativeName, name, type, bundlePath, moduleId, code, budget, metadata = {}) {
  if (typeof code !== 'string' || !code.trim()) return
  const sizeBytes = Buffer.byteLength(code, 'utf8')
  budget.value += sizeBytes
  if (budget.value > workerData.maxOutputBytes) throw new Error('Deobfuscated JavaScript exceeded the configured output limit')
  const target = `${workerData.stagingDirectory}/${relativeName}`
  await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
  await writeFile(target, code, { encoding: 'utf8', flag: 'wx' })
  units.push({
    relativeName,
    name: String(name).slice(0, 500),
    type,
    bundlePath: String(bundlePath || '').slice(0, 1000),
    moduleId: String(moduleId || '').slice(0, 500),
    sizeBytes,
    relativePath: String(metadata.relativePath || '').slice(0, 2_000),
    language: String(metadata.language || 'JavaScript').slice(0, 80),
    origin: metadata.origin === 'source-map' ? 'source-map' : 'webcrack',
    ...(metadata.origin === 'source-map' ? {
      sourceMapRelativePath: String(metadata.sourceMapRelativePath || '').slice(0, 2_000),
      sourceMapSha256: String(metadata.sourceMapSha256 || '').slice(0, 64),
      sourceMapSourcePath: String(metadata.sourceMapSourcePath || '').slice(0, 2_000),
      sourceContentSha256: String(metadata.sourceContentSha256 || '').slice(0, 64),
      ...(metadata.sectionMapRelativePath ? {
        sourceMapSectionRelativePath: String(metadata.sectionMapRelativePath).slice(0, 2_000),
        sourceMapSectionSha256: String(metadata.sectionMapSha256 || '').slice(0, 64),
      } : {}),
    } : {}),
  })
}

try {
  if (workerData.operation === 'list-rename-bindings') {
    parentPort.postMessage({ ok: true, result: listRenameBindings(workerData.code) })
  } else if (workerData.operation === 'apply-safe-renames') {
    parentPort.postMessage({ ok: true, result: applySafeRenames(workerData.code, workerData.expectedSha256, workerData.renames) })
  } else if (workerData.operation === 'validate-javascript-source') {
    const sourceSha256 = digest(workerData.code)
    try {
      parentPort.postMessage({
        ok: true,
        result: { ...validateSource(workerData.code), validationStatus: 'PASSED', validationMessage: `Babel ${workerData.parserVersion} parsed this source without executing it. This confirms syntax only, not behavior or target-version compatibility.` },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/[\r\n\t ]+/g, ' ').slice(0, 500) : 'Babel could not parse this source'
      parentPort.postMessage({
        ok: true,
        result: { sourceSha256, parserVersion: workerData.parserVersion, validationStatus: 'FAILED', validationMessage: `Babel rejected the source: ${message}` },
      })
    }
  } else {
    const result = await analyzeJavaScript(workerData.code, { sandbox: createIsolate })
    const units = []
    const budget = { value: 0 }
    await store(units, 'deobfuscated.js', 'deobfuscated.js', 'file', '', '', result.code, budget, { language: 'JavaScript' })
    const modules = result.bundle?.modules instanceof Map ? result.bundle.modules : new Map()
    let indexedModules = 0
    for (const [moduleId, module] of modules) {
      if (indexedModules >= workerData.maxModules) break
      const id = String(module?.id ?? moduleId)
      const modulePath = typeof module?.path === 'string' ? module.path : ''
      const fileName = `modules/${digest(id).slice(0, 12)}-${safeSlug(modulePath || id)}.js`
      await store(units, fileName, modulePath || `module ${id}`, 'module', modulePath, id, module?.code, budget, { language: 'JavaScript' })
      indexedModules += 1
    }
    if (!units.length) throw new Error('Webcrack did not produce JavaScript source')

    const sourceMapResult = recoverSourcesFromMap(workerData.sourceMap, Math.max(0, workerData.maxOutputBytes - budget.value))
    let recoveredSourceCount = 0
    for (const source of sourceMapResult.sources) {
      const relativeName = sourceMapOutputPath(source.relativeSourcePath, source.sourceSha256)
      await store(units, relativeName, source.relativeSourcePath, 'file', '', `source-map:${source.relativeSourcePath}`, source.content, budget, {
        origin: 'source-map',
        relativePath: source.relativeSourcePath,
        language: source.language,
        sourceMapRelativePath: workerData.sourceMap.relativePath,
        sourceMapSha256: workerData.sourceMap.sha256,
        sourceMapSourcePath: source.relativeSourcePath,
        sourceContentSha256: source.sourceSha256,
        sectionMapRelativePath: source.sectionMapRelativePath,
        sectionMapSha256: source.sectionMapSha256,
      })
      recoveredSourceCount += 1
    }
    const warnings = [
      modules.size > workerData.maxModules ? `Only the first ${workerData.maxModules} bundle modules were indexed.` : '',
      sourceMapResult.warning,
      sourceMapResult.truncated ? 'Source-map sources were capped by source count, per-file size, or output-size limits.' : '',
    ].filter(Boolean).join(' ')
    parentPort.postMessage({
      ok: true,
      result: {
        bundleType: result.bundle?.type || null,
        units,
        codeBytes: budget.value,
        truncated: modules.size > workerData.maxModules || sourceMapResult.truncated,
        sourceMap: workerData.sourceMap ? {
          status: recoveredSourceCount ? 'recovered' : workerData.sourceMap.text ? 'present_without_supported_sources' : 'unavailable',
          relativePath: workerData.sourceMap.relativePath,
          sha256: workerData.sourceMap.sha256,
          recoveredSourceCount,
          truncated: sourceMapResult.truncated,
        } : null,
        warnings,
      },
    })
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'JavaScript analysis failed' })
}
