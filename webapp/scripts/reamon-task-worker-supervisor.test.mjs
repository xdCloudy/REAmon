import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { createWorkerLivenessMonitor, superviseWorker } from './reamon-task-worker-supervisor.mjs'

describe('REAmon task-worker supervisor', () => {
  test('restarts only after the worker misses the liveness deadline', () => {
    let now = 0
    let tick
    const onStale = vi.fn()
    const timer = { unref: vi.fn() }
    const monitor = createWorkerLivenessMonitor({
      timeoutMs: 100,
      onStale,
      now: () => now,
      setIntervalImpl: (callback, ms) => { expect(ms).toBe(25); tick = callback; return timer },
      clearIntervalImpl: vi.fn(),
    })

    now = 75
    tick()
    expect(onStale).not.toHaveBeenCalled()
    monitor.heartbeat()
    now = 174
    tick()
    expect(onStale).not.toHaveBeenCalled()
    now = 175
    tick()
    tick()
    expect(onStale).toHaveBeenCalledTimes(1)
  })

  test('terminates a child that misses heartbeats and exits non-zero when it exits', () => {
    vi.useFakeTimers()
    let now = 0
    const child = new EventEmitter()
    child.pid = 4242
    child.kill = vi.fn()
    const exits = []
    const logger = { error: vi.fn(), warn: vi.fn() }
    const supervisor = superviseWorker({
      workerPath: '/app/scripts/reamon-task-worker.mjs',
      timeoutMs: 60,
      spawnImpl: vi.fn(() => child),
      exit: (code) => exits.push(code),
      logger,
      pidFile: '/tmp/reamon-task-worker-supervisor-test.pid',
      now: () => now,
    })

    now = 60
    vi.advanceTimersByTime(60)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', null, 'SIGTERM')
    expect(exits).toEqual([1])
    supervisor.monitor.stop()
    vi.useRealTimers()
  })

  test('stops the child cleanly when the supervisor receives shutdown', () => {
    const child = new EventEmitter()
    child.pid = 4243
    child.kill = vi.fn()
    const exits = []
    const supervisor = superviseWorker({
      workerPath: '/app/scripts/reamon-task-worker.mjs',
      timeoutMs: 60_000,
      spawnImpl: vi.fn(() => child),
      exit: (code) => exits.push(code),
      logger: { error: vi.fn(), warn: vi.fn() },
      pidFile: '/tmp/reamon-task-worker-supervisor-test.pid',
    })

    supervisor.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', 0, null)
    expect(exits).toEqual([0])
  })
})
