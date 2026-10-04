'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Code2, Copy, ExternalLink, RefreshCw, Search } from 'lucide-react'
import { filterCodeUnits, layoutCodeUnitTreemap, summarizeCodeUnits, type CodeUnit } from '@/lib/reamon/code-units'
import styles from './WorkspaceCodeVisualizer.module.css'

interface CodeUnitResponse {
  units: CodeUnit[]
  total: number
  hasMore: boolean
  runs: Array<{
    id: string
    title: string
    createdAt: string
    completedAt: string | null
    artifactName: string
    codeUnitCount: number
    unitLabel: string
    discoveredUnitCount: number | null
    returnedUnitCount: number
    indexedUnitCount: number
    linkPercent: number | null
    codeBytes: number | null
    truncated: boolean
    warnings: string
    failedUnitCount: number | null
    visitedUnitCount: number | null
  }>
  selectedRunId: string | null
}

interface CodeExplanationProvider { id: string; name: string; modelIdentifier: string }
interface CodeExplanationResponse { explanation: string; providerName: string; model: string; sourceTruncated: boolean }

const EMPTY_CODE_UNITS: CodeUnit[] = []

async function fetchCodeUnits(projectId: string, taskId: string | null): Promise<CodeUnitResponse> {
  const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''
  const response = await fetch(`/api/projects/${projectId}/visualizer${query}`)
  if (!response.ok) throw new Error('Unable to load code units')
  return response.json()
}

