import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { createIsolate } from './sandbox.mjs'
import { analyzeJavaScript } from './webcrack-runner.mjs'

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeSlug(value) {
  const slug = String(value || 'module').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[.-]+/, '').slice(0, 96)
  return slug || 'module'
}

async function store(units, relativeName, name, type, bundlePath, moduleId, code, budget) {
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
  })
}

try {
  const result = await analyzeJavaScript(workerData.code, { sandbox: createIsolate })
  const units = []
  const budget = { value: 0 }
  await store(units, 'deobfuscated.js', 'deobfuscated.js', 'file', '', '', result.code, budget)
  const modules = result.bundle?.modules instanceof Map ? result.bundle.modules : new Map()
  let indexedModules = 0
  for (const [moduleId, module] of modules) {
    if (indexedModules >= workerData.maxModules) break
    const id = String(module?.id ?? moduleId)
    const modulePath = typeof module?.path === 'string' ? module.path : ''
    const fileName = `modules/${digest(id).slice(0, 12)}-${safeSlug(modulePath || id)}.js`
    await store(units, fileName, modulePath || `module ${id}`, 'module', modulePath, id, module?.code, budget)
    indexedModules += 1
  }
  if (!units.length) throw new Error('Webcrack did not produce JavaScript source')
  parentPort.postMessage({
    ok: true,
    result: {
      bundleType: result.bundle?.type || null,
      units,
      codeBytes: budget.value,
      truncated: modules.size > workerData.maxModules,
      warnings: modules.size > workerData.maxModules ? `Only the first ${workerData.maxModules} bundle modules were indexed.` : '',
    },
  })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'JavaScript analysis failed' })
}
