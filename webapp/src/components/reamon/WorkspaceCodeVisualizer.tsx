'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Code2, Copy, Download, ExternalLink, RefreshCw, Search, WandSparkles } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { buildCodeUnitTreemapEntries, filterCodeUnits, filterCodeUnitsByPackage, layoutCodeUnitTreemap, parseCodeUnitFilter, summarizeCodeUnits, type CodeUnit, type CodeUnitTreemapEntry } from '@/lib/reamon/code-units'
import type { CallGraphRecord, CallGraphRelationship } from '@/lib/reamon/callgraph-layout'
import { sourceSyntaxLanguage } from './source-language'
import { WorkspaceCallGraphCanvas } from './WorkspaceCallGraphCanvas'
import styles from './WorkspaceCodeVisualizer.module.css'

interface CodeUnitResponse {
  units: CodeUnit[]
  total: number
  maintainedCount: number
  hasMore: boolean
  nextCursor: string | null
  runs: Array<{
    id: string
    title: string
    createdAt: string
    completedAt: string | null
    artifactName: string
    providerId: string | null
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

interface MaintainedCoverageResponse {
  taskId: string
  codeUnitCount: number
  maintainedUnitCount: number
  coveragePercent: number
}

interface CallGraphNode {
  key: string
  label: string
  address: string | null
  codeUnit: CodeUnit | null
  isFocus: boolean
}

interface CallGraphResponse {
  graphType?: 'function_calls' | 'class_dependencies'
  focusKey: string | null
  nodes: CallGraphNode[]
  edges: Array<{ id: string; fromKey: string; toKey: string; label: string }>
  truncated: boolean
}

interface CodeExplanationProvider { id: string; name: string; modelIdentifier: string }
interface CodeExplanationResponse { explanation: string; providerName: string; model: string; sourceTruncated: boolean }
interface CodeMaintenanceResponse { sourceCode: string; providerName: string; model: string; syntaxValidated?: boolean }

const EMPTY_CODE_UNITS: CodeUnit[] = []

async function fetchCodeUnits(projectId: string, taskId: string | null, cursor: string | null = null, signal?: AbortSignal, search = ''): Promise<CodeUnitResponse> {
  const params = new URLSearchParams()
  if (taskId) params.set('taskId', taskId)
  if (cursor) params.set('cursor', cursor)
  if (search) params.set('q', search)
  const query = params.size ? `?${params.toString()}` : ''
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer${query}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to load code units')
  return response.json()
}

async function fetchMaintainedCoverage(projectId: string, taskId: string, signal?: AbortSignal): Promise<MaintainedCoverageResponse> {
  const params = new URLSearchParams({ taskId })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/coverage?${params.toString()}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to load maintained-source coverage')
  const result = await response.json() as Partial<MaintainedCoverageResponse>
  if (result.taskId !== taskId || !Number.isSafeInteger(result.codeUnitCount) || !Number.isSafeInteger(result.maintainedUnitCount) || !Number.isSafeInteger(result.coveragePercent)) {
    throw new Error('Maintained-source coverage response is incomplete')
  }
  return result as MaintainedCoverageResponse
}

async function fetchCallGraph(projectId: string, taskId: string, unitId: string, signal?: AbortSignal): Promise<CallGraphResponse> {
  const params = new URLSearchParams({ taskId, unitId })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/callgraph?${params.toString()}`, { signal, cache: 'no-store' })
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(detail?.error || 'Unable to load this function call graph')
  }
  return response.json()
}

async function fetchRunCallGraph(projectId: string, taskId: string, unitId: string, signal?: AbortSignal): Promise<CallGraphResponse> {
  const params = new URLSearchParams({ taskId, view: 'graph' })
  if (unitId) params.set('unitId', unitId)
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/callgraph?${params.toString()}`, { signal, cache: 'no-store' })
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(detail?.error || 'Unable to load this run call graph')
  }
  return response.json()
}

function artifactUrl(projectId: string, unit: CodeUnit, codeArtifactId: string | null): string | null {
  if (!unit.artifactId || !codeArtifactId) return null
  const sourcePath = codeArtifactId.split('/').map(encodeURIComponent).join('/')
  return '/api/projects/' + encodeURIComponent(projectId) + '/artifacts/' + encodeURIComponent(unit.artifactId) + '/decompiled/' + sourcePath
}

async function fetchSource(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(detail?.error || 'Could not load code output')
  }
  return response.text()
}

