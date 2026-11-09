import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const testFiles = process.argv.slice(2)
if (testFiles.length === 0 || testFiles.some((file) => file.startsWith('-'))) {
  console.error('Pass one or more documentation test files.')
  process.exit(2)
}

const webappDir = fileURLToPath(new URL('../', import.meta.url))
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const result = spawnSync(process.execPath, [vitestCli, 'run', ...testFiles], {
  cwd: webappDir,
  env: { ...process.env, MCP_DOCS_WRITE: '1' },
  stdio: 'inherit',
})

if (result.error) {
  console.error(`Could not run the documentation generator: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
