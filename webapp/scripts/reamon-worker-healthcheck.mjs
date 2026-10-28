import { pathToFileURL } from 'node:url'
import { readWorkerConfig, checkWorkerHealth } from './reamon-task-worker.mjs'

async function main() {
  const config = readWorkerConfig()
  const healthy = await checkWorkerHealth(config)
  if (!healthy) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exitCode = 1 })
}
