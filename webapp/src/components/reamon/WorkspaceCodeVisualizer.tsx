'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Code2, ExternalLink, RefreshCw, Search } from 'lucide-react'
import { filterCodeUnits, layoutCodeUnitTreemap, summarizeCodeUnits, type CodeUnit } from '@/lib/reamon/code-units'
import styles from './WorkspaceCodeVisualizer.module.css'

interface CodeUnitResponse {
  units: CodeUnit[]
  total: number
  hasMore: boolean
}

const EMPTY_CODE_UNITS: CodeUnit[] = []

async function fetchCodeUnits(projectId: string): Promise<CodeUnitResponse> {
  const response = await fetch(`/api/projects/${projectId}/visualizer`)
  if (!response.ok) throw new Error('Unable to load code units')
  return response.json()
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

export function WorkspaceCodeVisualizer({ projectId, hasApk, isAnalyzing }: { projectId: string; hasApk: boolean; isAnalyzing: boolean }) {
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['reamon-code-units', projectId],
    queryFn: () => fetchCodeUnits(projectId),
    staleTime: 5_000,
    refetchInterval: isAnalyzing ? 3000 : false,
    refetchIntervalInBackground: false,
  })
  const units = query.data?.units || EMPTY_CODE_UNITS
  const visibleUnits = useMemo(() => filterCodeUnits(units, filter), [units, filter])
  const rectangles = useMemo(() => layoutCodeUnitTreemap(visibleUnits, 1200, 560), [visibleUnits])
  const summary = useMemo(() => summarizeCodeUnits(visibleUnits), [visibleUnits])
  const selectedUnit = visibleUnits.find((unit) => unit.id === selectedId)

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

      {query.isLoading && <p className={styles.message}>Loading code units…</p>}
      {query.isError && <p className={styles.error}>Could not load code units. Refresh the workspace and try again.</p>}
      {!query.isLoading && !query.isError && query.data?.units.length === 0 && query.data.total === 0 && (
        <div className={styles.empty}>
          <strong>{hasApk ? 'The APK is stored and identified; no code has been decompiled yet.' : 'No code units have been analyzed yet.'}</strong>
          <p>Importing a file only records and profiles it. An analyzer must publish functions or other code units before this map can show program structure.</p>
          <span>Each unit should include its name, address, byte size, decompilation coverage, and a link to its viewable code artifact.</span>
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
                onClick={() => setSelectedId(unit.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedId(unit.id)
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
                href={`/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(selectedUnit.artifactId)}/decompiled/${selectedUnit.codeArtifactId.split('/').map(encodeURIComponent).join('/')}`}
                target="_blank"
                rel="noreferrer"
              ><ExternalLink size={14} /> Open decompiled code</a>
            : <p className={styles.message}>This provider has not attached a viewable code artifact to the unit.</p>}
        </div>}
      </>}
      <button type="button" className={styles.refresh} onClick={() => void query.refetch()} disabled={query.isFetching}>
        <RefreshCw size={14} className={query.isFetching ? styles.spin : undefined} /> {query.isFetching ? 'Refreshing…' : 'Refresh map'}
      </button>
    </section>
  )
}
