import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

const fixturePath = new URL('./fixtures/lua54_behavior.lua', import.meta.url)

function command(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/tmp' },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  assert.equal(result.error, undefined, `${binary} failed to start: ${result.error?.message}`)
  assert.equal(result.signal, null, `${binary} ended by signal ${result.signal}`)
  assert.equal(result.status, 0, `${binary} exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

function decompile(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { bytes } })
    worker.once('message', (message) => {
      if (message?.ok) resolve(message)
      else reject(new Error(message?.error || 'unluac-rs rejected the fixture'))
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`unluac-rs worker exited with status ${code}`))
    })
  })
}

test('stripped Lua 5.4 reconstruction parses and preserves fixture behavior', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reamon-unluac-rs-fixture-'))
  try {
    const bytecodePath = path.join(directory, 'input.luac')
    const sourcePath = path.join(directory, 'original.lua')
    const fixtureSource = await readFile(fixturePath, 'utf8')
    await writeFile(sourcePath, fixtureSource)
    command('luac5.4', ['-s', '-o', bytecodePath, sourcePath])

    const bytecode = await readFile(bytecodePath)
    const result = await decompile(new Uint8Array(bytecode))

    assert.equal(result.dialect, 'lua5.4')
    assert.ok(result.source.trim().length > 0)
    assert.ok(result.protoCount >= 3)
    assert.ok(result.functions.length > 0)
    assert.equal(result.metadataTruncated, false)

    const recoveredPath = path.join(directory, 'recovered.lua')
    await writeFile(recoveredPath, result.source)
    command('luac5.4', ['-p', recoveredPath])

    for (const input of ['3', '-7', '0', '19']) {
      const originalOutput = command('lua5.4', [sourcePath, input])
      const recoveredOutput = command('lua5.4', [recoveredPath, input])
      assert.equal(recoveredOutput, originalOutput, `runtime output differs for input ${input}`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
