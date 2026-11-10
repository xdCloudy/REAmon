import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const fixtureId = 'lua54-stripped-bytecode-linux-amd64'
const originalPath = '/app/fixtures/lua54_behavior.lua'
const recoveredPath = process.argv[2]
if (!recoveredPath) throw new Error('Recovered source path is required')

const recoveredInfo = await stat(recoveredPath)
assert.ok(recoveredInfo.isFile() && recoveredInfo.size > 0 && recoveredInfo.size <= 32 * 1024 * 1024)
const recovered = await readFile(recoveredPath)
const original = await readFile(originalPath)

function run(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/tmp' },
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  })
  assert.equal(result.error, undefined, `${binary} failed to start: ${result.error?.message}`)
  assert.equal(result.signal, null, `${binary} ended by signal ${result.signal}`)
  assert.equal(result.status, 0, `${binary} exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

run('luac5.4', ['-p', recoveredPath])
const inputs = ['-2147483648', '-4096', '-19', '-7', '-1', '0', '1', '3', '19', '2147483647']
let matchedInputs = 0
for (const input of inputs) {
  const expected = run('lua5.4', [originalPath, input])
  const actual = run('lua5.4', [recoveredPath, input])
  if (actual === expected) matchedInputs += 1
}

assert.equal(matchedInputs, inputs.length, 'reconstructed Lua output differs on sampled inputs')
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  fixtureId,
  originalSourceSha256: createHash('sha256').update(original).digest('hex'),
  recoveredSourceSha256: createHash('sha256').update(recovered).digest('hex'),
  inputs,
  recoveredSourceParsed: true,
  runtimeMatchedInputs: matchedInputs,
  metrics: {
    recovered_source_parse: { state: 'MEASURED', denominator: 1, value: 1 },
    runtime_oracle: { state: 'MEASURED', denominator: 1, value: 1 },
    sampled_behavior_oracle: { state: 'MEASURED', denominator: inputs.length, value: matchedInputs },
  },
})}\n`)
