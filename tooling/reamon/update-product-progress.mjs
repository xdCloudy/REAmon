import { readFile, writeFile } from 'node:fs/promises'

const manifestPath = new URL('../../docs/REAMON_PROGRESS.json', import.meta.url)
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

const rows = manifest.workstreams.map((workstream) => {
  const contribution = workstream.weight * workstream.completion / 100
  return `| ${workstream.name} | ${workstream.weight}% | ${workstream.completion}% | ${contribution.toFixed(1)}% | ${workstream.basis} |`
})

const generated = [
  startMarker,
  '## Long-term product progress',
  '',
  `<progress value="${displayedScore}" max="100">${displayedScore}%</progress> <strong>${displayedScore}%</strong>`,
  '',
  `Weighted estimate: **${score.toFixed(1)}%** (rounded for the bar). Refreshed from the workstream weights at ${sourceStamp}.`,
  '',
  '| Workstream | Weight | Completion estimate | Weighted points | Current evidence and remaining gap |',
  '| --- | ---: | ---: | ---: | --- |',
  ...rows,
  '',
  'The weights describe REAmon’s full reverse-engineering goal, not the narrower bootstrap release. Each push to `main` regenerates this block from [the progress ledger](docs/REAMON_PROGRESS.json). Update a workstream estimate only when committed implementation or fixture evidence changes its basis; the score is a roadmap estimate, not a line-count or test-count metric.',
  endMarker,
].join('\n')

const readme = await readFile(readmePath, 'utf8')
const start = readme.indexOf(startMarker)
const end = readme.indexOf(endMarker)
if (start < 0 || end < start) throw new Error('README progress markers are missing or out of order')
const updated = readme.slice(0, start) + generated + readme.slice(end + endMarker.length)
if (updated !== readme) await writeFile(readmePath, updated)
console.log(`REAmon product progress: ${displayedScore}% (weighted ${score.toFixed(1)}%), source ${sourceStamp}`)
