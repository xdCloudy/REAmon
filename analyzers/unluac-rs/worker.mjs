import { parentPort, workerData } from 'node:worker_threads'
import { decompileRich } from 'unluac-js'

try {
  const result = await decompileRich(new Uint8Array(workerData.bytes), {
    dialect: 'lua5.5',
    generate: { mode: 'strict' },
  })
  if (result.kind !== 'source' || typeof result.source !== 'string' || !result.source.trim()) {
    throw new Error('unluac-rs returned diagnostic pseudocode instead of Lua source')
  }
  parentPort.postMessage({ ok: true, source: result.source })
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Lua 5.5 decompilation failed' })
}
