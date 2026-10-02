import { spawn } from 'node:child_process'

export interface BoundedProcessResult {
  stdout: string
  stderr: string
  truncated: boolean
}

interface BoundedProcessOptions {
  executable: string
  args: string[]
  signal?: AbortSignal
  maxOutputBytes: number
  timeoutMs: number
  timeoutError: (timeoutMs: number) => string
}

/**
 * Keep process providers behind one bounded, argument-array-only execution
 * boundary. Provider output is data, so it must never control a shell command.
 */
export function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Provider execution cancelled'))
      return
    }

    const child = spawn(options.executable, options.args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let aborted = false
    let timedOut = false
    let finished = false
    let killTimer: NodeJS.Timeout | undefined
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      killTimer.unref?.()
    }, options.timeoutMs)
    timeout.unref?.()

    const finishError = (error: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      killTimer.unref?.()
    }
    const appendStdout = (chunk: Buffer) => {
      if (stdoutBytes >= options.maxOutputBytes) {
        truncated = true
        return
      }
      const remaining = options.maxOutputBytes - stdoutBytes
      const bounded = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
      stdout.push(bounded)
      stdoutBytes += bounded.byteLength
      if (bounded.byteLength < chunk.byteLength) {
        truncated = true
        child.kill('SIGTERM')
      }
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', appendStdout)
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = 64 * 1024 - stderrBytes
      if (remaining <= 0) return
      const bounded = chunk.subarray(0, remaining)
      stderr.push(bounded)
      stderrBytes += bounded.byteLength
    })
    child.once('error', (error) => finishError(error instanceof Error ? error : new Error(String(error))))
    child.once('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      if (aborted) {
        reject(new Error('Provider execution cancelled'))
        return
      }
      if (timedOut) {
        reject(new Error(options.timeoutError(options.timeoutMs)))
        return
      }
      if (code !== 0 && !truncated) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(new Error(detail || `${options.executable} provider exited with code ${code ?? 'unknown'}`))
        return
      }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated })
    })
  })
}
