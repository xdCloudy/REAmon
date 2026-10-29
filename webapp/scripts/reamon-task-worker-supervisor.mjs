import { spawn } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkerConfig } from './reamon-task-worker.mjs'

const PID_FILE = '/tmp/reamon-task-worker.pid'
const KILL_GRACE_MS = 10_000

export function createWorkerLivenessMonitor({ timeoutMs, onStale, now = () => performance.now(), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  let lastHeartbeat = now()
  let stale = false
  const interval = Math.max(25, Math.min(10_000, Math.floor(timeoutMs / 4)))
  const timer = setIntervalImpl(() => {
    if (!stale && now() - lastHeartbeat >= timeoutMs) {
      stale = true
      onStale()
    }
  }, interval)
  timer.unref?.()
  return {
    heartbeat() { if (!stale) lastHeartbeat = now() },
    stop() { clearIntervalImpl(timer) },
  }
}

function removePidFile() {
  try { unlinkSync(PID_FILE) } catch (error) { if (error?.code !== 'ENOENT') throw error }
}

export function superviseWorker({ workerPath = fileURLToPath(new URL('./reamon-task-worker.mjs', import.meta.url)), timeoutMs, logger = console, spawnImpl = spawn, exit = (code) => process.exit(code), pidFile = PID_FILE, now = () => performance.now() }) {
  const child = spawnImpl(process.execPath, [workerPath], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  let stopping = false
  let exited = false
  let killTimer
  const monitor = createWorkerLivenessMonitor({
    timeoutMs,
    now,
    onStale: () => {
      logger.error(`[reamon-worker-supervisor] worker event loop missed its ${timeoutMs}ms liveness deadline; terminating child`)
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL') }, KILL_GRACE_MS)
      killTimer.unref?.()
    },
  })

  child.once('spawn', () => {
    try { writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 }) }
    catch (error) { logger.error('[reamon-worker-supervisor] failed to write worker pid file', error); child.kill('SIGTERM') }
  })
  child.on('message', (message) => {
    if (message?.type === 'heartbeat' && message.pid === child.pid) monitor.heartbeat()
  })
  child.once('error', (error) => {
    logger.error('[reamon-worker-supervisor] worker process failed to start', error)
    exit(1)
  })
  child.once('exit', (code, signal) => {
    exited = true
    clearTimeout(killTimer)
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    monitor.stop()
    try { unlinkSync(pidFile) } catch (error) { if (error?.code !== 'ENOENT') logger.warn('[reamon-worker-supervisor] failed to remove worker pid file', error) }
    if (stopping) { exit(0); return }
    logger.error(`[reamon-worker-supervisor] worker exited unexpectedly code=${code} signal=${signal}`)
    exit(1)
  })

  const stop = () => {
    if (stopping) return
    stopping = true
    monitor.stop()
    child.kill('SIGTERM')
    killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL') }, KILL_GRACE_MS)
    killTimer.unref?.()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  return { child, stop, monitor }
}

async function main() {
  const config = readWorkerConfig()
  superviseWorker({ timeoutMs: config.localLivenessTimeoutSeconds * 1000 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main() }
  catch (error) {
    console.error(`[reamon-worker-supervisor] ${error instanceof Error ? error.message : 'supervisor stopped unexpectedly'}`)
    process.exitCode = 1
  }
}