async function fetchExplanationProviders(projectId: string): Promise<CodeExplanationProvider[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/providers`, { cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to load saved AI providers')
  const data = await response.json() as { providers?: CodeExplanationProvider[] }
  return Array.isArray(data.providers) ? data.providers : []
}

function isDisassemblyUnit(unit: CodeUnit | undefined): boolean {
  return unit?.language === 'WebAssembly Text (WAT)' || unit?.language === 'Smali'
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

function maintenanceColor(maintainedUnitCount: number, unitCount: number): string {
  if (maintainedUnitCount <= 0) return 'var(--status-neutral-bg, #394458)'
  if (maintainedUnitCount >= unitCount) return 'var(--status-success, #00a876)'
  return 'var(--status-warning, #b99a3b)'
}

function shortenLabel(value: string, width: number): string {
  const maxCharacters = Math.max(0, Math.floor((width - 14) / 7.2))
  if (maxCharacters < 5) return ''
  return value.length > maxCharacters ? `${value.slice(0, maxCharacters - 1)}…` : value
}

function SourceListing({ source, language, fileName }: { source: string; language: string | null | undefined; fileName: string | null | undefined }) {
  const syntaxLanguage = sourceSyntaxLanguage(language, fileName)
  return <SyntaxHighlighter
    className={styles.sourceCode}
    language={syntaxLanguage}
    style={vscDarkPlus}
    showLineNumbers
    lineNumberStyle={{ color: '#68788f', minWidth: '3.25em', paddingRight: '1.25em', userSelect: 'none' }}
    customStyle={{ margin: 0, borderRadius: 0, background: 'transparent', fontSize: 'inherit', lineHeight: 'inherit' }}
    codeTagProps={{ className: styles.sourceCodeText }}
  >{source}</SyntaxHighlighter>
}

function CallGraphPanel({ focusUnit, graph, isLoading, isError, error, onSelectUnit }: {
  focusUnit: CodeUnit
  graph: CallGraphResponse | undefined
  isLoading: boolean
  isError: boolean
  error: string
  onSelectUnit: (unit: CodeUnit) => void
}) {
  const nodeByKey = new Map((graph?.nodes || []).map((node) => [node.key, node]))
  const incoming = (graph?.edges || []).filter((edge) => edge.toKey === graph?.focusKey)
  const outgoing = (graph?.edges || []).filter((edge) => edge.fromKey === graph?.focusKey)
  const maxVisible = 8

  function nodeControl(node: CallGraphNode | undefined, fallbackLabel: string, isFocus = false) {
    if (!node) return <span className={styles.graphExternal}>{fallbackLabel}<small>Function unavailable</small></span>
    if (isFocus) return <span className={`${styles.graphNode} ${styles.graphFocus}`}><strong>{node.label}</strong>{node.address && <small>{node.address}</small>}</span>
    if (node.codeUnit) return <button type="button" className={styles.graphNode} onClick={() => onSelectUnit(node.codeUnit as CodeUnit)} aria-label={`Open function ${node.label}`}>
      <strong>{node.label}</strong>{node.address && <small>{node.address}</small>}
    </button>
    return <span className={styles.graphExternal} title="External or not decompiled in this run"><strong>{node.label}</strong><small>{node.address || 'External or not decompiled'}</small></span>
  }

  return <section className={styles.callGraph} aria-labelledby="call-graph-heading">
    <div className={styles.callGraphHeader}>
      <div><h3 id="call-graph-heading">Function call graph</h3><p>Direct callers and callees from this Ghidra run. Select a linked function to open its code.</p></div>
      <span className={styles.graphBadge}>Ghidra</span>
    </div>
    {isLoading && <p className={styles.message}>Loading function relationships…</p>}
    {isError && <p className={styles.error} role="alert">{error}</p>}
    {!isLoading && !isError && graph && incoming.length === 0 && outgoing.length === 0 && <p className={styles.message}>No direct call relationships were recorded for this function.</p>}
    {!isLoading && !isError && graph && (incoming.length > 0 || outgoing.length > 0) && <div className={styles.graphGroups}>
      {incoming.length > 0 && <div className={styles.graphGroup}>
        <h4>Called by</h4>
        <div className={styles.graphEdges}>
          {incoming.slice(0, maxVisible).map((edge) => <div className={styles.graphEdge} key={edge.id}>
            {nodeControl(nodeByKey.get(edge.fromKey), edge.fromKey)}
            <span className={styles.graphArrow} aria-label="calls">→</span>
            {nodeControl(nodeByKey.get(edge.toKey), focusUnit.name, true)}
          </div>)}
        </div>
        {incoming.length > maxVisible && <p className={styles.message}>Showing {maxVisible} of {incoming.length} callers.</p>}
      </div>}
      {outgoing.length > 0 && <div className={styles.graphGroup}>
        <h4>Calls</h4>
        <div className={styles.graphEdges}>
          {outgoing.slice(0, maxVisible).map((edge) => <div className={styles.graphEdge} key={edge.id}>
            {nodeControl(nodeByKey.get(edge.fromKey), focusUnit.name, true)}
            <span className={styles.graphArrow} aria-label="calls">→</span>
            {nodeControl(nodeByKey.get(edge.toKey), edge.toKey)}
          </div>)}
        </div>
        {outgoing.length > maxVisible && <p className={styles.message}>Showing {maxVisible} of {outgoing.length} called functions.</p>}
      </div>}
      {graph.truncated && <p className={styles.message}>This function has more relationships than the graph response limit; showing the first results.</p>}
    </div>}
  </section>
}

export function WorkspaceCodeVisualizer({ projectId, isAnalyzing, decompilationTask, decompilationHref }: {
  projectId: string
  isAnalyzing: boolean
  decompilationTask?: { status: string; progressMessage?: string | null }
  decompilationHref?: string
}) {
  const [filter, setFilter] = useState('')
  const [maintenanceFilter, setMaintenanceFilter] = useState<'all' | 'needs-work' | 'maintained'>('all')
  const [serverSearch, setServerSearch] = useState('')
  const [visualizerView, setVisualizerView] = useState<'treemap' | 'callgraph'>('treemap')
  const [mapLayer, setMapLayer] = useState<'decompilation' | 'maintenance'>('decompilation')
  const [packagePath, setPackagePath] = useState('')
  const [graphSearch, setGraphSearch] = useState('')
  const [graphFocusKey, setGraphFocusKey] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [graphUnit, setGraphUnit] = useState<CodeUnit | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [assemblyCopyStatus, setAssemblyCopyStatus] = useState('')
  const [providerId, setProviderId] = useState('')
  const [question, setQuestion] = useState('')
  const [explanation, setExplanation] = useState<CodeExplanationResponse | null>(null)
  const [explainError, setExplainError] = useState('')
  const [explaining, setExplaining] = useState(false)
  const [maintainedDraft, setMaintainedDraft] = useState('')
  const [maintenanceMeta, setMaintenanceMeta] = useState<CodeMaintenanceResponse | null>(null)
  const [maintenanceError, setMaintenanceError] = useState('')
  const [transforming, setTransforming] = useState(false)
  const [savingMaintained, setSavingMaintained] = useState(false)
  const [maintainedSaved, setMaintainedSaved] = useState(false)
  const queryClient = useQueryClient()
  const initializedMaintainedUnits = useRef(new Set<string>())
  const [additionalPage, setAdditionalPage] = useState<{ runId: string | null; search: string; units: CodeUnit[]; nextCursor: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState('')
  const filterSearch = parseCodeUnitFilter(filter).text
  useEffect(() => {
    const timeout = window.setTimeout(() => setServerSearch(filterSearch), 250)
    return () => window.clearTimeout(timeout)
  }, [filterSearch])
  const query = useQuery({
    queryKey: ['reamon-code-units', projectId, selectedRunId, serverSearch],
    queryFn: ({ signal }) => fetchCodeUnits(projectId, selectedRunId, null, signal, serverSearch),
    staleTime: 5_000,
    refetchInterval: isAnalyzing ? 3000 : false,
    refetchIntervalInBackground: false,
  })
  const baseUnits = query.data?.units || EMPTY_CODE_UNITS
  const runs = query.data?.runs || []
  const currentRunId = runs.some((run) => run.id === selectedRunId) ? selectedRunId : query.data?.selectedRunId || null
  useEffect(() => { setPackagePath('') }, [currentRunId])
  const pageState = additionalPage?.runId === currentRunId && additionalPage.search === serverSearch ? additionalPage : null
  const units = useMemo(() => {
    if (!pageState?.units.length) return baseUnits
    const byId = new Map(baseUnits.map((unit) => [unit.id, unit]))
    for (const unit of pageState.units) byId.set(unit.id, unit)
    return [...byId.values()]
  }, [baseUnits, pageState])
  const nextCursor = pageState ? pageState.nextCursor : query.data?.nextCursor || null
  const currentRunIndex = runs.findIndex((run) => run.id === currentRunId)
  const currentRun = currentRunIndex >= 0 ? runs[currentRunIndex] : null
  const maintainedCoverageQuery = useQuery({
    queryKey: ['reamon-maintained-coverage', projectId, currentRunId],
    queryFn: ({ signal }) => fetchMaintainedCoverage(projectId, currentRunId as string, signal),
    enabled: Boolean(currentRunId),
    staleTime: 5_000,
    refetchInterval: isAnalyzing ? 3000 : false,
    refetchIntervalInBackground: false,
  })
  const canShowCallGraph = currentRun?.providerId === 'reamon-ghidra' || currentRun?.providerId === 'reamon-jadx'
  const graphType = currentRun?.providerId === 'reamon-jadx' ? 'class_dependencies' : 'function_calls'
  const visibleUnits = useMemo(() => filterCodeUnits(units, filter), [units, filter])
  const mapScopeUnits = useMemo(() => filterCodeUnitsByPackage(visibleUnits, packagePath), [packagePath, visibleUnits])
  const packageUnits = useMemo(() => mapScopeUnits.filter((unit) => maintenanceFilter === 'all'
    || (maintenanceFilter === 'maintained' ? Boolean(unit.maintainedSource) : !unit.maintainedSource)), [maintenanceFilter, mapScopeUnits])
  const treemapEntries = useMemo(() => buildCodeUnitTreemapEntries(packageUnits, packagePath), [packagePath, packageUnits])
  const rectangles = useMemo(() => layoutCodeUnitTreemap(treemapEntries, 1200, 560), [treemapEntries])
  const summary = useMemo(() => summarizeCodeUnits(packageUnits), [packageUnits])
  const maintainedUnits = useMemo(() => packageUnits.filter((unit) => unit.maintainedSource).length, [packageUnits])
  const selectedUnit = packageUnits.find((unit) => unit.id === selectedId)
    || (graphUnit?.id === selectedId ? graphUnit : undefined)
  const runCallGraphQuery = useQuery({
    queryKey: ['reamon-callgraph-run', projectId, currentRunId, selectedUnit?.id],
    queryFn: ({ signal }) => fetchRunCallGraph(projectId, currentRunId as string, selectedUnit?.id || '', signal),
    enabled: Boolean(currentRunId && (currentRun?.providerId === 'reamon-ghidra' || currentRun?.providerId === 'reamon-jadx') && visualizerView === 'callgraph'),
    staleTime: 30_000,
    gcTime: 60_000,
  })
  const callGraphQuery = useQuery({
    queryKey: ['reamon-callgraph', projectId, currentRunId, selectedUnit?.id],
    queryFn: ({ signal }) => fetchCallGraph(projectId, currentRunId as string, selectedUnit?.id as string, signal),
    enabled: Boolean(currentRunId && selectedUnit?.source === 'reamon-ghidra' && selectedUnit.unitType === 'function'),
    staleTime: 30_000,
    gcTime: 60_000,
  })
  const selectedSourceUrl = selectedUnit ? artifactUrl(projectId, selectedUnit, selectedUnit.codeArtifactId) : null
  const selectedDisassemblyUrl = selectedUnit ? artifactUrl(projectId, selectedUnit, selectedUnit.disassemblyArtifactId) : null
  const sourceQuery = useQuery({
    queryKey: ['reamon-decompiled-source', selectedUnit?.id, selectedUnit?.codeArtifactId],
    queryFn: ({ signal }) => fetchSource(selectedSourceUrl as string, signal),
    enabled: Boolean(selectedSourceUrl),
    staleTime: 5 * 60_000,
    gcTime: 60_000,
  })
  const disassemblyQuery = useQuery({
    queryKey: ['reamon-disassembly', selectedUnit?.id, selectedUnit?.disassemblyArtifactId],
    queryFn: ({ signal }) => fetchSource(selectedDisassemblyUrl as string, signal),
    enabled: Boolean(selectedDisassemblyUrl),
    staleTime: 5 * 60_000,
    gcTime: 60_000,
  })
  const maintainedDraftDiffersFromSource = sourceQuery.data === undefined
    || maintainedDraft.replace(/\r\n?/g, '\n').trim() !== sourceQuery.data.replace(/\r\n?/g, '\n').trim()
  const maintainedQuery = useQuery({
    queryKey: ['reamon-maintained-source', projectId, selectedUnit?.id],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit?.id || '')}`, { signal, cache: 'no-store' })
      if (!response.ok) throw new Error('Unable to load the maintained source copy')
      return response.json() as Promise<{ exists: boolean; sourceCode: string | null; updatedAt?: string }>
    },
    enabled: Boolean(selectedUnit && selectedSourceUrl),
    staleTime: 30_000,
    gcTime: 60_000,
  })
  useEffect(() => {
    setMaintainedSaved(false)
    setMaintenanceMeta(null)
    setMaintenanceError('')
    setMaintainedDraft('')
  }, [selectedUnit?.id])
  useEffect(() => {
    const unitId = selectedUnit?.id
    if (!unitId || initializedMaintainedUnits.current.has(unitId) || !maintainedQuery.isFetched) return
    if (maintainedQuery.data?.exists && typeof maintainedQuery.data.sourceCode === 'string') {
      setMaintainedDraft(maintainedQuery.data.sourceCode)
      setMaintainedSaved(true)
      initializedMaintainedUnits.current.add(unitId)
    } else if (sourceQuery.data !== undefined) {
      setMaintainedDraft(sourceQuery.data)
      initializedMaintainedUnits.current.add(unitId)
    }
  }, [selectedUnit?.id, maintainedQuery.data, maintainedQuery.isFetched, sourceQuery.data])
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
  const graphSearchResults = useMemo(() => {
    const search = graphSearch.trim().toLocaleLowerCase()
    if (!search) return []
    return (runCallGraphQuery.data?.nodes || [])
      .filter((node) => `${node.label} ${node.address || ''} ${node.codeUnit?.artifactPath || ''}`.toLocaleLowerCase().includes(search))
      .slice(0, 8)
  }, [runCallGraphQuery.data, graphSearch])
  const graphFocus = runCallGraphQuery.data?.nodes.find((node) => node.key === graphFocusKey)
    || runCallGraphQuery.data?.nodes.find((node) => node.codeUnit?.id === selectedUnit?.id)
    || null

  function selectGraphNode(node: CallGraphRecord) {
    setGraphFocusKey(node.key)
    if (!node.codeUnit) return
    setGraphUnit(node.codeUnit)
    setSelectedId(node.codeUnit.id)
    setCopyStatus('')
    setAssemblyCopyStatus('')
    setExplanation(null)
    setExplainError('')
  }

  async function copySource(text = sourceQuery.data, assembly = false) {
    if (!text) return
    const setStatus = assembly ? setAssemblyCopyStatus : setCopyStatus
    try {
      await navigator.clipboard.writeText(text)
      setStatus('Copied')
    } catch {
      setStatus('Clipboard unavailable')
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
    setAdditionalPage(null)
    setLoadMoreError('')
    setSelectedId(null)
    setGraphUnit(null)
    setVisualizerView('treemap')
    setPackagePath('')
    setGraphFocusKey(null)
    setGraphSearch('')
    setCopyStatus('')
    setAssemblyCopyStatus('')
    setExplanation(null)
    setExplainError('')
  }

  async function deobfuscateSelectedUnit() {
    if (!selectedUnit || !selectedProviderId) return
    setTransforming(true)
    setMaintenanceError('')
    setMaintenanceMeta(null)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unitId: selectedUnit.id, providerId: selectedProviderId, question: question.trim() }),
      })
      const result = await response.json().catch(() => ({})) as CodeMaintenanceResponse & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not create a maintainable version')
      setMaintainedDraft(result.sourceCode)
      setMaintenanceMeta(result)
      setMaintainedSaved(false)
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not create a maintainable version')
    } finally {
      setTransforming(false)
    }
  }

  async function saveMaintainedSource() {
    if (!selectedUnit || !maintainedDraft.trim()) return
    setSavingMaintained(true)
    setMaintenanceError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceCode: maintainedDraft }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not save the maintained source')
      setMaintainedSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-coverage', projectId, currentRunId] })
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not save the maintained source')
    } finally {
      setSavingMaintained(false)
    }
  }

  function openTreemapEntry(entry: CodeUnitTreemapEntry) {
    if (entry.packagePath) {
      setPackagePath(entry.packagePath)
      setSelectedId(null)
      setGraphUnit(null)
      setExplanation(null)
      setExplainError('')
      return
    }
    if (!entry.codeUnit) return
    setSelectedId(entry.codeUnit.id)
    setGraphUnit(null)
    setCopyStatus('')
    setAssemblyCopyStatus('')
    setExplanation(null)
    setExplainError('')
  }

  function showPackage(packageName: string) {
    setPackagePath(packageName)
    setSelectedId(null)
    setGraphUnit(null)
    setExplanation(null)
    setExplainError('')
  }

  function showMaintenanceFilter(value: 'all' | 'needs-work' | 'maintained') {
    setMaintenanceFilter(value)
    setSelectedId(null)
    setGraphUnit(null)
  }

  async function loadMoreUnits(loadAll = false) {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError('')
    try {
      let cursor = nextCursor
      let loadedUnits = pageState?.units || []
      let pagesLoaded = 0
      while (cursor) {
        const page = await fetchCodeUnits(projectId, currentRunId, cursor, undefined, serverSearch)
        loadedUnits = [...loadedUnits, ...page.units]
        const nextPageCursor = page.nextCursor || null
        setAdditionalPage({
          runId: currentRunId,
          search: serverSearch,
          units: loadedUnits,
          nextCursor: nextPageCursor,
        })
        pagesLoaded += 1
        if (!loadAll || !nextPageCursor) break
        if (nextPageCursor === cursor || pagesLoaded >= 100) throw new Error('The code-unit page cursor did not advance')
        cursor = nextPageCursor
      }
    } catch (error) {
      setLoadMoreError(error instanceof Error ? error.message : 'Could not load more code units')
    } finally {
      setLoadingMore(false)
    }
  }

  async function refreshMap() {
    await query.refetch()
    setAdditionalPage(null)
    setLoadMoreError('')
  }

  return (
    <section id="code-visualizer" className={styles.panel} aria-labelledby="code-visualizer-heading">
      <div className={styles.header}>
        <div>
          <p className={styles.kicker}>Program structure</p>
          <h2 id="code-visualizer-heading"><Code2 size={18} /> Code visualizer</h2>
          <p className={styles.description}>Follow each code unit from analyzer decompilation through reverse engineering into a separate, maintainable source copy. Select a tile to inspect the original, create and review its maintained version, then save or export both outputs.</p>
        </div>
        {query.data && <span className={styles.badge}>{nextCursor ? `${units.length.toLocaleString()} / ${query.data.total.toLocaleString()} code units` : `${units.length.toLocaleString()} code units`}</span>}
      </div>

      {canShowCallGraph && <div className={styles.viewSwitcher} role="group" aria-label="Code visualizer view">
        <button type="button" className={visualizerView === 'treemap' ? styles.viewButtonActive : styles.viewButton} aria-pressed={visualizerView === 'treemap'} onClick={() => setVisualizerView('treemap')}>Treemap</button>
        <button type="button" className={visualizerView === 'callgraph' ? styles.viewButtonActive : styles.viewButton} aria-pressed={visualizerView === 'callgraph'} onClick={() => setVisualizerView('callgraph')}>{graphType === 'class_dependencies' ? 'Class dependencies' : 'Call graph'}</button>
      </div>}

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
          <span>{currentRun.truncated ? currentRun.linkPercent === null ? 'Partial index; the analyzer could not determine the total class count.' : 'Partial index. This bar shows indexed coverage, not whether the task finished.' : `${currentRun.indexedUnitCount.toLocaleString()} indexed code units`}</span>{currentRun.truncated && decompilationHref && <a className={styles.runAgain} href={decompilationHref}>Run decompilation again</a>}
          {currentRun.failedUnitCount !== null && currentRun.failedUnitCount > 0 && <span>{currentRun.failedUnitCount.toLocaleString()} functions could not be decompiled{currentRun.visitedUnitCount !== null ? ` of ${currentRun.visitedUnitCount.toLocaleString()} visited` : ''}</span>}
        </div>
        {currentRun.warnings && <p className={styles.runWarning}>{currentRun.warnings}</p>}
      </div>}

      {currentRun && <div className={styles.runSummary} aria-label="Selected run maintainable-source progress">
        {maintainedCoverageQuery.isLoading && <p className={styles.message}>Checking reverse-engineered source coverage…</p>}
        {maintainedCoverageQuery.isError && <p className={styles.error} role="alert">Could not load maintainable-source progress. Refresh the map to try again.</p>}
        {maintainedCoverageQuery.data && <>
          <div className={styles.runSummaryHeading}>
            <div>
              <strong>{maintainedCoverageQuery.data.coveragePercent}% reverse engineered into maintainable source</strong>
              <span>{maintainedCoverageQuery.data.maintainedUnitCount.toLocaleString()} of {maintainedCoverageQuery.data.codeUnitCount.toLocaleString()} code units have a saved maintained copy</span>
            </div>
            <span>AI drafts count after review and save</span>
          </div>
          <div className={`${styles.runProgress} ${styles.maintainedProgress}`} role="progressbar" aria-label="Maintained source coverage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={maintainedCoverageQuery.data.coveragePercent} aria-valuetext={`${maintainedCoverageQuery.data.coveragePercent}% reverse engineered into maintainable source`}>
            <span style={{ width: `${maintainedCoverageQuery.data.coveragePercent}%` }} />
          </div>
        </>}
      </div>}

      {query.isLoading && <p className={styles.message}>Loading code units…</p>}
      {query.isError && <p className={styles.error}>Could not load code units. Refresh the workspace and try again.</p>}
      {!query.isLoading && !query.isError && query.data && units.length === 0 && query.data.total === 0 && filter.trim() && (
        <div className={styles.empty} role="status">
          <strong>No code units match this filter.</strong>
          <p>Name, address, and path search checks the full selected run. Clear or change the filter to see other code units.</p>
        </div>
      )}
      {!query.isLoading && !query.isError && query.data && units.length === 0 && query.data.total === 0 && (
        !filter.trim() && <div className={styles.empty}>
          {decompilationTask?.status === 'RUNNING' ? <>
            <strong>Decompilation is running.</strong>
            <p>{decompilationTask.progressMessage || 'The code map will fill in after the analyzer publishes its results.'}</p>
          </> : decompilationTask?.status === 'QUEUED' ? <>
            <strong>Decompilation is queued.</strong>
            <p>Open the task controls and choose Run to start the analyzer.</p>
            <a className={styles.emptyAction} href="#analysis-tasks">Open task controls</a>
          </> : decompilationTask?.status === 'AWAITING_APPROVAL' ? <>
            <strong>Decompilation is waiting for approval.</strong>
            <p>Approve the task in the task controls before running it.</p>
            <a className={styles.emptyAction} href="#analysis-tasks">Open task controls</a>
          </> : decompilationTask?.status === 'COMPLETED' ? <>
            <strong>The analyzer finished without viewable code units.</strong>
            <p>Review the task output and warnings under task controls.</p>
            <a className={styles.emptyAction} href="#analysis-tasks">Review task</a>
          </> : decompilationTask?.status === 'FAILED' || decompilationTask?.status === 'CANCELLED' ? <>
            <strong>Decompilation did not finish.</strong>
            <p>Review the task and retry it from the task controls.</p>
            <a className={styles.emptyAction} href="#analysis-tasks">Open task controls</a>
          </> : <>
            <strong>No code units have been analyzed yet.</strong>
            <p>Importing a file records and profiles it. Run a compatible analyzer to populate this map with classes, functions, and their code.</p>
            {decompilationHref && <a className={styles.emptyAction} href={decompilationHref}>Run decompilation</a>}
          </>}
        </div>
      )}
      {!query.isLoading && !query.isError && query.data && units.length === 0 && query.data.total > 0 && (
        <div className={styles.empty}>
          <strong>This batch has no code units with a usable byte size.</strong>
          <p>The map needs each provider to report a positive size for a function, class, or other unit. The stored records remain available in the investigation history.</p>
        </div>
      )}
      {!query.isLoading && !query.isError && query.data && (query.data.total > 0 || filter.trim()) && <>
        <label className={styles.filter}>
          <Search size={16} aria-hidden="true" />
          <span className={styles.srOnly}>Filter code units</span>
          <input value={filter} maxLength={300} onChange={(event) => setFilter(event.target.value)} placeholder="Search this run by name, address, or path · >10kb · <70%" />
        </label>
        <p className={styles.message}>Name, address, and path search spans the full run. Size, decompilation, and maintained-source filters apply to code units loaded here.</p>
        {visualizerView === 'treemap' && <div className={styles.maintenanceFilters} role="group" aria-label="Maintained source status">
          <span>Maintained source</span>
          <button type="button" className={maintenanceFilter === 'all' ? styles.viewButtonActive : styles.viewButton} aria-pressed={maintenanceFilter === 'all'} onClick={() => showMaintenanceFilter('all')}>All ({mapScopeUnits.length.toLocaleString()})</button>
          <button type="button" className={maintenanceFilter === 'needs-work' ? styles.viewButtonActive : styles.viewButton} aria-pressed={maintenanceFilter === 'needs-work'} onClick={() => showMaintenanceFilter('needs-work')}>Needs work ({mapScopeUnits.filter((unit) => !unit.maintainedSource).length.toLocaleString()})</button>
          <button type="button" className={maintenanceFilter === 'maintained' ? styles.viewButtonActive : styles.viewButton} aria-pressed={maintenanceFilter === 'maintained'} onClick={() => showMaintenanceFilter('maintained')}>Maintained ({mapScopeUnits.filter((unit) => unit.maintainedSource).length.toLocaleString()})</button>
        </div>}
        {visualizerView === 'treemap' && <div className={styles.maintenanceFilters} role="group" aria-label="Treemap color layer">
          <span>Color by</span>
          <button type="button" className={mapLayer === 'decompilation' ? styles.viewButtonActive : styles.viewButton} aria-pressed={mapLayer === 'decompilation'} onClick={() => setMapLayer('decompilation')}>Decompilation</button>
          <button type="button" className={mapLayer === 'maintenance' ? styles.viewButtonActive : styles.viewButton} aria-pressed={mapLayer === 'maintenance'} onClick={() => setMapLayer('maintenance')}>Maintained source</button>
        </div>}
        {currentRun && visualizerView === 'treemap' && <a className={styles.runButton} href={`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/export?taskId=${encodeURIComponent(currentRun.id)}`}>
          Download source bundle · {currentRun.codeUnitCount.toLocaleString()} code {currentRun.codeUnitCount === 1 ? 'unit' : 'units'}
        </a>}
      </>}

      {!query.isLoading && !query.isError && query.data && units.length > 0 && <>
        <div className={styles.stats}>
          <div><strong>{packageUnits.length.toLocaleString()}</strong><span>Code units in this map</span></div>
          <div><strong>{summary.sourceLinkedPercent === null ? 'Unknown' : `${summary.sourceLinkedPercent}%`}</strong><span>Viewable source links in map ({summary.sourceLinkedUnits.toLocaleString()}/{packageUnits.length.toLocaleString()})</span></div>
          <div><strong>{formatBytes(summary.totalBytes)}</strong><span>Code bytes in this map</span></div>
          <div><strong>{summary.coveragePercent === null ? 'Unknown' : `${summary.coveragePercent}%`}</strong><span>Decompilation completeness of measured bytes in map</span></div>
          <div><strong>{summary.decompiledUnits.toLocaleString()}</strong><span>Fully decompiled units in map</span></div>
          <div><strong>{maintainedUnits.toLocaleString()}</strong><span>Maintained source copies in map</span></div>
        </div>
        {summary.unmeasuredBytes > 0 && <p className={styles.message}>{formatBytes(summary.unmeasuredBytes)} of mapped code has no decompilation completeness value from its provider.</p>}

        {mapLayer === 'decompilation' ? <div className={styles.legend} role="group" aria-label="Decompilation completeness legend">
          <span><i className={styles.complete} /> Full decompilation</span>
          <span><i className={styles.partial} /> Partial decompilation</span>
          <span><i className={styles.none} /> No decompilation</span>
          <span><i className={styles.unknown} /> Unmeasured</span>
          <span><i className={styles.maintainedLegend}>M</i> Maintained source saved</span>
        </div> : <div className={styles.legend} role="group" aria-label="Maintained source legend">
          <span><i className={styles.complete} /> Maintained source saved</span>
          <span><i className={styles.unknown} /> Not yet maintained</span>
          <span><i className={styles.partial} /> Partly maintained package</span>
        </div>}

        {visualizerView === 'treemap' && (treemapEntries.length ? <div className={styles.mapFrame}>
          {packagePath && <nav className={styles.packagePath} aria-label="Code package path">
            <button type="button" onClick={() => showPackage('')}>All packages</button>
            {packagePath.split('.').map((part, index, parts) => {
              const path = parts.slice(0, index + 1).join('.')
              return <span key={path}><span aria-hidden="true">/</span><button type="button" aria-current={index === parts.length - 1 ? 'page' : undefined} onClick={() => showPackage(path)}>{part}</button></span>
            })}
          </nav>}
          <svg className={styles.map} viewBox="0 0 1200 560" role="group" aria-label={`Package and code unit treemap sized by bytes and colored by ${mapLayer === 'decompilation' ? 'decompilation completeness' : 'maintained source status'}`}>
            {rectangles.map(({ unit, x, y, width, height }) => {
              const label = shortenLabel(unit.name, width)
              const coverage = unit.coveragePercent === null ? 'decompilation completeness unmeasured' : `${Math.round(unit.coveragePercent)}% decompilation completeness`
              const detail = unit.packagePath ? `${unit.unitCount.toLocaleString()} code units` : formatBytes(unit.sizeBytes)
              const maintained = unit.maintainedUnitCount > 0
              const maintainedDetail = unit.packagePath
                ? `${unit.maintainedUnitCount} of ${unit.unitCount} units have maintained source`
                : unit.codeUnit?.maintainedSource ? 'maintained source saved' : 'not yet reverse-engineered into maintained source'
              const fill = mapLayer === 'decompilation'
                ? unitColor(unit.coveragePercent)
                : maintenanceColor(unit.maintainedUnitCount, unit.unitCount)
              return <g
                key={unit.key}
                className={`${styles.tile} ${unit.codeUnit?.id === selectedId ? styles.selected : ''} ${unit.packagePath ? styles.packageTile : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`${unit.name}${unit.packagePath ? ' package' : ''}, ${formatBytes(unit.sizeBytes)}, ${coverage}${unit.packagePath ? `, ${unit.unitCount.toLocaleString()} code units` : unit.codeUnit?.address ? `, address ${unit.codeUnit.address}` : ''}, ${maintainedDetail}`}
                onClick={() => openTreemapEntry(unit)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openTreemapEntry(unit)
                  }
                }}
              >
                <title>{`${unit.name}${unit.packagePath ? ' package' : ''} · ${formatBytes(unit.sizeBytes)} · ${coverage}${unit.packagePath ? ` · ${unit.unitCount.toLocaleString()} code units` : unit.codeUnit?.address ? ` · ${unit.codeUnit.address}` : ''} · ${maintainedDetail}`}</title>
                <rect x={x + 1} y={y + 1} width={Math.max(0, width - 2)} height={Math.max(0, height - 2)} fill={fill} rx="3" />
                {maintained && width >= 28 && height >= 24 && <><circle className={styles.maintainedBadge} cx={x + width - 13} cy={y + 13} r="9" /><text className={styles.maintainedBadgeText} x={x + width - 13} y={y + 13}>M</text></>}
                {label && <text x={x + 9} y={y + 20} className={styles.tileName}>{label}</text>}
                {label && width > 115 && height > 48 && <text x={x + 9} y={y + 38} className={styles.tileMeta}>{detail}</text>}
              </g>
            })}
          </svg>
        </div> : <p className={styles.noMatches}>{maintenanceFilter === 'all' ? 'No code units match this filter.' : 'No code units match this maintained-source status in the current map.'}</p>)}

        {visualizerView === 'callgraph' && <section className={styles.callGraph} aria-labelledby="run-call-graph-heading">
          <div className={styles.callGraphHeader}>
            <div><h3 id="run-call-graph-heading">{graphType === 'class_dependencies' ? 'Program class dependencies' : 'Program call graph'}</h3><p>{graphType === 'class_dependencies' ? 'Classes connected by references found in Android bytecode. Select a class to open its decompiled source.' : 'Functions and direct calls recorded by Ghidra. Drag to arrange, scroll to zoom, or select a function to open its code.'}</p></div>
            {runCallGraphQuery.data && <span className={styles.graphBadge}>{graphType === 'class_dependencies'
              ? `${runCallGraphQuery.data.nodes.length.toLocaleString()} classes · ${runCallGraphQuery.data.edges.length.toLocaleString()} dependencies`
              : `${runCallGraphQuery.data.nodes.length.toLocaleString()} functions · ${runCallGraphQuery.data.edges.length.toLocaleString()} calls`}</span>}
          </div>
          <label className={styles.filter}>
            <Search size={16} aria-hidden="true" />
            <span className={styles.srOnly}>Search call graph</span>
            <input value={graphSearch} onChange={(event) => setGraphSearch(event.target.value)} placeholder={graphType === 'class_dependencies' ? 'Find a class by name' : 'Find a function by name or address'} />
          </label>
          {graphSearchResults.length > 0 && <div className={styles.graphSearchResults} aria-label="Call graph search results">
            {graphSearchResults.map((node) => <button type="button" key={node.key} onClick={() => selectGraphNode(node)}>
              <strong>{node.label}</strong><small>{node.address || (node.codeUnit ? node.codeUnit.artifactPath : 'External or not decompiled')}</small>
            </button>)}
          </div>}
          {runCallGraphQuery.isLoading && <p className={styles.message}>Loading run relationships…</p>}
          {runCallGraphQuery.isError && <p className={styles.error} role="alert">{runCallGraphQuery.error instanceof Error ? runCallGraphQuery.error.message : 'Unable to load this run call graph'}</p>}
          {!runCallGraphQuery.isLoading && !runCallGraphQuery.isError && runCallGraphQuery.data && runCallGraphQuery.data.nodes.length === 0 && <p className={styles.message}>{graphType === 'class_dependencies' ? 'This JADX run did not record any class references.' : 'This Ghidra run did not record any function calls.'}</p>}
          {!runCallGraphQuery.isLoading && !runCallGraphQuery.isError && runCallGraphQuery.data && runCallGraphQuery.data.nodes.length > 0 && <WorkspaceCallGraphCanvas
            nodes={runCallGraphQuery.data.nodes as CallGraphRecord[]}
            edges={runCallGraphQuery.data.edges as CallGraphRelationship[]}
            focusKey={graphFocus?.key || runCallGraphQuery.data.focusKey}
            graphType={runCallGraphQuery.data.graphType || graphType}
            onSelectNode={selectGraphNode}
          />}
          {runCallGraphQuery.data?.truncated && <p className={styles.message}>{graphType === 'class_dependencies' ? 'The graph has more class references than the display limit; refine the class filter to explore a smaller area.' : 'Showing the first 400 call relationships returned by the analyzer.'}</p>}
        </section>}

        {nextCursor && <p className={styles.message}>Showing {units.length.toLocaleString()} of {query.data.total.toLocaleString()} code units matching the name, address, or path search. Load more to include additional units in size and coverage filters.</p>}
        {selectedUnit && <div className={styles.details}>
          <div><span className={styles.detailLabel}>Selected code unit</span><strong>{selectedUnit.name}</strong>{selectedUnit.maintainedSource && <span className={styles.savedStatus}>Maintained source saved</span>}</div>
          <dl>
            <div><dt>Address</dt><dd>{selectedUnit.address || 'Not supplied'}</dd></div>
            <div><dt>Size</dt><dd>{formatBytes(selectedUnit.sizeBytes)}</dd></div>
            <div><dt>Language</dt><dd>{selectedUnit.language || 'Not identified'}</dd></div>
            <div><dt>Unit type</dt><dd>{selectedUnit.unitType || 'Code unit'}</dd></div>
            <div><dt>Artifact</dt><dd>{selectedUnit.artifactPath || 'Not linked'}</dd></div>
            <div><dt>Provider</dt><dd>{selectedUnit.source}</dd></div>
          </dl>
          {(selectedUnit.classReferences?.length ?? 0) > 0 && <section className={styles.classReferences} aria-label="Related classes">
            <div><strong>Related classes</strong><span>From Android bytecode references</span></div>
            <ul>{selectedUnit.classReferences?.slice(0, 24).map((name) => <li key={name}>
              <button type="button" onClick={() => { setFilter(name); setSelectedId(null); setGraphUnit(null); setPackagePath('') }} title={`Find ${name} in this run`}>{name}</button>
            </li>)}</ul>
            {(selectedUnit.classReferences?.length ?? 0) > 24 && <small>Showing 24 of {selectedUnit.classReferences?.length} references.</small>}
          </section>}
          {selectedUnit.artifactId && selectedUnit.codeArtifactId
            ? <a
                className={styles.codeLink}
                href={selectedSourceUrl || undefined}
                target="_blank"
                rel="noreferrer"
              ><ExternalLink size={14} /> Open code separately</a>
            : <p className={styles.message}>This provider has not attached a viewable code artifact to the unit.</p>}
        </div>}
        {visualizerView === 'treemap' && selectedUnit?.source === 'reamon-ghidra' && selectedUnit.unitType === 'function' && <CallGraphPanel
          focusUnit={selectedUnit}
          graph={callGraphQuery.data}
          isLoading={callGraphQuery.isLoading}
          isError={callGraphQuery.isError}
          error={callGraphQuery.error instanceof Error ? callGraphQuery.error.message : 'Unable to load this function call graph'}
          onSelectUnit={(unit) => {
            setGraphUnit(unit)
            setSelectedId(unit.id)
            setCopyStatus('')
            setAssemblyCopyStatus('')
            setExplanation(null)
            setExplainError('')
          }}
        />}
        {selectedUnit && selectedSourceUrl && <section className={styles.sourcePanel} aria-label={selectedDisassemblyUrl ? 'Decompilation and disassembly comparison' : (selectedUnit.language === 'WebAssembly Text (WAT)' ? 'WAT disassembly' : isDisassemblyUnit(selectedUnit) ? 'Smali disassembly' : 'Decompiled source')}>
          {selectedDisassemblyUrl ? <div className={styles.comparison}>
            <div className={styles.listingPane}>
              <div className={styles.sourceHeader}>
                <div><strong>Decompiled source</strong><span>{selectedUnit.language || 'Source'} · {selectedUnit.codeArtifactId?.split('/').pop()}</span></div>
                <button type="button" className={styles.copyButton} onClick={() => void copySource()} disabled={!sourceQuery.data}><Copy size={14} /> {copyStatus || 'Copy source'}</button>
              </div>
              {sourceQuery.isLoading && <p className={styles.message}>Loading decompiled source…</p>}
              {sourceQuery.isError && <p className={styles.error}>{sourceQuery.error instanceof Error ? sourceQuery.error.message : 'Could not load decompiled source'}</p>}
              {sourceQuery.data !== undefined && <SourceListing source={sourceQuery.data} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} />}
            </div>
            <div className={styles.listingPane}>
              <div className={styles.sourceHeader}>
                <div><strong>{selectedUnit.disassemblyLanguage || 'Disassembly'}</strong><span>{selectedUnit.address || 'Function listing'} · {selectedUnit.disassemblyArtifactId?.split('/').pop()}</span></div>
                <button type="button" className={styles.copyButton} onClick={() => void copySource(disassemblyQuery.data, true)} disabled={!disassemblyQuery.data}><Copy size={14} /> {assemblyCopyStatus || 'Copy assembly'}</button>
              </div>
              {disassemblyQuery.isLoading && <p className={styles.message}>Loading instruction listing…</p>}
              {disassemblyQuery.isError && <p className={styles.error}>{disassemblyQuery.error instanceof Error ? disassemblyQuery.error.message : 'Could not load instruction listing'}</p>}
              {disassemblyQuery.data !== undefined && <SourceListing source={disassemblyQuery.data} language={selectedUnit.disassemblyLanguage} fileName={selectedUnit.disassemblyArtifactId?.split('/').pop()} />}
            </div>
          </div> : <>
            <div className={styles.sourceHeader}>
              <div><strong>{selectedUnit.name}</strong><span>{selectedUnit.language || 'Source'} · {selectedUnit.codeArtifactId?.split('/').pop()}</span></div>
              <button type="button" className={styles.copyButton} onClick={() => void copySource()} disabled={!sourceQuery.data}><Copy size={14} /> {copyStatus || 'Copy code'}</button>
            </div>
            {sourceQuery.isLoading && <p className={styles.message}>Loading code output…</p>}
            {sourceQuery.isError && <p className={styles.error}>{sourceQuery.error instanceof Error ? sourceQuery.error.message : 'Could not load code output'}</p>}
            {sourceQuery.data !== undefined && <SourceListing source={sourceQuery.data} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} />}
          </>}
        </section>}
        {selectedUnit && selectedSourceUrl && <section className={styles.maintainPanel} aria-labelledby="code-maintain-heading">
          <div>
            <h3 id="code-maintain-heading"><WandSparkles size={16} /> Reverse engineer into maintainable code</h3>
            <p>Use the decompiled source, related classes, bytecode, and names from previously saved maintained code across this project to recover intent and build consistent, clearer source. Review and edit the reconstructed copy before saving; the original decompilation stays intact.</p>
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
            <label className={styles.explainField}>Reverse-engineering guidance (optional)
              <textarea value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1000} rows={3} placeholder="For example: recover the purpose of short names and simplify generated control flow." />
            </label>
            <button type="button" className={styles.explainButton} onClick={() => void deobfuscateSelectedUnit()} disabled={!selectedProviderId || transforming || sourceQuery.isError || sourceQuery.isLoading || maintainedQuery.isLoading}>
              {transforming ? 'Reverse engineering…' : 'Create maintainable version'}
            </button>
          </>}
          {maintenanceError && <p className={styles.error} role="alert">{maintenanceError}</p>}
          {maintenanceMeta && <p className={styles.message}>Reverse-engineered draft from {maintenanceMeta.providerName} · {maintenanceMeta.model}. {maintenanceMeta.syntaxValidated ? 'The source parser found no syntax errors. Review the reconstructed logic and behavior before saving.' : 'Syntax validation was unavailable for this language. Check the reconstructed code and its behavior before saving.'}</p>}
          {maintainedQuery.isError && <p className={styles.error} role="alert">{maintainedQuery.error instanceof Error ? maintainedQuery.error.message : 'Could not load maintained source'}</p>}
          {maintainedDraft && <>
            <div className={styles.maintainedComparison}>
              <div><strong>Original decompilation</strong>
                {sourceQuery.data !== undefined && <SourceListing source={sourceQuery.data} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} />}
              </div>
              <label>Editable maintained copy
                <textarea aria-label="Editable maintained source" value={maintainedDraft} spellCheck={false} onChange={(event) => { setMaintainedDraft(event.target.value); setMaintainedSaved(false) }} />
              </label>
            </div>
            <div className={styles.maintainedActions}>
              <button type="button" className={styles.explainButton} onClick={() => void saveMaintainedSource()} disabled={savingMaintained || !maintainedDraft.trim() || !maintainedDraftDiffersFromSource}>{savingMaintained ? 'Saving…' : maintainedSaved ? 'Save changes' : 'Save maintained copy'}</button>
              {!maintainedDraftDiffersFromSource && <span className={styles.message}>Edit the decompilation or create a maintained version before saving.</span>}
              {maintainedSaved && <a className={styles.copyButton} href={`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit.id)}?download=1`}><Download size={14} /> Download source</a>}
              {maintainedSaved && <span className={styles.savedStatus} role="status">Maintained copy saved separately</span>}
            </div>
          </>}
        </section>}
        {selectedUnit && selectedSourceUrl && <section className={styles.explainPanel} aria-labelledby="code-explain-heading">
          <div>
            <h3 id="code-explain-heading">Explain this code with AI</h3>
            <p>When you choose Explain, this code is sent to the selected saved provider. API keys stay on the server. Check the explanation against the code before relying on it.</p>
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
      {nextCursor && <div className={styles.loadMore}>
        <span role="status">Loaded {units.length.toLocaleString()} of {query.data?.total.toLocaleString() || '0'} code units</span>
        <button type="button" className={styles.runButton} onClick={() => void loadMoreUnits()} disabled={loadingMore}>
          {loadingMore ? 'Loading code units…' : 'Load more code units'}
        </button>
        <button type="button" className={styles.runButton} onClick={() => void loadMoreUnits(true)} disabled={loadingMore}>
          {loadingMore ? 'Loading full map…' : `Load all ${Math.max(0, (query.data?.total || 0) - units.length).toLocaleString()} remaining`}
        </button>
        {loadMoreError && <p className={styles.error} role="alert">{loadMoreError}</p>}
      </div>}
      <button type="button" className={styles.refresh} onClick={() => void refreshMap()} disabled={query.isFetching}>
        <RefreshCw size={14} className={query.isFetching ? styles.spin : undefined} /> {query.isFetching ? 'Refreshing…' : 'Refresh map'}
      </button>
    </section>
  )
}
