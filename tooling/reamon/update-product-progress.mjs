import { readFile, writeFile } from 'node:fs/promises'

const manifestPath = new URL('../../docs/REAMON_PROGRESS.json', import.meta.url)
const ledgerPath = new URL('../../docs/REAMON_PROGRESS.md', import.meta.url)
const readmePath = new URL('../../README.md', import.meta.url)
const startMarker = '<!-- REAMON_PRODUCT_PROGRESS_START -->'
const endMarker = '<!-- REAMON_PRODUCT_PROGRESS_END -->'
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.workstreams) || manifest.workstreams.length === 0) {
  throw new Error('REAmon progress manifest has an unsupported shape')
}

let totalWeight = 0
let weightedCompletion = 0
for (const workstream of manifest.workstreams) {
  if (typeof workstream.name !== 'string' || !workstream.name.trim()
      || !Number.isInteger(workstream.weight) || workstream.weight <= 0
      || !Number.isInteger(workstream.completion) || workstream.completion < 0 || workstream.completion > 100
      || typeof workstream.summary !== 'string' || !workstream.summary.trim()
      || typeof workstream.remaining !== 'string' || !workstream.remaining.trim()
      || typeof workstream.basis !== 'string' || !workstream.basis.trim()) {
    throw new Error(`Invalid progress workstream: ${JSON.stringify(workstream)}`)
  }
  totalWeight += workstream.weight
  weightedCompletion += workstream.weight * workstream.completion
}
if (totalWeight !== 100) throw new Error(`Progress weights must total 100; got ${totalWeight}`)

const score = weightedCompletion / totalWeight
const displayedScore = Math.round(score)
const suppliedCommit = process.argv[2]
const commit = suppliedCommit?.trim()
if (commit && !/^[a-f0-9]{7,40}$/i.test(commit)) throw new Error('Progress source commit must be a Git SHA')
const sourceStamp = commit ? `pushed commit \`${commit.slice(0, 7)}\`` : 'the current local worktree'

const generated = [
  startMarker,
  `<progress value="${displayedScore}" max="100">${displayedScore}%</progress> <strong>${displayedScore}%</strong> — weighted estimate **${score.toFixed(1)}%**.`,
  `Refreshed from ${sourceStamp}. This estimate includes product work and production security/reliability; it is not a release certification. See the [readiness matrix](docs/REAMON_READINESS_MATRIX.md) for release gates and the [progress matrix](docs/REAMON_PROGRESS.md) for workstream evidence.`,
  endMarker,
].join('\n')

const readme = await readFile(readmePath, 'utf8')
const start = readme.indexOf(startMarker)
const end = readme.indexOf(endMarker)
if (start < 0 || end < start) throw new Error('README progress markers are missing or out of order')
const updated = readme.slice(0, start) + generated + readme.slice(end + endMarker.length)
if (updated !== readme) await writeFile(readmePath, updated)

const rows = manifest.workstreams.map((workstream) =>
  `| ${workstream.name} | ${workstream.weight}% | ${workstream.completion}% | ${(workstream.weight * workstream.completion / 100).toFixed(2)} pts |`,
)
const details = manifest.workstreams.map((workstream) => [
  `### ${workstream.name}`,
  '',
  `**Current evidence:** ${workstream.summary}`,
  '',
  `**Remaining:** ${workstream.remaining}`,
  '',
].join('\n')).join('\n')
const ledger = [
  '# REAmon product progress',
  '',
  `Assessment date: ${manifest.assessmentDate} · Source: ${sourceStamp} · Weighted estimate: **${score.toFixed(1)}%**`,
  '',
  'This estimate covers the reverse-engineering product goal and secure production operations. It is not a release certification; unresolved security, test, or deployment gates can block release at any score. Workstream weights total 100%; each contribution is weight × completion.',
  '',
  '| Workstream | Goal weight | Estimated complete | Weighted points |',
  '| --- | ---: | ---: | ---: |',
  ...rows,
  '',
  '## Evidence and remaining work',
  '',
  details,
  'The machine-readable [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json) feeds the README progress bar. The scope now includes the production hardening goal, so the total is not directly comparable with the previous product-only estimate. Update it with evidence when estimates change, then run `node tooling/reamon/update-product-progress.mjs <commit-sha>` to refresh this matrix and the README.',
  '',
].join('\n')
const currentLedger = await readFile(ledgerPath, 'utf8').catch(() => '')
if (ledger !== currentLedger) await writeFile(ledgerPath, ledger)
console.log(`REAmon product progress: ${displayedScore}% (weighted ${score.toFixed(1)}%), source ${sourceStamp}`)
