import { readFile, writeFile } from 'node:fs/promises'
import { EOL } from 'node:os'

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
const displayedScore = score.toFixed(2)
const comparison = manifest.recentComparison
if (comparison && (typeof comparison.baselineEstimate !== 'number'
    || !Number.isFinite(comparison.baselineEstimate) || comparison.baselineEstimate < 0 || comparison.baselineEstimate > 100
    || typeof comparison.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(comparison.date)
    || typeof comparison.evidence !== 'string' || !comparison.evidence.trim())) {
  throw new Error('Progress recentComparison must include a valid baselineEstimate, date, and evidence summary')
}
const comparisonLine = comparison
  ? `Latest evidence-based score change (${comparison.date}): **${score - comparison.baselineEstimate >= 0 ? '+' : ''}${(score - comparison.baselineEstimate).toFixed(2)} points** (${comparison.baselineEstimate.toFixed(2)}% → ${displayedScore}%). ${comparison.evidence}`
  : ''
const activity = manifest.activitySummary
if (activity && (typeof activity.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(activity.date)
    || !Array.isArray(activity.completed) || activity.completed.length === 0
    || !activity.completed.every((item) => typeof item === 'string' && item.trim())
    || typeof activity.scoreDecision !== 'string' || !activity.scoreDecision.trim()
    || typeof activity.nextGate !== 'string' || !activity.nextGate.trim())) {
  throw new Error('Progress activitySummary must include a date, completed items, score decision, and next gate')
}
const suppliedCommit = process.argv[2]
const commit = suppliedCommit?.trim()
if (commit && !/^[a-f0-9]{7,40}$/i.test(commit)) throw new Error('Progress source commit must be a Git SHA')
const sourceStamp = commit ? `pushed commit \`${commit.slice(0, 7)}\`` : 'the current local worktree'

const generated = [
  startMarker,
  `<progress value="${displayedScore}" max="100">${displayedScore}%</progress> <strong>${displayedScore}%</strong> — weighted estimate **${score.toFixed(2)}%**.`,
  ...(comparisonLine ? [comparisonLine] : []),
  ...(activity ? [
    `**Work completed (${activity.date}):**\n\n${activity.completed.map((item) => `- ${item}`).join('\n')}`,
    `**Score decision:** ${activity.scoreDecision}`,
    `**Next measurable gate:** ${activity.nextGate}`,
  ] : []),
  `Refreshed from ${sourceStamp}. This estimate includes product work and production security/reliability; it is not a release certification. See the [readiness matrix](docs/REAMON_READINESS_MATRIX.md) for release gates and the [progress matrix](docs/REAMON_PROGRESS.md) for workstream evidence.`,
  endMarker,
].join('\n\n')

const readme = await readFile(readmePath, 'utf8')
const start = readme.indexOf(startMarker)
const end = readme.indexOf(endMarker)
if (start < 0 || end < start) throw new Error('README progress markers are missing or out of order')
const updated = (readme.slice(0, start) + generated + readme.slice(end + endMarker.length)).replace(/\r?\n/g, EOL)
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
  `Assessment date: ${manifest.assessmentDate} · Source: ${sourceStamp} · Weighted estimate: **${score.toFixed(2)}%**`,
  '',
  'This estimate covers the reverse-engineering product goal and secure production operations. It is not a release certification; unresolved security, test, or deployment gates can block release at any score. Workstream weights total 100%; each contribution is weight × completion.',
  '',
  ...(activity ? [
    `## Recent activity (${activity.date})`,
    '',
    ...activity.completed.map((item) => `- ${item}`),
    '',
    `**Score decision:** ${activity.scoreDecision}`,
    '',
    `**Next measurable gate:** ${activity.nextGate}`,
    '',
  ] : []),
  '| Workstream | Goal weight | Estimated complete | Weighted points |',
  '| --- | ---: | ---: | ---: |',
  ...rows,
  '',
  '## Evidence and remaining work',
  '',
  details,
  ...(manifest.assessmentNote ? ['## Historical assessment notes', '', manifest.assessmentNote, ''] : []),
  'The machine-readable [`REAMON_PROGRESS.json`](REAMON_PROGRESS.json) feeds the README progress bar. The scope now includes the production hardening goal, so the total is not directly comparable with the previous product-only estimate. Update it with evidence when estimates change, then run `node tooling/reamon/update-product-progress.mjs <commit-sha>` to refresh this matrix and the README.',
  '',
].join('\n')
const currentLedger = await readFile(ledgerPath, 'utf8').catch(() => '')
const formattedLedger = ledger.replace(/\r?\n/g, EOL)
if (formattedLedger !== currentLedger) await writeFile(ledgerPath, formattedLedger)
console.log(`REAmon product progress: ${displayedScore}% (weighted ${score.toFixed(2)}%), source ${sourceStamp}`)