function sourceUrl(projectId: string, unit: CodeUnit): string | null {
  if (!unit.artifactId || !unit.codeArtifactId) return null
  const sourcePath = unit.codeArtifactId.split('/').map(encodeURIComponent).join('/')
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(unit.artifactId)}/decompiled/${sourcePath}`
}

async function fetchSource(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(detail?.error || 'Could not load decompiled source')
  }
  return response.text()
}

async function fetchExplanationProviders(projectId: string): Promise<CodeExplanationProvider[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/providers`, { cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to load saved AI providers')
  const data = await response.json() as { providers?: CodeExplanationProvider[] }
  return Array.isArray(data.providers) ? data.providers : []
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function unitColor(coverage: number | null): string {
  if (coverage === null) return 'var(--status-neutral-bg, #394458)'
  if (coverage >= 100) return 'var(--status-success, #00a876)'
  if (coverage > 0) return 'var(--status-warning, #b99a3b)'
  return 'var(--status-error, #9b4d4d)'
}

function shortenLabel(value: string, width: number): string {
  const maxCharacters = Math.max(0, Math.floor((width - 14) / 7.2))
  if (maxCharacters < 5) return ''
  return value.length > maxCharacters ? `${value.slice(0, maxCharacters - 1)}…` : value
}

export function WorkspaceCodeVisualizer({ projectId, isAnalyzing }: { projectId: string; isAnalyzing: boolean }) {
  const [filter, setFilter] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [providerId, setProviderId] = useState('')
  const [question, setQuestion] = useState('')
  const [explanation, setExplanation] = useState<CodeExplanationResponse | null>(null)
  const [explainError, setExplainError] = useState('')
  const [explaining, setExplaining] = useState(false)
  const query = useQuery({
    queryKey: ['reamon-code-units', projectId, selectedRunId],
    queryFn: () => fetchCodeUnits(projectId, selectedRunId),
    staleTime: 5_000,
    refetchInterval: isAnalyzing ? 3000 : false,
    refetchIntervalInBackground: false,
  })
  const units = query.data?.units || EMPTY_CODE_UNITS
  const runs = query.data?.runs || []
  const currentRunId = runs.some((run) => run.id === selectedRunId) ? selectedRunId : query.data?.selectedRunId || null
  const currentRunIndex = runs.findIndex((run) => run.id === currentRunId)
  const currentRun = currentRunIndex >= 0 ? runs[currentRunIndex] : null
  const visibleUnits = useMemo(() => filterCodeUnits(units, filter), [units, filter])
  const rectangles = useMemo(() => layoutCodeUnitTreemap(visibleUnits, 1200, 560), [visibleUnits])
  const summary = useMemo(() => summarizeCodeUnits(visibleUnits), [visibleUnits])
  const selectedUnit = visibleUnits.find((unit) => unit.id === selectedId)
  const selectedSourceUrl = selectedUnit ? sourceUrl(projectId, selectedUnit) : null
  const sourceQuery = useQuery({
    queryKey: ['reamon-decompiled-source', selectedUnit?.id, selectedUnit?.codeArtifactId],
    queryFn: ({ signal }) => fetchSource(selectedSourceUrl as string, signal),
    enabled: Boolean(selectedSourceUrl),
    staleTime: 5 * 60_000,
    gcTime: 60_000,
  })
  const explanationProvidersQuery = useQuery({
    queryKey: ['reamon-code-explanation-providers', projectId],
    queryFn: () => fetchExplanationProviders(projectId),
    enabled: Boolean(selectedSourceUrl),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  })
  const explanationProviders = explanationProvidersQuery.data || []
  const selectedProviderId = explanationProviders.some((provider) => provider.id === providerId)
    ? providerId
    : explanationProviders[0]?.id || ''

  async function copySource() {
    if (!sourceQuery.data) return
    try {
      await navigator.clipboard.writeText(sourceQuery.data)
      setCopyStatus('Copied')
    } catch {
      setCopyStatus('Clipboard unavailable')
    }
  }

  async function explainSelectedUnit() {
    if (!selectedUnit || !selectedProviderId) return
    setExplaining(true)
    setExplainError('')
    setExplanation(null)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unitId: selectedUnit.id, providerId: selectedProviderId, question: question.trim() }),
      })
      const result = await response.json().catch(() => ({})) as CodeExplanationResponse & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not explain this code unit')
      setExplanation(result)
    } catch (error) {
      setExplainError(error instanceof Error ? error.message : 'Could not explain this code unit')
    } finally {
      setExplaining(false)
    }
  }

  function showRun(taskId: string | null) {
    setSelectedRunId(taskId)
    setSelectedId(null)
    setCopyStatus('')
    setExplanation(null)
    setExplainError('')
  }

  return (
    <section className={styles.panel} aria-labelledby="code-visualizer-heading">
      <div className={styles.header}>
        <div>
          <p className={styles.kicker}>Program structure</p>
          <h2 id="code-visualizer-heading"><Code2 size={18} /> Code visualizer</h2>
          <p className={styles.description}>Browse analyzed functions and other code units by size. Tiles are backed by provider observations.</p>
        </div>
        {query.data && <span className={styles.badge}>{query.data.hasMore ? `${units.length.toLocaleString()} / ${query.data.total.toLocaleString()} code units` : `${units.length.toLocaleString()} code units`}</span>}
      </div>

      {currentRun && <nav className={styles.runHistory} aria-label="Analysis run history">
        <button type="button" className={styles.runButton} aria-label="Previous run" disabled={currentRunIndex >= runs.length - 1} onClick={() => showRun(runs[currentRunIndex + 1]?.id || null)}>Previous</button>
        <div className={styles.runDetails} aria-live="polite">
          <strong>Run {currentRunIndex + 1} of {runs.length}</strong>
          <span>{currentRun.artifactName} · {new Date(currentRun.completedAt || currentRun.createdAt).toLocaleString()}</span>
          <small>{currentRun.codeUnitCount.toLocaleString()} code units</small>
        </div>
        <button type="button" className={styles.runButton} aria-label="Next run" disabled={currentRunIndex <= 0} onClick={() => showRun(runs[currentRunIndex - 1]?.id || null)}>Next</button>
        <button type="button" className={styles.runButton} aria-label="Latest run" disabled={currentRunIndex === 0} onClick={() => showRun(null)}>Latest</button>
      </nav>}

      {currentRun && <div className={styles.runSummary} aria-label="Selected analysis summary">
        <div className={styles.runSummaryHeading}>
          <div>
            <strong>{currentRun.linkPercent === null ? `${currentRun.indexedUnitCount.toLocaleString()} ${currentRun.unitLabel} indexed` : `${currentRun.linkPercent}% of analyzed ${currentRun.unitLabel} indexed`}</strong>
            <span>{currentRun.indexedUnitCount.toLocaleString()} code units indexed{currentRun.discoveredUnitCount !== null ? ` of ${currentRun.discoveredUnitCount.toLocaleString()} analyzed ${currentRun.unitLabel}` : ''}</span>
          </div>
          <span>Code {formatBytes(currentRun.codeBytes ?? units.reduce((sum, unit) => sum + unit.sizeBytes, 0))}</span>
        </div>
        {currentRun.linkPercent !== null && <div className={styles.runProgress} role="progressbar" aria-label="Indexed code unit coverage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={currentRun.linkPercent} aria-valuetext={`${currentRun.linkPercent}% of analyzed ${currentRun.unitLabel} indexed`}>
          <span style={{ width: `${currentRun.linkPercent}%` }} />
        </div>}
        <div className={styles.runSummaryMeta}>
          <span>{currentRun.truncated ? 'Partial index; the analyzer reached a configured limit.' : `${currentRun.indexedUnitCount.toLocaleString()} indexed code units`}</span>
          {currentRun.failedUnitCount !== null && currentRun.failedUnitCount > 0 && <span>{currentRun.failedUnitCount.toLocaleString()} functions could not be decompiled{currentRun.visitedUnitCount !== null ? ` of ${currentRun.visitedUnitCount.toLocaleString()} visited` : ''}</span>}
        </div>
        {currentRun.warnings && <p className={styles.runWarning}>{currentRun.warnings}</p>}
      </div>}

      {query.isLoading && <p className={styles.message}>Loading code units…</p>}
      {query.isError && <p className={styles.error}>Could not load code units. Refresh the workspace and try again.</p>}
      {!query.isLoading && !query.isError && query.data?.units.length === 0 && query.data.total === 0 && (
        <div className={styles.empty}>
          <strong>No code units have been analyzed yet.</strong>
          <p>Importing a file only records and profiles it. An analyzer must publish functions or other code units before this map can show program structure.</p>
          <span>Each unit should include its name, address, byte size, coverage details, and a link to its viewable code artifact.</span>
        </div>
      )}
      {!query.isLoading && !query.isError && query.data?.units.length === 0 && query.data.total > 0 && (
        <div className={styles.empty}>
          <strong>Code-unit observations are missing their byte size.</strong>
          <p>The map needs each provider to report a positive size for a function, class, or other unit. The stored records remain available in the investigation history.</p>
        </div>
      )}

      {!query.isLoading && !query.isError && query.data && query.data.units.length > 0 && <>
        <div className={styles.stats}>
          <div><strong>{units.length.toLocaleString()}</strong><span>Mapped code units</span></div>
          <div><strong>{formatBytes(summary.totalBytes)}</strong><span>Mapped bytes in filter</span></div>
          <div><strong>{summary.coveragePercent === null ? 'Unknown' : `${summary.coveragePercent}%`}</strong><span>Coverage of measured units</span></div>
          <div><strong>{summary.decompiledUnits.toLocaleString()}</strong><span>Fully decompiled</span></div>
        </div>
        {summary.unmeasuredBytes > 0 && <p className={styles.message}>{formatBytes(summary.unmeasuredBytes)} of mapped code has no coverage value from its provider.</p>}

        <label className={styles.filter}>
          <Search size={16} aria-hidden="true" />
          <span className={styles.srOnly}>Filter code units</span>
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter names, addresses, or paths · >10kb · <70%" />
        </label>

        <div className={styles.legend} aria-label="Decompiler coverage legend">
          <span><i className={styles.complete} /> Decompiled</span>
          <span><i className={styles.partial} /> Partial</span>
          <span><i className={styles.none} /> Not decompiled</span>
          <span><i className={styles.unknown} /> Unmeasured</span>
        </div>

        {visibleUnits.length ? <div className={styles.mapFrame}>
          <svg className={styles.map} viewBox="0 0 1200 560" role="group" aria-label="Code units sized by bytes and colored by decompilation coverage">
            {rectangles.map(({ unit, x, y, width, height }) => {
              const label = shortenLabel(unit.name, width)
              const coverage = unit.coveragePercent === null ? 'coverage unmeasured' : `${unit.coveragePercent}% decompiled`
              return <g
                key={unit.id}
                className={`${styles.tile} ${unit.id === selectedId ? styles.selected : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`${unit.name}, ${formatBytes(unit.sizeBytes)}, ${coverage}${unit.address ? `, address ${unit.address}` : ''}`}
                onClick={() => { setSelectedId(unit.id); setCopyStatus(''); setExplanation(null); setExplainError('') }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedId(unit.id)
                    setCopyStatus('')
                    setExplanation(null)
                    setExplainError('')
                  }
                }}
              >
                <title>{`${unit.name} · ${formatBytes(unit.sizeBytes)} · ${coverage}${unit.address ? ` · ${unit.address}` : ''}`}</title>
                <rect x={x + 1} y={y + 1} width={Math.max(0, width - 2)} height={Math.max(0, height - 2)} fill={unitColor(unit.coveragePercent)} rx="3" />
                {label && <text x={x + 9} y={y + 20} className={styles.tileName}>{label}</text>}
                {label && width > 115 && height > 48 && <text x={x + 9} y={y + 38} className={styles.tileMeta}>{unit.address || formatBytes(unit.sizeBytes)}</text>}
              </g>
            })}
          </svg>
        </div> : <p className={styles.noMatches}>No code units match this filter.</p>}

        {query.data.hasMore && <p className={styles.message}>The map contains the newest {units.length.toLocaleString()} size-described units from {query.data.total.toLocaleString()} observations. Search currently filters the units loaded here.</p>}
        {selectedUnit && <div className={styles.details}>
          <div><span className={styles.detailLabel}>Selected code unit</span><strong>{selectedUnit.name}</strong></div>
          <dl>
            <div><dt>Address</dt><dd>{selectedUnit.address || 'Not supplied'}</dd></div>
            <div><dt>Size</dt><dd>{formatBytes(selectedUnit.sizeBytes)}</dd></div>
            <div><dt>Language</dt><dd>{selectedUnit.language || 'Not identified'}</dd></div>
            <div><dt>Unit type</dt><dd>{selectedUnit.unitType || 'Code unit'}</dd></div>
            <div><dt>Artifact</dt><dd>{selectedUnit.artifactPath || 'Not linked'}</dd></div>
            <div><dt>Provider</dt><dd>{selectedUnit.source}</dd></div>
          </dl>
          {selectedUnit.artifactId && selectedUnit.codeArtifactId
            ? <a
                className={styles.codeLink}
                href={selectedSourceUrl || undefined}
                target="_blank"
                rel="noreferrer"
              ><ExternalLink size={14} /> Open source separately</a>
            : <p className={styles.message}>This provider has not attached a viewable code artifact to the unit.</p>}
        </div>}
        {selectedUnit && selectedSourceUrl && <section className={styles.sourcePanel} aria-label="Decompiled source">
          <div className={styles.sourceHeader}>
            <div><strong>{selectedUnit.name}</strong><span>{selectedUnit.language || 'Source'} · {selectedUnit.codeArtifactId?.split('/').pop()}</span></div>
            <button type="button" className={styles.copyButton} onClick={() => void copySource()} disabled={!sourceQuery.data}>
              <Copy size={14} /> {copyStatus || 'Copy source'}
            </button>
          </div>
          {sourceQuery.isLoading && <p className={styles.message}>Loading decompiled source…</p>}
          {sourceQuery.isError && <p className={styles.error}>{sourceQuery.error instanceof Error ? sourceQuery.error.message : 'Could not load decompiled source'}</p>}
          {sourceQuery.data !== undefined && <pre className={styles.sourceCode}><code>{sourceQuery.data}</code></pre>}
        </section>}
        {selectedUnit && selectedSourceUrl && <section className={styles.explainPanel} aria-labelledby="code-explain-heading">
          <div>
            <h3 id="code-explain-heading">Explain this code with AI</h3>
            <p>When you choose Explain, this source is sent to the selected saved provider. API keys stay on the server. Check the explanation against the source before relying on it.</p>
          </div>
          {explanationProvidersQuery.isLoading && <p className={styles.message}>Loading saved providers…</p>}
          {explanationProvidersQuery.isError && <p className={styles.error}>Could not load saved AI providers.</p>}
          {!explanationProvidersQuery.isLoading && !explanationProvidersQuery.isError && explanationProviders.length === 0 && <p className={styles.message}>No OpenAI-compatible provider is saved yet. <a href="/settings">Add one in Settings</a>.</p>}
          {explanationProviders.length > 0 && <>
            <label className={styles.explainField}>Saved provider
              <select value={selectedProviderId} onChange={(event) => setProviderId(event.target.value)}>
                {explanationProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.modelIdentifier}</option>)}
              </select>
            </label>
            <label className={styles.explainField}>Question about this code (optional)
              <textarea value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1000} rows={3} placeholder="What state does this method change?" />
            </label>
            <button type="button" className={styles.explainButton} onClick={() => void explainSelectedUnit()} disabled={!selectedProviderId || explaining || sourceQuery.isError || sourceQuery.isLoading}>
              {explaining ? 'Explaining…' : 'Explain selected code'}
            </button>
          </>}
          {explainError && <p className={styles.error} role="alert">{explainError}</p>}
          {explanation && <div className={styles.explanation} aria-live="polite">
            <div><strong>{explanation.providerName} · {explanation.model}</strong>{explanation.sourceTruncated && <span>Source was truncated to fit the model request.</span>}</div>
            <pre>{explanation.explanation}</pre>
          </div>}
        </section>}
      </>}
      <button type="button" className={styles.refresh} onClick={() => void query.refetch()} disabled={query.isFetching}>
        <RefreshCw size={14} className={query.isFetching ? styles.spin : undefined} /> {query.isFetching ? 'Refreshing…' : 'Refresh map'}
      </button>
    </section>
  )
}
