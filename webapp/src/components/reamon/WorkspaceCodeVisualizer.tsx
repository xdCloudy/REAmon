'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Code2, Copy, Download, ExternalLink, RefreshCw, Search, WandSparkles } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { buildCodeUnitTreemapEntries, filterCodeUnits, filterCodeUnitsByFolder, layoutCodeUnitTreemap, parseCodeUnitFilter, summarizeCodeUnits, type CodeUnit, type CodeUnitTreemapEntry } from '@/lib/reamon/code-units'
import type { CallGraphRecord, CallGraphRelationship } from '@/lib/reamon/callgraph-layout'
import { sourceSyntaxLanguage } from './source-language'
import { WorkspaceCallGraphCanvas } from './WorkspaceCallGraphCanvas'
import styles from './WorkspaceCodeVisualizer.module.css'

interface CodeUnitResponse {
  units: CodeUnit[]
  functionMapMembers?: FunctionMapMember[]
  functionMapTruncated?: boolean
  total: number
  maintainedCount: number
  hasMore: boolean
  nextCursor: string | null
  runs: Array<{
    id: string
    apktoolProjectAvailable: boolean
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

interface FunctionMapMember {
  id: string
  key: string
  name: string
  fullName: string
  address: string | null
  language: string | null
  similarityAvailable: boolean
  memberKind: string
  line: number | null
  parentCodeUnit: CodeUnit
}

interface MaintainedCoverageResponse {
  taskId: string
  codeUnitCount: number
  maintainedUnitCount: number
  coveragePercent: number
  decompilationCoveragePercent: number | null
  sourceLinkedPercent: number
  codeBytes: number
  measuredBytes: number
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

interface SimilarFunctionsResponse {
  matches: Array<{ codeUnit: CodeUnit; similarity: number; artifact: { name: string; sha256: string | null } }>
  truncated: boolean
}

interface CodeExplanationProvider { id: string; name: string; modelIdentifier: string }
interface CodeExplanationResponse { explanation: string; providerName: string; model: string; sourceTruncated: boolean }
interface ApkBuildResponse { buildId: string; taskId: string; fileName: string; sizeBytes: number; sha256: string; signed: false; changedFileCount: number; warnings?: string; downloadUrl: string }
interface CodeMaintenanceResponse { sourceCode: string; providerName: string; model: string; syntaxValidated?: boolean | null }
interface CodeDraftRecord { id: string; sourceCode: string; providerName: string; modelIdentifier: string; question: string; scope: 'file' | 'member'; syntaxValidated: boolean | null; updatedAt: string }
interface CodeAttemptRecord { id: string; providerName: string; modelIdentifier: string; question: string; scope: 'file' | 'member'; status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; errorCode: string | null; errorMessage: string | null; resultSource: string | null; syntaxValidated: boolean | null; createdAt: string; completedAt: string | null }
interface CodeDraftResponse { exists: boolean; draft: CodeDraftRecord | null; attempts?: CodeAttemptRecord[] }
interface CodeMemberOutline { name: string; kind: 'function' | 'method' | 'constructor'; start_byte: number; end_byte: number; line: number; source_bytes: number }

const EMPTY_CODE_UNITS: CodeUnit[] = []
const AUTO_LOAD_CODE_UNIT_LIMIT = 20_000
const FOLDER_VIEW_CODE_UNIT_LIMIT = 2_000
const FUNCTION_MAP_CLIENT_LIMIT = 20_000

async function fetchCodeUnits(projectId: string, taskId: string | null, cursor: string | null = null, signal?: AbortSignal, search = '', unitId = ''): Promise<CodeUnitResponse> {
  const params = new URLSearchParams()
  if (taskId) params.set('taskId', taskId)
  if (cursor) params.set('cursor', cursor)
  if (search) params.set('q', search)
  if (unitId) params.set('unitId', unitId)
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
  if (result.taskId !== taskId || !Number.isSafeInteger(result.codeUnitCount) || !Number.isSafeInteger(result.maintainedUnitCount) || !Number.isSafeInteger(result.coveragePercent)
      || !(result.decompilationCoveragePercent === null || Number.isSafeInteger(result.decompilationCoveragePercent))
      || !Number.isSafeInteger(result.sourceLinkedPercent) || !Number.isSafeInteger(result.codeBytes) || !Number.isSafeInteger(result.measuredBytes)) {
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

async function fetchSimilarFunctions(projectId: string, taskId: string, unitId: string, signal?: AbortSignal): Promise<SimilarFunctionsResponse> {
  const params = new URLSearchParams({ taskId, unitId })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/similar-functions?${params.toString()}`, { signal, cache: 'no-store' })
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(detail?.error || 'Unable to find similar functions')
  }
  return response.json()
}

async function fetchRunCallGraph(projectId: string, taskId: string, unitId: string, graphType: 'function_calls' | 'class_dependencies', signal?: AbortSignal): Promise<CallGraphResponse> {
  const params = new URLSearchParams({ taskId, view: 'graph' })
  if (unitId) params.set('unitId', unitId)
  params.set('graphType', graphType)
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

function languageLabel(unit: CodeUnit): string {
  if (unit.sourceLanguage && unit.language === 'C') return `C-like pseudocode · ${unit.sourceLanguage} binary`
  return unit.language || 'Source'
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

function workStatusColor(draftedUnitCount: number, maintainedUnitCount: number, unitCount: number): string {
  if (draftedUnitCount > 0) return 'var(--accent-secondary)'
  return maintenanceColor(maintainedUnitCount, unitCount)
}

function shortenLabel(value: string, width: number): string {
  const maxCharacters = Math.max(0, Math.floor((width - 14) / 7.2))
  if (maxCharacters < 5) return ''
  return value.length > maxCharacters ? `${value.slice(0, maxCharacters - 1)}…` : value
}

const MAX_SOURCE_PREVIEW_CHARS = 25_000
const MAX_MEMBER_REWRITE_BYTES = 64 * 1024
const MAX_MEMBER_OUTLINE_BYTES = 2 * 1024 * 1024

function SourceListing({ source, language, fileName, fullSourceUrl }: { source: string; language: string | null | undefined; fileName: string | null | undefined; fullSourceUrl?: string | null }) {
  const syntaxLanguage = sourceSyntaxLanguage(language, fileName)
  const preview = source.length > MAX_SOURCE_PREVIEW_CHARS
    ? source.slice(0, MAX_SOURCE_PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/, '')
    : source
  return <>
    {source.length > MAX_SOURCE_PREVIEW_CHARS && <p className={styles.sourcePreviewNote} role="status">
      Showing the first {MAX_SOURCE_PREVIEW_CHARS.toLocaleString()} characters of {source.length.toLocaleString()}. {fullSourceUrl
        ? <a href={fullSourceUrl} target="_blank" rel="noreferrer">Open the full artifact</a>
        : 'Open the full code artifact separately to inspect the rest.'}
    </p>}
    <SyntaxHighlighter
      className={styles.sourceCode}
      language={syntaxLanguage}
      style={vscDarkPlus}
      showLineNumbers
      lineNumberStyle={{ color: '#68788f', minWidth: '3.25em', paddingRight: '1.25em', userSelect: 'none' }}
      customStyle={{ margin: 0, borderRadius: 0, background: 'transparent', fontSize: 'inherit', lineHeight: 'inherit' }}
      codeTagProps={{ className: styles.sourceCodeText }}
    >{preview}</SyntaxHighlighter>
  </>
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
      <div><h3 id="call-graph-heading">Function call graph</h3><p>Direct callers and callees recorded for this analysis. Select a linked function to open its code.</p></div>
      <span className={styles.graphBadge}>{focusUnit.source.replace(/^reamon-/, '').toUpperCase()}</span>
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

export function WorkspaceCodeVisualizer({ projectId, isAnalyzing, decompilationTask, decompilationHref, standalone = false }: {
  projectId: string
  isAnalyzing: boolean
  decompilationTask?: { status: string; progressMessage?: string | null }
  decompilationHref?: string
  standalone?: boolean
}) {
  const [filter, setFilter] = useState('')
  const [maintenanceFilter, setMaintenanceFilter] = useState<'all' | 'needs-work' | 'drafted' | 'maintained'>('all')
  const [serverSearch, setServerSearch] = useState('')
  const [visualizerView, setVisualizerView] = useState<'function-map' | 'treemap' | 'callgraph'>('function-map')
  const [mapContentPreference, setMapContentPreference] = useState<'auto' | 'units' | 'folders'>('auto')
  const [mapLayer, setMapLayer] = useState<'decompilation' | 'maintenance' | 'work'>('work')
  const [folderPath, setFolderPath] = useState<string[]>([])
  const [languageFilter, setLanguageFilter] = useState('')
  const [graphSearch, setGraphSearch] = useState('')
  const [graphFocusKey, setGraphFocusKey] = useState<string | null>(null)
  const [jadxGraphType, setJadxGraphType] = useState<'function_calls' | 'class_dependencies'>('function_calls')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedFunctionMapMember, setSelectedFunctionMapMember] = useState<{ id: string; parentUnitId: string; name: string; similarityAvailable: boolean } | null>(null)
  const [urlInitialized, setUrlInitialized] = useState(false)
  const [graphUnit, setGraphUnit] = useState<CodeUnit | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [assemblyCopyStatus, setAssemblyCopyStatus] = useState('')
  const [providerId, setProviderId] = useState('')
  const [question, setQuestion] = useState('')
  const [explanation, setExplanation] = useState<CodeExplanationResponse | null>(null)
  const [explainError, setExplainError] = useState('')
  const [explaining, setExplaining] = useState(false)
  const [maintainedDraft, setMaintainedDraft] = useState('')
  const [draftId, setDraftId] = useState<string | null>(null)
  const [draftSource, setDraftSource] = useState<string | null>(null)
  const [draftScope, setDraftScope] = useState<'file' | 'member' | null>(null)
  const [savingDraft, setSavingDraft] = useState(false)
  const [maintenanceMeta, setMaintenanceMeta] = useState<CodeMaintenanceResponse | null>(null)
  const [maintenanceError, setMaintenanceError] = useState('')
  const [transforming, setTransforming] = useState(false)
  const [savingMaintained, setSavingMaintained] = useState(false)
  const [maintainedSaved, setMaintainedSaved] = useState(false)
  const [smaliDraft, setSmaliDraft] = useState('')
  const [smaliSaved, setSmaliSaved] = useState(false)
  const [savingSmali, setSavingSmali] = useState(false)
  const [smaliError, setSmaliError] = useState('')
  const [memberFilter, setMemberFilter] = useState('')
  const [rewrittenMembers, setRewrittenMembers] = useState<Set<string>>(new Set())
  const queryClient = useQueryClient()
  const initializedMaintainedUnits = useRef(new Set<string>())
  const unitInspectorRef = useRef<HTMLElement>(null)
  const maintainedEditorRef = useRef<HTMLTextAreaElement>(null)
  const [additionalPage, setAdditionalPage] = useState<{ runId: string | null; search: string; units: CodeUnit[]; functionMapMembers: FunctionMapMember[]; functionMapTruncated: boolean; nextCursor: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState('')
  const [apkBuild, setApkBuild] = useState<ApkBuildResponse | null>(null)
  const [buildingApk, setBuildingApk] = useState(false)
  const [apkBuildError, setApkBuildError] = useState('')
  const filterSearch = parseCodeUnitFilter(filter).text
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const taskId = params.get('taskId')?.trim()
    const unitId = params.get('unitId')?.trim()
    if (taskId) setSelectedRunId(taskId)
    if (unitId) setSelectedId(unitId)
    setUrlInitialized(true)
  }, [])
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
  useEffect(() => { setFolderPath([]) }, [currentRunId])
  const pageState = additionalPage?.runId === currentRunId && additionalPage.search === serverSearch ? additionalPage : null
  const units = useMemo(() => {
    if (!pageState?.units.length) return baseUnits
    const byId = new Map(baseUnits.map((unit) => [unit.id, unit]))
    for (const unit of pageState.units) byId.set(unit.id, unit)
    return [...byId.values()]
  }, [baseUnits, pageState])
  const functionMapMembers = useMemo(() => {
    const byId = new Map((query.data?.functionMapMembers || []).map((member) => [member.id, member]))
    for (const member of pageState?.functionMapMembers || []) byId.set(member.id, member)
    return [...byId.values()].slice(0, FUNCTION_MAP_CLIENT_LIMIT)
  }, [pageState, query.data?.functionMapMembers])
  const functionMapTruncated = Boolean(query.data?.functionMapTruncated || pageState?.functionMapTruncated)
  const linkedUnitQuery = useQuery({
    queryKey: ['reamon-code-unit-link', projectId, currentRunId, selectedId],
    queryFn: ({ signal }) => fetchCodeUnits(projectId, currentRunId, null, signal, '', selectedId as string),
    enabled: Boolean(selectedId && !units.some((unit) => unit.id === selectedId)),
    staleTime: 30_000,
    gcTime: 60_000,
  })
  useEffect(() => {
    if (!urlInitialized) return
    const url = new URL(window.location.href)
    if (currentRunId) url.searchParams.set('taskId', currentRunId)
    else url.searchParams.delete('taskId')
    if (selectedId) url.searchParams.set('unitId', selectedId)
    else url.searchParams.delete('unitId')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [currentRunId, selectedId, urlInitialized])
  const nextCursor = pageState ? pageState.nextCursor : query.data?.nextCursor || null
  const currentRunIndex = runs.findIndex((run) => run.id === currentRunId)
  const currentRun = currentRunIndex >= 0 ? runs[currentRunIndex] : null
  const displayRunWarnings = currentRun?.warnings.replace(/(?:^|\s)Picked up JAVA_TOOL_OPTIONS:(?:\s+-\S+)*/g, '').trim() || ''
  const maintainedCoverageQuery = useQuery({
    queryKey: ['reamon-maintained-coverage', projectId, currentRunId],
    queryFn: ({ signal }) => fetchMaintainedCoverage(projectId, currentRunId as string, signal),
    enabled: Boolean(currentRunId),
    staleTime: 5_000,
    refetchInterval: isAnalyzing ? 3000 : false,
    refetchIntervalInBackground: false,
  })
  const canShowCallGraph = Boolean(currentRun?.providerId)
  const graphType = currentRun?.providerId === 'reamon-jadx' ? jadxGraphType : 'function_calls'
  const visibleUnits = useMemo(() => {
    const matchedUnits = filterCodeUnits(units, filter)
    if (!filterSearch) return matchedUnits
    const structuralTokens = filter.trim().split(/\s+/).filter((token) => /^>\d+(?:\.\d+)?(?:b|kb|mb)?$/i.test(token) || /^<\d+(?:\.\d+)?%$/.test(token))
    const eligibleParentIds = new Set(filterCodeUnits(units, structuralTokens.join(' ')).map((unit) => unit.id))
    const memberParentIds = new Set(functionMapMembers
      .filter((member) => `${member.name} ${member.fullName}`.toLocaleLowerCase().includes(filterSearch))
      .map((member) => member.parentCodeUnit.id))
    const visibleById = new Map(matchedUnits.map((unit) => [unit.id, unit]))
    for (const unit of units) {
      if (eligibleParentIds.has(unit.id) && memberParentIds.has(unit.id)) visibleById.set(unit.id, unit)
    }
    return [...visibleById.values()]
  }, [filter, filterSearch, functionMapMembers, units])
  const availableLanguages = useMemo(() => {
    const languages: string[] = []
    for (const unit of units) {
      for (const language of [unit.language, unit.sourceLanguage]) {
        if (language?.trim()) languages.push(language.trim())
      }
    }
    return [...new Set(languages)].sort((left, right) => left.localeCompare(right))
  }, [units])
  const activeLanguageFilter = availableLanguages.includes(languageFilter) ? languageFilter : ''
  const languageFilteredUnits = useMemo(() => activeLanguageFilter
    ? visibleUnits.filter((unit) => unit.language?.trim() === activeLanguageFilter || unit.sourceLanguage?.trim() === activeLanguageFilter)
    : visibleUnits, [activeLanguageFilter, visibleUnits])
  const mapContent = mapContentPreference === 'auto'
    ? ((query.data?.total || 0) > FOLDER_VIEW_CODE_UNIT_LIMIT ? 'folders' : 'units')
    : mapContentPreference
  const mapScopeUnits = useMemo(() => filterCodeUnitsByFolder(languageFilteredUnits, folderPath), [folderPath, languageFilteredUnits])
  const folderUnits = useMemo(() => mapScopeUnits.filter((unit) => maintenanceFilter === 'all'
    || (maintenanceFilter === 'maintained'
      ? Boolean(unit.maintainedSource)
      : maintenanceFilter === 'drafted'
        ? Boolean(unit.draftSource)
        : !unit.maintainedSource)), [maintenanceFilter, mapScopeUnits])
  const visibleFunctionMapMembers = useMemo(() => {
    const nameFilter = filterSearch.toLocaleLowerCase()
    const parentById = new Map(folderUnits.map((unit) => [unit.id, unit]))
    return functionMapMembers.flatMap((member) => {
      const parentCodeUnit = parentById.get(member.parentCodeUnit.id)
      if (!parentCodeUnit || (nameFilter && !`${member.name} ${member.fullName}`.toLocaleLowerCase().includes(nameFilter))) return []
      return [{ ...member, parentCodeUnit }]
    })
  }, [filterSearch, folderUnits, functionMapMembers])
  const treemapEntries = useMemo(() => mapContent === 'folders'
    ? buildCodeUnitTreemapEntries(folderUnits, folderPath)
    : folderUnits.map((unit): CodeUnitTreemapEntry => ({
      key: `unit:${unit.id}`,
      name: unit.name,
      sizeBytes: unit.sizeBytes,
      coveragePercent: unit.coveragePercent,
      codeUnit: unit,
      unitCount: 1,
      maintainedUnitCount: unit.maintainedSource ? 1 : 0,
      draftedUnitCount: unit.draftSource ? 1 : 0,
    })), [mapContent, folderPath, folderUnits])
  const rectangles = useMemo(() => layoutCodeUnitTreemap(treemapEntries, 1200, 560), [treemapEntries])
  const summary = useMemo(() => summarizeCodeUnits(folderUnits), [folderUnits])
  const maintainedUnits = useMemo(() => folderUnits.filter((unit) => unit.maintainedSource).length, [folderUnits])
  const selectedUnit = folderUnits.find((unit) => unit.id === selectedId)
    || linkedUnitQuery.data?.units.find((unit) => unit.id === selectedId)
    || (graphUnit?.id === selectedId ? graphUnit : undefined)
  const runCallGraphQuery = useQuery({
    queryKey: ['reamon-callgraph-run', projectId, currentRunId, selectedUnit?.id, graphFocusKey, graphType],
    queryFn: ({ signal }) => fetchRunCallGraph(projectId, currentRunId as string,
      graphFocusKey || (selectedUnit?.unitType === 'function' ? selectedUnit.id : ''), graphType, signal),
    enabled: Boolean(currentRunId && currentRun?.providerId && visualizerView === 'callgraph'),
    staleTime: 30_000,
    gcTime: 60_000,
  })
  const callGraphQuery = useQuery({
    queryKey: ['reamon-callgraph', projectId, currentRunId, selectedUnit?.id],
    queryFn: ({ signal }) => fetchCallGraph(projectId, currentRunId as string, selectedUnit?.id as string, signal),
    enabled: Boolean(currentRunId && currentRun?.providerId === selectedUnit?.source && selectedUnit?.unitType === 'function'),
    staleTime: 30_000,
    gcTime: 60_000,
  })
  const selectedFunctionMapTarget = selectedFunctionMapMember && selectedFunctionMapMember.parentUnitId === selectedUnit?.id && selectedFunctionMapMember.similarityAvailable
    ? selectedFunctionMapMember.id
    : ''
  const selectedSimilarityTarget = selectedFunctionMapTarget || (selectedUnit?.unitType === 'function' ? selectedUnit.id : '')
  const similarFunctionsQuery = useQuery({
    queryKey: ['reamon-similar-functions', projectId, currentRunId, selectedSimilarityTarget],
    queryFn: ({ signal }) => fetchSimilarFunctions(projectId, currentRunId as string, selectedSimilarityTarget, signal),
    enabled: Boolean(currentRunId && selectedSimilarityTarget
      && (currentRun?.providerId === 'reamon-ghidra' || currentRun?.providerId === 'reamon-wabt' || currentRun?.providerId === 'reamon-jadx' || currentRun?.providerId === 'reamon-ilspy')
      && selectedUnit?.source === currentRun?.providerId),
    staleTime: 5 * 60_000,
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
  const smaliSourceQuery = useQuery({
    queryKey: ['reamon-maintained-smali', projectId, selectedUnit?.id],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit?.id || '')}/smali`, { signal, cache: 'no-store' })
      const result = await response.json().catch(() => ({})) as { sourceCode?: string; exists?: boolean; error?: string }
      if (!response.ok || typeof result.sourceCode !== 'string') throw new Error(result.error || 'Unable to load Smali source')
      return result as { sourceCode: string; exists: boolean }
    },
    enabled: Boolean(selectedUnit?.disassemblyLanguage?.toLowerCase() === 'smali' && selectedUnit.disassemblyArtifactId),
    staleTime: 0,
    gcTime: 60_000,
  })
  const sourceByteLength = useMemo(() => sourceQuery.data === undefined ? null : new TextEncoder().encode(sourceQuery.data).byteLength, [sourceQuery.data])
  const largeSource = sourceByteLength !== null && sourceByteLength > MAX_MEMBER_REWRITE_BYTES
  const memberOutlineEligible = Boolean(selectedUnit?.language?.trim() && selectedUnit.language.trim().toLowerCase() !== 'unknown' && selectedUnit.unitType !== 'resource')
  const memberOutlineAvailable = Boolean(memberOutlineEligible && sourceByteLength !== null && sourceByteLength <= MAX_MEMBER_OUTLINE_BYTES)
  const memberOutlineQuery = useQuery({
    queryKey: ['reamon-member-outline', projectId, selectedUnit?.id, selectedUnit?.codeArtifactId, selectedUnit?.language],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ unitId: selectedUnit?.id, scope: 'outline' }),
      })
      const result = await response.json().catch(() => ({})) as { members?: CodeMemberOutline[]; truncated?: boolean; unsupported?: boolean; error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not build a function or method outline')
      return { members: Array.isArray(result.members) ? result.members : [], truncated: result.truncated === true, unsupported: result.unsupported === true }
    },
    enabled: memberOutlineAvailable,
    staleTime: 5 * 60_000,
    gcTime: 60_000,
  })
  const filteredMembers = (memberOutlineQuery.data?.members || []).filter((member) => `${member.name} ${member.kind} ${member.line}`.toLocaleLowerCase().includes(memberFilter.trim().toLocaleLowerCase())).slice(0, 200)
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
  const codeDraftQuery = useQuery({
    queryKey: ['reamon-code-draft', projectId, selectedUnit?.id],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/drafts/${encodeURIComponent(selectedUnit?.id || '')}`, { signal, cache: 'no-store' })
      if (!response.ok) throw new Error('Unable to load the saved AI draft')
      return response.json() as Promise<CodeDraftResponse>
    },
    enabled: Boolean(selectedUnit && selectedSourceUrl),
    staleTime: 0,
    gcTime: 60_000,
  })
  useEffect(() => {
    const unitId = selectedUnit?.id
    if (unitId) initializedMaintainedUnits.current.delete(unitId)
    setMaintainedSaved(false)
    setMaintenanceMeta(null)
    setMaintenanceError('')
    setMaintainedDraft('')
    setSmaliDraft('')
    setSmaliSaved(false)
    setSmaliError('')
    setDraftId(null)
    setDraftSource(null)
    setDraftScope(null)
    setQuestion('')
    setRewrittenMembers(new Set())
  }, [selectedUnit?.id])
  useEffect(() => {
    if (!smaliSourceQuery.data) return
    setSmaliDraft(smaliSourceQuery.data.sourceCode)
    setSmaliSaved(smaliSourceQuery.data.exists)
  }, [selectedUnit?.id, smaliSourceQuery.data])
  useEffect(() => {
    const memberFilterTarget = selectedFunctionMapMember && selectedFunctionMapMember.parentUnitId === selectedUnit?.id
      ? selectedFunctionMapMember.name
      : ''
    setMemberFilter(memberFilterTarget)
  }, [selectedFunctionMapMember, selectedUnit?.id])
  useEffect(() => {
    const unitId = selectedUnit?.id
    if (!unitId || initializedMaintainedUnits.current.has(unitId) || !maintainedQuery.isFetched || !codeDraftQuery.isFetched || sourceQuery.data === undefined) return
    const savedDraft = codeDraftQuery.data?.draft
    const savedMaintained = maintainedQuery.data?.exists && typeof maintainedQuery.data.sourceCode === 'string'
      ? maintainedQuery.data
      : null
    const preferDraft = Boolean(savedDraft && (!savedMaintained || Date.parse(savedDraft.updatedAt) > Date.parse(savedMaintained.updatedAt || '')))
    if (preferDraft && savedDraft) {
      setMaintainedDraft(savedDraft.sourceCode)
      setDraftId(savedDraft.id)
      setDraftSource(savedDraft.sourceCode)
      setDraftScope(savedDraft.scope)
      setQuestion(savedDraft.question)
      setMaintenanceMeta({ sourceCode: savedDraft.sourceCode, providerName: savedDraft.providerName, model: savedDraft.modelIdentifier, syntaxValidated: savedDraft.syntaxValidated ?? undefined })
    } else if (savedMaintained) {
      setMaintainedDraft(savedMaintained.sourceCode as string)
      setMaintainedSaved(true)
      initializedMaintainedUnits.current.add(unitId)
    } else {
      setMaintainedDraft(sourceQuery.data)
      initializedMaintainedUnits.current.add(unitId)
    }
    if (preferDraft) initializedMaintainedUnits.current.add(unitId)
  }, [selectedUnit?.id, codeDraftQuery.data, codeDraftQuery.isFetched, maintainedQuery.data, maintainedQuery.isFetched, sourceQuery.data])
  function revealMaintainedEditor() {
    const focusEditor = () => {
      const editor = maintainedEditorRef.current
      if (!editor) return
      editor.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      editor.focus({ preventScroll: true })
    }
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(focusEditor)
    else window.setTimeout(focusEditor, 0)
  }
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
      .filter((node) => `${node.label} ${node.address || ''} ${node.codeUnit?.bundlePath || ''} ${node.codeUnit?.artifactPath || ''}`.toLocaleLowerCase().includes(search))
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
    revealUnitInspector()
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
    setSelectedFunctionMapMember(null)
    setGraphUnit(null)
    setVisualizerView('function-map')
    setFolderPath([])
    setGraphFocusKey(null)
    setGraphSearch('')
    setCopyStatus('')
    setAssemblyCopyStatus('')
    setExplanation(null)
    setExplainError('')
  }

  function revealUnitInspector() {
    const scrollToInspector = () => {
      if (!unitInspectorRef.current) return
      unitInspectorRef.current.scrollTop = 0
      unitInspectorRef.current.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    }
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(scrollToInspector)
    else window.setTimeout(scrollToInspector, 0)
  }

  async function persistCodeDraft(sourceCode: string, meta: CodeMaintenanceResponse, scope: 'file' | 'member'): Promise<string> {
    if (!selectedUnit) throw new Error('Select a code unit before saving a draft')
    const draftQuestion = question.trim()
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/drafts/${encodeURIComponent(selectedUnit.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceCode, providerName: meta.providerName, model: meta.model, question: draftQuestion, scope, syntaxValidated: meta.syntaxValidated ?? null }),
    })
    const result = await response.json().catch(() => ({})) as { error?: string; draftId?: string; updatedAt?: string }
    if (!response.ok || !result.draftId || !result.updatedAt) throw new Error(result.error || 'Could not save this AI draft to project memory')
    const record: CodeDraftRecord = { id: result.draftId, sourceCode, providerName: meta.providerName, modelIdentifier: meta.model, question: draftQuestion, scope, syntaxValidated: meta.syntaxValidated ?? null, updatedAt: result.updatedAt }
    setDraftId(record.id)
    setDraftSource(sourceCode)
    setDraftScope(scope)
    queryClient.setQueryData<CodeDraftResponse>(['reamon-code-draft', projectId, selectedUnit.id], (current) => ({ exists: true, draft: record, attempts: current?.attempts }))
    return record.id
  }

  async function saveCodeDraft() {
    if (!selectedUnit || !maintainedDraft.trim()) return
    const configuredProvider = explanationProviders.find((provider) => provider.id === selectedProviderId)
    const providerName = maintenanceMeta?.providerName || configuredProvider?.name
    const model = maintenanceMeta?.model || configuredProvider?.modelIdentifier
    if (!providerName || !model) {
      setMaintenanceError('Choose a saved AI provider before saving this draft to project memory.')
      return
    }
    setSavingDraft(true)
    setMaintenanceError('')
    try {
      const existingDraftId = draftId
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/drafts/${encodeURIComponent(selectedUnit.id)}`, {
        method: existingDraftId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existingDraftId
          ? { draftId: existingDraftId, sourceCode: maintainedDraft }
          : { sourceCode: maintainedDraft, providerName, model, question: question.trim(), scope: 'file', syntaxValidated: null }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string; draftId?: string; updatedAt?: string }
      if (!response.ok || (!existingDraftId && !result.draftId) || !result.updatedAt) throw new Error(result.error || 'Could not save this draft to project memory')
      const record: CodeDraftRecord = {
        id: result.draftId || existingDraftId as string,
        sourceCode: maintainedDraft,
        providerName,
        modelIdentifier: model,
        question: question.trim(),
        scope: existingDraftId ? draftScope || 'file' : 'file',
        syntaxValidated: null,
        updatedAt: result.updatedAt,
      }
      setDraftId(record.id)
      setDraftSource(maintainedDraft)
      setDraftScope(record.scope)
      queryClient.setQueryData<CodeDraftResponse>(['reamon-code-draft', projectId, selectedUnit.id], (current) => ({ exists: true, draft: record, attempts: current?.attempts }))
      setAdditionalPage((previous) => {
        if (!previous || previous.runId !== currentRunId || previous.search !== serverSearch) return previous
        return {
          ...previous,
          units: previous.units.map((unit) => unit.id === selectedUnit.id ? { ...unit, draftSource: true } : unit),
        }
      })
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-coverage', projectId, currentRunId] })
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not save this draft to project memory')
    } finally {
      setSavingDraft(false)
    }
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
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnit.id] })
      const result = await response.json().catch(() => ({})) as CodeMaintenanceResponse & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not create a maintainable version')
      setMaintainedDraft(result.sourceCode)
      setMaintenanceMeta(result)
      revealMaintainedEditor()
      setMaintainedSaved(false)
      setDraftId(null)
      setDraftSource(null)
      setDraftScope(null)
      try {
        await persistCodeDraft(result.sourceCode, result, 'file')
      } catch (error) {
        setMaintenanceError(`The AI draft is available here, but it could not be saved to project memory: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not create a maintainable version')
    } finally {
      setTransforming(false)
    }
  }

  async function deobfuscateMember(member: CodeMemberOutline) {
    if (!selectedUnit || !selectedProviderId || !sourceQuery.data || member.source_bytes > MAX_MEMBER_REWRITE_BYTES) return
    const currentSource = sourceQuery.data
    const sourceBytes = new TextEncoder().encode(currentSource)
    const originalMember = new TextDecoder().decode(sourceBytes.subarray(member.start_byte, member.end_byte))
    if (!originalMember.trim()) {
      setMaintenanceError('Could not read this method from the source. Reload the visualiser and try again.')
      return
    }
    const originalPeers = (memberOutlineQuery.data?.members || []).filter((candidate) => candidate.kind === member.kind && candidate.name === member.name)
    const peerIndex = originalPeers.indexOf(member)
    if (peerIndex < 0) {
      setMaintenanceError('Could not match this method to the current outline. Reload the visualiser and try again.')
      return
    }
    const draft = maintainedDraft || currentSource
    let draftMember: CodeMemberOutline | undefined
    try {
      const outlineResponse = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unitId: selectedUnit.id, scope: 'outline', sourceCode: draft }),
      })
      const outlineResult = await outlineResponse.json().catch(() => ({})) as { members?: CodeMemberOutline[]; error?: string }
      if (!outlineResponse.ok) throw new Error(outlineResult.error || 'Could not locate this method in the editable copy')
      draftMember = (outlineResult.members || []).filter((candidate) => candidate.kind === member.kind && candidate.name === member.name)[peerIndex]
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not locate this method in the editable copy')
      return
    }
    if (!draftMember) {
      setMaintenanceError('This method is no longer present in the editable copy. Reload the maintained copy before replacing it.')
      return
    }
    const draftBytes = new TextEncoder().encode(draft)
    const draftMemberSource = new TextDecoder().decode(draftBytes.subarray(draftMember.start_byte, draftMember.end_byte))
    if (!draftMemberSource.trim()) {
      setMaintenanceError('Could not read this method from the editable copy. Reload the maintained copy before replacing it.')
      return
    }
    const memberKey = `${member.start_byte}:${member.end_byte}`
    setTransforming(true)
    setMaintenanceError('')
    setMaintenanceMeta(null)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unitId: selectedUnit.id, providerId: selectedProviderId, question: question.trim(), scope: 'member', startByte: member.start_byte, endByte: member.end_byte, memberName: member.name }),
      })
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnit.id] })
      const result = await response.json().catch(() => ({})) as CodeMaintenanceResponse & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not reverse engineer this method')
      const updatedBytes = new Uint8Array(draftBytes.byteLength - (draftMember.end_byte - draftMember.start_byte) + new TextEncoder().encode(result.sourceCode).byteLength)
      updatedBytes.set(draftBytes.subarray(0, draftMember.start_byte), 0)
      const rewrittenBytes = new TextEncoder().encode(result.sourceCode)
      updatedBytes.set(rewrittenBytes, draftMember.start_byte)
      updatedBytes.set(draftBytes.subarray(draftMember.end_byte), draftMember.start_byte + rewrittenBytes.byteLength)
      const updatedDraft = new TextDecoder().decode(updatedBytes)
      setMaintainedDraft(updatedDraft)
      setMaintenanceMeta(result)
      revealMaintainedEditor()
      setMaintainedSaved(false)
      setRewrittenMembers((previous) => new Set(previous).add(memberKey))
      try {
        await persistCodeDraft(updatedDraft, result, 'member')
      } catch (error) {
        setMaintenanceError(`The rewritten method is available here, but it could not be saved to project memory: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not reverse engineer this method')
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
      setAdditionalPage((previous) => {
        if (!previous || previous.runId !== currentRunId || previous.search !== serverSearch) return previous
        return {
          ...previous,
          units: previous.units.map((unit) => unit.id === selectedUnit.id ? { ...unit, maintainedSource: true } : unit),
        }
      })
      setMaintainedSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-coverage', projectId, currentRunId] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-source', projectId, selectedUnit.id] })
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not save the maintained source')
    } finally {
      setSavingMaintained(false)
    }
  }

  async function saveSmaliSource() {
    if (!selectedUnit || !smaliDraft.trim()) return
    setSavingSmali(true)
    setSmaliError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit.id)}/smali`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceCode: smaliDraft }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not save Smali source')
      setSmaliSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-smali', projectId, selectedUnit.id] })
    } catch (error) {
      setSmaliError(error instanceof Error ? error.message : 'Could not save Smali source')
    } finally {
      setSavingSmali(false)
    }
  }

  function openTreemapEntry(entry: CodeUnitTreemapEntry) {
    setSelectedFunctionMapMember(null)
    if (entry.folderPath) {
      setFolderPath(entry.folderPath)
      setSelectedId(null)
      setGraphUnit(null)
      setGraphFocusKey(null)
      setExplanation(null)
      setExplainError('')
      return
    }
    if (!entry.codeUnit) return
    setSelectedId(entry.codeUnit.id)
    setGraphUnit(null)
    setGraphFocusKey(null)
    revealUnitInspector()
    setCopyStatus('')
    setAssemblyCopyStatus('')
    setExplanation(null)
    setExplainError('')
  }

  function showFolder(path: string[]) {
    setFolderPath(path)
    setSelectedId(null)
    setGraphUnit(null)
    setGraphFocusKey(null)
    setExplanation(null)
    setExplainError('')
  }

  function showMaintenanceFilter(value: 'all' | 'needs-work' | 'drafted' | 'maintained') {
    setMaintenanceFilter(value)
    setSelectedId(null)
    setSelectedFunctionMapMember(null)
    setGraphUnit(null)
    setGraphFocusKey(null)
  }

  const loadMoreUnits = useCallback(async (loadAll = false) => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError('')
    try {
      let cursor = nextCursor
      let loadedUnits = pageState?.units || []
      let loadedFunctionMembers = pageState?.functionMapMembers || query.data?.functionMapMembers || []
      let functionMembersTruncated = pageState?.functionMapTruncated || query.data?.functionMapTruncated || false
      let pagesLoaded = 0
      while (cursor) {
        const page = await fetchCodeUnits(projectId, currentRunId, cursor, undefined, serverSearch)
        loadedUnits = [...loadedUnits, ...page.units]
        const byFunctionId = new Map(loadedFunctionMembers.map((member) => [member.id, member]))
        for (const member of page.functionMapMembers || []) byFunctionId.set(member.id, member)
        const allFunctionMembers = [...byFunctionId.values()]
        loadedFunctionMembers = allFunctionMembers.slice(0, FUNCTION_MAP_CLIENT_LIMIT)
        functionMembersTruncated ||= page.functionMapTruncated === true || allFunctionMembers.length > FUNCTION_MAP_CLIENT_LIMIT
        const nextPageCursor = page.nextCursor || null
        setAdditionalPage({
          runId: currentRunId,
          search: serverSearch,
          units: loadedUnits,
          functionMapMembers: loadedFunctionMembers,
          functionMapTruncated: functionMembersTruncated,
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
  }, [currentRunId, loadingMore, nextCursor, pageState, projectId, query.data, serverSearch])

  const autoLoadedMapKeys = useRef(new Set<string>())
  useEffect(() => {
    const mapKey = `${currentRunId || ''}:${serverSearch}`
    if (!standalone || !query.data || query.data.total > AUTO_LOAD_CODE_UNIT_LIMIT || !nextCursor || autoLoadedMapKeys.current.has(mapKey)) return
    autoLoadedMapKeys.current.add(mapKey)
    void loadMoreUnits(true)
  }, [currentRunId, loadMoreUnits, nextCursor, query.data, serverSearch, standalone])

  async function refreshMap() {
    await query.refetch()
    setAdditionalPage(null)
    setLoadMoreError('')
  }

  async function rebuildAndroidApk() {
    if (!currentRun || !currentRun.apktoolProjectAvailable || buildingApk) return
    setBuildingApk(true)
    setApkBuildError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/apk/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: currentRun.id }),
      })
      const result = await response.json().catch(() => ({})) as Partial<ApkBuildResponse> & { error?: string }
      if (!response.ok || typeof result.downloadUrl !== 'string' || typeof result.sha256 !== 'string') {
        throw new Error(result.error || 'Could not rebuild this APK')
      }
      setApkBuild(result as ApkBuildResponse)
    } catch (error) {
      setApkBuildError(error instanceof Error ? error.message : 'Could not rebuild this APK')
    } finally {
      setBuildingApk(false)
    }
  }

  return (
    <section id="code-visualizer" className={`${styles.panel} ${standalone ? styles.standalone : ''}`} aria-labelledby="code-visualizer-heading">
      <div className={styles.header}>
        <div>
          <p className={styles.kicker}>Program structure</p>
          <h2 id="code-visualizer-heading"><Code2 size={18} /> Code visualizer</h2>
          <p className={styles.description}>Follow each code unit from analyzer decompilation through reverse engineering into a separate, maintainable source copy. Select a tile to inspect the original, create and review its maintained version, then save or export both outputs.</p>
        </div>
        <div className={styles.headerActions}>
          {query.data && <span className={styles.badge}>{nextCursor ? `${units.length.toLocaleString()} / ${query.data.total.toLocaleString()} code units` : `${units.length.toLocaleString()} code units`}</span>}
          {currentRun && <div className={styles.viewSwitcher} role="group" aria-label="Code visualizer view">
            <button type="button" className={visualizerView === 'function-map' ? styles.viewButtonActive : styles.viewButton} aria-pressed={visualizerView === 'function-map'} onClick={() => setVisualizerView('function-map')}>Function map</button>
            <button type="button" className={visualizerView === 'treemap' ? styles.viewButtonActive : styles.viewButton} aria-pressed={visualizerView === 'treemap'} onClick={() => setVisualizerView('treemap')}>Treemap</button>
            {canShowCallGraph && <button type="button" className={visualizerView === 'callgraph' ? styles.viewButtonActive : styles.viewButton} aria-pressed={visualizerView === 'callgraph'} onClick={() => setVisualizerView('callgraph')}>{graphType === 'class_dependencies' ? 'Class dependencies' : 'Call graph'}</button>}
          </div>}
          {currentRun?.providerId === 'reamon-jadx' && visualizerView === 'callgraph' && <div className={styles.viewSwitcher} role="group" aria-label="Android relationship graph">
            <button type="button" className={graphType === 'function_calls' ? styles.viewButtonActive : styles.viewButton} aria-pressed={graphType === 'function_calls'} onClick={() => { setGraphFocusKey(null); setJadxGraphType('function_calls') }}>Method calls</button>
            <button type="button" className={graphType === 'class_dependencies' ? styles.viewButtonActive : styles.viewButton} aria-pressed={graphType === 'class_dependencies'} onClick={() => { setGraphFocusKey(null); setJadxGraphType('class_dependencies') }}>Class dependencies</button>
          </div>}
          <Link className={styles.focusLink} href={standalone ? `/projects/${encodeURIComponent(projectId)}` : `/projects/${encodeURIComponent(projectId)}/visualizer`}>
            {standalone ? 'Back to workspace' : 'Open full visualizer'}
          </Link>
        </div>
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

      {currentRun && <div className={styles.progressCards}>
      <div className={styles.runSummary} aria-label="Selected analysis summary">
        <div className={styles.runSummaryHeading}>
          <div>
            <strong>{maintainedCoverageQuery.data?.decompilationCoveragePercent !== null && maintainedCoverageQuery.data?.decompilationCoveragePercent !== undefined
              ? `${maintainedCoverageQuery.data.decompilationCoveragePercent}% of measured code decompiled`
              : currentRun.linkPercent === null ? `${currentRun.indexedUnitCount.toLocaleString()} ${currentRun.unitLabel} indexed` : `${currentRun.linkPercent}% of analyzed ${currentRun.unitLabel} indexed`}</strong>
            <span>{maintainedCoverageQuery.data
              ? `${maintainedCoverageQuery.data.sourceLinkedPercent}% of code units have viewable source`
              : `${currentRun.indexedUnitCount.toLocaleString()} code units indexed${currentRun.discoveredUnitCount !== null ? ` of ${currentRun.discoveredUnitCount.toLocaleString()} analyzed ${currentRun.unitLabel}` : ''}`}</span>
          </div>
          <span>Code {formatBytes(maintainedCoverageQuery.data?.codeBytes ?? currentRun.codeBytes ?? units.reduce((sum, unit) => sum + unit.sizeBytes, 0))}</span>
        </div>
        {(maintainedCoverageQuery.data?.decompilationCoveragePercent ?? currentRun.linkPercent) !== null && <div className={styles.runProgress} role="progressbar"
          aria-label={maintainedCoverageQuery.data?.decompilationCoveragePercent !== null && maintainedCoverageQuery.data?.decompilationCoveragePercent !== undefined ? 'Decompilation coverage' : 'Indexed code unit coverage'}
          aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={maintainedCoverageQuery.data?.decompilationCoveragePercent ?? currentRun.linkPercent ?? 0}
          aria-valuetext={maintainedCoverageQuery.data?.decompilationCoveragePercent !== null && maintainedCoverageQuery.data?.decompilationCoveragePercent !== undefined
            ? `${maintainedCoverageQuery.data.decompilationCoveragePercent}% of measured code decompiled`
            : `${currentRun.linkPercent}% of analyzed ${currentRun.unitLabel} indexed`}>
          <span style={{ width: `${maintainedCoverageQuery.data?.decompilationCoveragePercent ?? currentRun.linkPercent ?? 0}%` }} />
        </div>}
        {(currentRun.truncated || (currentRun.failedUnitCount !== null && currentRun.failedUnitCount > 0)) && <div className={styles.runSummaryMeta}>
          {currentRun.truncated && <span>{currentRun.linkPercent === null ? 'Partial index; the analyzer could not determine the total class count.' : 'Partial index. This bar shows indexed coverage, not whether the task finished.'}</span>}
          {currentRun.truncated && decompilationHref && <a className={styles.runAgain} href={decompilationHref}>Run decompilation again</a>}
          {currentRun.failedUnitCount !== null && currentRun.failedUnitCount > 0 && <span>{currentRun.failedUnitCount.toLocaleString()} functions could not be decompiled{currentRun.visitedUnitCount !== null ? ` of ${currentRun.visitedUnitCount.toLocaleString()} visited` : ''}</span>}
        </div>}
        {displayRunWarnings && <p className={styles.runWarning}>{displayRunWarnings}</p>}
      </div>

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
          <input value={filter} maxLength={300} onChange={(event) => setFilter(event.target.value)} placeholder="Search by name, address, path, or referenced string · >10kb · <70%" />
        </label>
        <p className={styles.message}>Name, address, and path search spans the full run. Language, size, decompilation, and work-status filters apply to code units loaded here.</p>
      {(visualizerView === 'function-map' || visualizerView === 'treemap') && <div className={styles.visualizerToolbar}>
          {availableLanguages.length > 1 && <label className={styles.languageFilter}>Language
            <select aria-label="Filter map by language" value={activeLanguageFilter} onChange={(event) => { setLanguageFilter(event.target.value); setFolderPath([]) }}>
              <option value="">All languages</option>
              {availableLanguages.map((language) => <option key={language} value={language}>{language}</option>)}
            </select>
          </label>}
          {currentRun?.apktoolProjectAvailable && <>
            <button type="button" className={styles.runButton} onClick={() => void rebuildAndroidApk()} disabled={buildingApk}>
              <Download size={14} /> {buildingApk ? 'Building unsigned APK…' : 'Rebuild unsigned APK'}
            </button>
            {apkBuild?.taskId === currentRun.id && <a className={styles.runButton} href={apkBuild.downloadUrl}>
              Download unsigned APK · {apkBuild.changedFileCount} saved resource / Smali {apkBuild.changedFileCount === 1 ? 'change' : 'changes'} · {formatBytes(apkBuild.sizeBytes)}
            </a>}
            {apkBuild?.taskId === currentRun.id && apkBuild.warnings && <p className={styles.message}>{apkBuild.warnings}</p>}
            {apkBuildError && <p className={styles.error} role="alert">{apkBuildError}</p>}
          </>}
          <div className={styles.maintenanceFilters} role="group" aria-label="Maintained source status">
            <span>Work status</span>
            <button type="button" className={maintenanceFilter === 'all' ? styles.viewButtonActive : styles.viewButton} aria-pressed={maintenanceFilter === 'all'} onClick={() => showMaintenanceFilter('all')}>All ({mapScopeUnits.length.toLocaleString()})</button>
            <button type="button" className={maintenanceFilter === 'needs-work' ? styles.viewButtonActive : styles.viewButton} aria-pressed={maintenanceFilter === 'needs-work'} onClick={() => showMaintenanceFilter('needs-work')}>Needs work ({mapScopeUnits.filter((unit) => !unit.maintainedSource).length.toLocaleString()})</button>
            <button type="button" className={maintenanceFilter === 'drafted' ? styles.viewButtonActive : styles.viewButton} aria-pressed={maintenanceFilter === 'drafted'} onClick={() => showMaintenanceFilter('drafted')}>Draft saved ({mapScopeUnits.filter((unit) => unit.draftSource).length.toLocaleString()})</button>
            <button type="button" className={maintenanceFilter === 'maintained' ? styles.viewButtonActive : styles.viewButton} aria-pressed={maintenanceFilter === 'maintained'} onClick={() => showMaintenanceFilter('maintained')}>Maintained ({mapScopeUnits.filter((unit) => unit.maintainedSource).length.toLocaleString()})</button>
          </div>
          <div className={styles.maintenanceFilters} role="group" aria-label="Treemap color layer">
            <span>Color by</span>
            <button type="button" className={mapLayer === 'decompilation' ? styles.viewButtonActive : styles.viewButton} aria-pressed={mapLayer === 'decompilation'} onClick={() => setMapLayer('decompilation')}>Decompilation</button>
            <button type="button" className={mapLayer === 'maintenance' ? styles.viewButtonActive : styles.viewButton} aria-pressed={mapLayer === 'maintenance'} onClick={() => setMapLayer('maintenance')}>Maintained source</button>
            <button type="button" className={mapLayer === 'work' ? styles.viewButtonActive : styles.viewButton} aria-pressed={mapLayer === 'work'} onClick={() => setMapLayer('work')}>Work status</button>
          </div>
          {visualizerView === 'treemap' && <div className={styles.mapContentSwitcher} role="group" aria-label="Treemap contents">
            <button type="button" className={mapContent === 'units' ? styles.viewButtonActive : styles.viewButton} aria-pressed={mapContent === 'units'} onClick={() => setMapContentPreference('units')}>Code units</button>
            <button type="button" className={mapContent === 'folders' ? styles.viewButtonActive : styles.viewButton} aria-pressed={mapContent === 'folders'} onClick={() => setMapContentPreference('folders')}>Folders</button>
          </div>}
          {currentRun && <a className={styles.runButton} href={`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/export?taskId=${encodeURIComponent(currentRun.id)}`}>
            Download source bundle · {currentRun.codeUnitCount.toLocaleString()} code {currentRun.codeUnitCount === 1 ? 'unit' : 'units'}
          </a>}
        </div>}
        {currentRun?.apktoolProjectAvailable && (visualizerView === 'function-map' || visualizerView === 'treemap') && <p className={styles.functionMapNote}>
          APK rebuilds apply saved Android resource and Smali edits to the retained Apktool project. Maintained JADX Java stays separate because it is not compiled back into DEX; the rebuilt APK is unsigned.
        </p>}
        {(visualizerView === 'function-map' || visualizerView === 'treemap') && nextCursor && <div className={styles.loadMore} role="group" aria-label="Map code unit loading">
          <span role="status">Loaded {units.length.toLocaleString()} of {query.data?.total.toLocaleString() || '0'} code units</span>
          <button type="button" className={styles.runButton} onClick={() => void loadMoreUnits()} disabled={loadingMore}>
            {loadingMore ? 'Loading code units…' : 'Load more code units'}
          </button>
          <button type="button" className={styles.runButton} onClick={() => void loadMoreUnits(true)} disabled={loadingMore}>
            {loadingMore ? 'Loading full map…' : `Load all ${Math.max(0, (query.data?.total || 0) - units.length).toLocaleString()} remaining`}
          </button>
          {loadMoreError && <p className={styles.error} role="alert">{loadMoreError}</p>}
        </div>}
      </>}

      {!query.isLoading && !query.isError && query.data && units.length > 0 && <>
        <div className={styles.stats}>
          <div><strong>{folderUnits.length.toLocaleString()}</strong><span>Code units in this map</span></div>
          <div><strong>{summary.sourceLinkedPercent === null ? 'Unknown' : `${summary.sourceLinkedPercent}%`}</strong><span>Viewable source links in map ({summary.sourceLinkedUnits.toLocaleString()}/{folderUnits.length.toLocaleString()})</span></div>
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
        </div> : mapLayer === 'maintenance' ? <div className={styles.legend} role="group" aria-label="Maintained source legend">
          <span><i className={styles.complete} /> Maintained source saved</span>
          <span><i className={styles.unknown} /> Not yet maintained</span>
          <span><i className={styles.partial} /> Folder with maintained source</span>
        </div> : <div className={styles.legend} role="group" aria-label="Reverse-engineering work status legend">
          <span><i className={styles.unknown} /> Needs work</span>
          <span><i className={styles.draftLegend}>D</i> Draft saved for review</span>
          <span><i className={styles.complete} /> Maintained source saved</span>
        </div>}

        <div className={`${styles.workbench} ${selectedUnit && visualizerView !== 'callgraph' ? '' : styles.workbenchMapOnly}`}>
        <div className={styles.mapColumn} aria-label="Program map and relationships">
        {(visualizerView === 'function-map' || visualizerView === 'treemap') && ((visualizerView === 'function-map' ? folderUnits.length : treemapEntries.length) ? <div className={styles.mapFrame}>
          {visualizerView === 'treemap' && folderPath.length > 0 && <nav className={styles.folderPath} aria-label="Program source path">
            <button type="button" onClick={() => showFolder([])}>All folders</button>
            {folderPath.map((part, index, parts) => {
              const path = parts.slice(0, index + 1)
              const key = JSON.stringify(path)
              return <span key={key}><span aria-hidden="true">/</span><button type="button" aria-current={index === parts.length - 1 ? 'page' : undefined} onClick={() => showFolder(path)}>{part}</button></span>
            })}
          </nav>}
          {visualizerView === 'function-map' ? <>
          <div className={styles.functionMap} role="group" aria-label="Language-neutral functions and code units map">
            {folderUnits.map((unit) => {
              const fill = mapLayer === 'decompilation'
                ? unitColor(unit.coveragePercent)
                : mapLayer === 'maintenance'
                  ? maintenanceColor(unit.maintainedSource ? 1 : 0, 1)
                  : workStatusColor(unit.draftSource ? 1 : 0, unit.maintainedSource ? 1 : 0, 1)
              const coverage = unit.coveragePercent === null ? 'Unmeasured' : `${Math.round(unit.coveragePercent)}% decompiled`
              const work = unit.maintainedSource ? 'Maintained source saved' : unit.draftSource ? 'Draft saved for review' : 'Needs reverse engineering'
              const meta = [languageLabel(unit), unit.address, formatBytes(unit.sizeBytes)].filter(Boolean).join(' · ')
              return <button
                key={unit.id}
                type="button"
                className={styles.functionTile}
                style={{ '--function-color': fill } as CSSProperties}
                data-layer={mapLayer}
                aria-pressed={unit.id === selectedId}
                aria-label={`${unit.name}, ${coverage}, ${work}${meta ? `, ${meta}` : ''}`}
                title={`${unit.name} · ${coverage} · ${work}${meta ? ` · ${meta}` : ''}`}
                onClick={() => {
                  setSelectedFunctionMapMember(null)
                  openTreemapEntry({ key: `unit:${unit.id}`, name: unit.name, sizeBytes: unit.sizeBytes, coveragePercent: unit.coveragePercent, codeUnit: unit, unitCount: 1, maintainedUnitCount: unit.maintainedSource ? 1 : 0, draftedUnitCount: unit.draftSource ? 1 : 0 })
                }}
              >
                <strong>{unit.name}</strong>
                <span>{meta || unit.unitType}</span>
                <small>{coverage} · {work}</small>
              </button>
            })}
            {visibleFunctionMapMembers.map((member) => {
              const parent = member.parentCodeUnit
              const fill = mapLayer === 'decompilation'
                ? unitColor(parent.coveragePercent)
                : mapLayer === 'maintenance'
                  ? maintenanceColor(parent.maintainedSource ? 1 : 0, 1)
                  : workStatusColor(parent.draftSource ? 1 : 0, parent.maintainedSource ? 1 : 0, 1)
              const coverage = parent.coveragePercent === null ? 'Unmeasured' : `${Math.round(parent.coveragePercent)}% parent coverage`
              const work = parent.maintainedSource ? 'Maintained file' : parent.draftSource ? 'Draft saved for review' : 'Needs reverse engineering'
              const meta = [parent.name, member.language, member.address || (member.line ? `line ${member.line}` : null)].filter(Boolean).join(' · ')
              return <button
                key={`function:${member.id}`}
                type="button"
                className={styles.functionTile}
                style={{ '--function-color': fill } as CSSProperties}
                data-layer={mapLayer}
                aria-pressed={selectedFunctionMapMember?.id === member.id}
                aria-label={`${member.name}, ${member.memberKind} in ${parent.name}, ${coverage}, ${work}${meta ? `, ${meta}` : ''}`}
                title={`${member.fullName} · ${coverage} · ${work}`}
                onClick={() => {
                  openTreemapEntry({ key: `unit:${parent.id}`, name: parent.name, sizeBytes: parent.sizeBytes, coveragePercent: parent.coveragePercent, codeUnit: parent, unitCount: 1, maintainedUnitCount: parent.maintainedSource ? 1 : 0, draftedUnitCount: parent.draftSource ? 1 : 0 })
                  setSelectedFunctionMapMember({ id: member.id, parentUnitId: parent.id, name: member.name.replace(/#\d+$/, ''), similarityAvailable: member.similarityAvailable })
                }}
              >
                <strong>{member.name}</strong>
                <span>{meta || member.memberKind}</span>
                <small>{coverage} · {work} · {member.memberKind}</small>
              </button>
            })}
          </div>
          {visibleFunctionMapMembers.length > 0 && <p className={styles.functionMapNote} role="status">{visibleFunctionMapMembers.length.toLocaleString()} function or method entries from the loaded code units. Status reflects the containing source file; select an entry to open it and filter the member outline.</p>}
          {functionMapTruncated && <p className={styles.functionMapNote} role="status">The function map reached its 20,000-entry display limit. Load or search a smaller code-unit page to explore more.</p>}
          </> : <svg className={styles.map} viewBox="0 0 1200 560" role="group" aria-label={`${mapContent === 'folders' ? 'Folder and code unit' : 'Code unit'} treemap sized by bytes and colored by ${mapLayer === 'decompilation' ? 'decompilation completeness' : mapLayer === 'maintenance' ? 'maintained source coverage' : 'reverse-engineering work status'}`}>
            {rectangles.map(({ unit, x, y, width, height }) => {
              const label = shortenLabel(unit.name, width)
              const coverage = unit.coveragePercent === null ? 'decompilation completeness unmeasured' : `${Math.round(unit.coveragePercent)}% decompilation completeness`
              const detail = unit.folderPath ? `${unit.unitCount.toLocaleString()} code units` : formatBytes(unit.sizeBytes)
              const maintained = unit.maintainedUnitCount > 0
              const drafted = unit.draftedUnitCount > 0
              const maintainedDetail = unit.folderPath
                ? `${unit.maintainedUnitCount} of ${unit.unitCount} units have maintained source`
                : unit.codeUnit?.maintainedSource ? 'maintained source saved' : 'not yet reverse-engineered into maintained source'
              const workDetail = unit.folderPath
                ? `${unit.draftedUnitCount} drafts · ${unit.maintainedUnitCount} maintained of ${unit.unitCount} units`
                : unit.codeUnit?.draftSource ? 'saved draft waiting for review' : unit.codeUnit?.maintainedSource ? 'maintained source saved' : 'no saved draft or maintained source'
              const fill = mapLayer === 'decompilation'
                ? unitColor(unit.coveragePercent)
                : mapLayer === 'maintenance'
                  ? maintenanceColor(unit.maintainedUnitCount, unit.unitCount)
                  : workStatusColor(unit.draftedUnitCount, unit.maintainedUnitCount, unit.unitCount)
              const showDraftBadge = mapLayer === 'work' && drafted && width >= 28 && height >= 24
              return <g
                key={unit.key}
                className={`${styles.tile} ${unit.codeUnit?.id === selectedId ? styles.selected : ''} ${unit.folderPath ? styles.folderTile : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`${unit.name}${unit.folderPath ? ' folder' : ''}, ${formatBytes(unit.sizeBytes)}, ${coverage}${unit.folderPath ? `, ${unit.unitCount.toLocaleString()} code units` : unit.codeUnit?.address ? `, address ${unit.codeUnit.address}` : ''}, ${maintainedDetail}, ${workDetail}`}
                onClick={() => openTreemapEntry(unit)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openTreemapEntry(unit)
                  }
                }}
              >
                <title>{`${unit.name}${unit.folderPath ? ' folder' : ''} · ${formatBytes(unit.sizeBytes)} · ${coverage}${unit.folderPath ? ` · ${unit.unitCount.toLocaleString()} code units` : unit.codeUnit?.address ? ` · ${unit.codeUnit.address}` : ''} · ${maintainedDetail} · ${workDetail}`}</title>
                <rect x={x + 1} y={y + 1} width={Math.max(0, width - 2)} height={Math.max(0, height - 2)} fill={fill} rx="3" />
                {maintained && width >= 28 && height >= 24 && <><circle className={styles.maintainedBadge} cx={x + width - (showDraftBadge ? 34 : 13)} cy={y + 13} r="9" /><text className={styles.maintainedBadgeText} x={x + width - (showDraftBadge ? 34 : 13)} y={y + 13}>M</text></>}
                {showDraftBadge && <><circle className={styles.draftBadge} cx={x + width - 13} cy={y + 13} r="9" /><text className={styles.maintainedBadgeText} x={x + width - 13} y={y + 13}>D</text></>}
                {label && <text x={x + 9} y={y + 20} className={styles.tileName}>{label}</text>}
                {label && width > 115 && height > 48 && <text x={x + 9} y={y + 38} className={styles.tileMeta}>{detail}</text>}
              </g>
            })}
          </svg>}
        </div> : <p className={styles.noMatches}>{maintenanceFilter === 'all' ? 'No code units match this filter.' : maintenanceFilter === 'drafted' ? 'No code units have a saved draft in the current map.' : 'No code units match this work status in the current map.'}</p>)}

        {visualizerView === 'callgraph' && <section className={styles.callGraph} aria-labelledby="run-call-graph-heading">
          <div className={styles.callGraphHeader}>
            <div><h3 id="run-call-graph-heading">{graphType === 'class_dependencies' ? 'Program class dependencies' : 'Program call graph'}</h3><p>{graphType === 'class_dependencies' ? 'Classes connected by references found in Android bytecode. Select a class to open its decompiled source.' : 'Functions and direct calls recorded by the analyzer. Drag to arrange, scroll to zoom, or select a function to open its code.'}</p></div>
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
          {!runCallGraphQuery.isLoading && !runCallGraphQuery.isError && runCallGraphQuery.data && runCallGraphQuery.data.nodes.length === 0 && <p className={styles.message}>{graphType === 'class_dependencies' ? 'This JADX run did not record any class references.' : 'This run did not record any function calls.'}</p>}
          {!runCallGraphQuery.isLoading && !runCallGraphQuery.isError && runCallGraphQuery.data && runCallGraphQuery.data.nodes.length > 0 && <WorkspaceCallGraphCanvas
            nodes={runCallGraphQuery.data.nodes as CallGraphRecord[]}
            edges={runCallGraphQuery.data.edges as CallGraphRelationship[]}
            focusKey={graphFocus?.key || runCallGraphQuery.data.focusKey}
            graphType={runCallGraphQuery.data.graphType || graphType}
            onSelectNode={selectGraphNode}
          />}
          {runCallGraphQuery.data?.truncated && <p className={styles.message}>{graphType === 'class_dependencies' ? 'Showing up to 400 class dependencies. Select a class to inspect its direct relationships.' : 'Showing the first 400 call relationships returned by the analyzer.'}</p>}
        </section>}

        {nextCursor && <p className={styles.message}>Showing {units.length.toLocaleString()} of {query.data.total.toLocaleString()} code units matching your search. Load more to include additional units in size and coverage filters.</p>}
        </div>

        <aside ref={unitInspectorRef} className={styles.unitInspector} aria-label="Selected code unit inspector">
        {!selectedUnit && <div className={styles.inspectorEmpty}><strong>Select a code unit to inspect its source.</strong><span>Choose a tile from the map or search by class, function, address, path, or referenced string.</span></div>}
        {selectedUnit && <div className={styles.details}>
          <div className={styles.detailsHeading}>
            <div><span className={styles.detailLabel}>{selectedUnit.unitType === 'resource' ? 'Selected Android resource' : 'Selected code unit'}</span><strong>{selectedUnit.name}</strong>{selectedUnit.maintainedSource && <span className={styles.savedStatus}>Maintained source saved</span>}</div>
          {explanationProviders.length > 0 && !largeSource && <button type="button" className={styles.explainButton} onClick={() => void deobfuscateSelectedUnit()} disabled={!selectedProviderId || transforming || sourceQuery.isError || sourceQuery.isLoading || maintainedQuery.isLoading}>
              {transforming ? 'Reverse engineering…' : 'Create maintainable version'}
            </button>}
          </div>
        {selectedUnit && selectedSourceUrl && <section className={styles.sourcePanel} aria-label={selectedUnit.unitType === 'resource' ? 'Decoded Android resource' : selectedDisassemblyUrl ? 'Decompilation and disassembly comparison' : (selectedUnit.language === 'WebAssembly Text (WAT)' ? 'WAT disassembly' : isDisassemblyUnit(selectedUnit) ? 'Smali disassembly' : 'Decompiled source')}>
          {selectedDisassemblyUrl ? <div className={styles.comparison}>
            <div className={styles.listingPane}>
              <div className={styles.sourceHeader}>
                <div><strong>Decompiled source</strong><span>{languageLabel(selectedUnit)} · {selectedUnit.codeArtifactId?.split('/').pop()}</span></div>
                <button type="button" className={styles.copyButton} onClick={() => void copySource()} disabled={!sourceQuery.data}><Copy size={14} /> {copyStatus || 'Copy source'}</button>
              </div>
              {sourceQuery.isLoading && <p className={styles.message}>Loading decompiled source…</p>}
              {sourceQuery.isError && <p className={styles.error}>{sourceQuery.error instanceof Error ? sourceQuery.error.message : 'Could not load decompiled source'}</p>}
              {sourceQuery.data !== undefined && <SourceListing source={sourceQuery.data} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} fullSourceUrl={selectedSourceUrl} />}
            </div>
            <div className={styles.listingPane}>
              <div className={styles.sourceHeader}>
                <div><strong>{selectedUnit.disassemblyLanguage || 'Disassembly'}</strong><span>{selectedUnit.address || 'Function listing'} · {selectedUnit.disassemblyArtifactId?.split('/').pop()}</span></div>
                <button type="button" className={styles.copyButton} onClick={() => void copySource(disassemblyQuery.data, true)} disabled={!disassemblyQuery.data}><Copy size={14} /> {assemblyCopyStatus || 'Copy assembly'}</button>
              </div>
              {disassemblyQuery.isLoading && <p className={styles.message}>Loading instruction listing…</p>}
              {disassemblyQuery.isError && <p className={styles.error}>{disassemblyQuery.error instanceof Error ? disassemblyQuery.error.message : 'Could not load instruction listing'}</p>}
              {disassemblyQuery.data !== undefined && <SourceListing source={disassemblyQuery.data} language={selectedUnit.disassemblyLanguage} fileName={selectedUnit.disassemblyArtifactId?.split('/').pop()} fullSourceUrl={selectedDisassemblyUrl} />}
              {selectedUnit.disassemblyLanguage?.toLowerCase() === 'smali' && <div className={styles.smaliEditor}>
                <label>Editable Smali source
                  <textarea aria-label="Editable Smali source" value={smaliDraft} spellCheck={false} onChange={(event) => { setSmaliDraft(event.target.value); setSmaliSaved(false); setSmaliError('') }} />
                </label>
                <div className={styles.maintainedActions}>
                  <button type="button" className={styles.explainButton} onClick={() => void saveSmaliSource()} disabled={savingSmali || !smaliDraft.trim() || (smaliSaved && smaliDraft === smaliSourceQuery.data?.sourceCode)}>{savingSmali ? 'Saving Smali…' : smaliSaved ? 'Save Smali changes' : 'Save Smali to project'}</button>
                  {smaliSaved && <span className={styles.savedStatus} role="status">Smali saved to project memory and included in APK rebuilds</span>}
                </div>
                {smaliSourceQuery.isLoading && <p className={styles.message}>Loading saved Smali source…</p>}
                {(smaliError || smaliSourceQuery.isError) && <p className={styles.error} role="alert">{smaliError || (smaliSourceQuery.error instanceof Error ? smaliSourceQuery.error.message : 'Could not load Smali source')}</p>}
              </div>}
            </div>
          </div> : <>
            <div className={styles.sourceHeader}>
              <div><strong>{selectedUnit.unitType === 'resource' ? 'Decoded resource' : selectedUnit.name}</strong><span>{languageLabel(selectedUnit)} · {selectedUnit.bundlePath || selectedUnit.codeArtifactId?.split('/').pop()}</span></div>
              <button type="button" className={styles.copyButton} onClick={() => void copySource()} disabled={!sourceQuery.data}><Copy size={14} /> {copyStatus || 'Copy code'}</button>
            </div>
            {sourceQuery.isLoading && <p className={styles.message}>Loading code output…</p>}
            {sourceQuery.isError && <p className={styles.error}>{sourceQuery.error instanceof Error ? sourceQuery.error.message : 'Could not load code output'}</p>}
            {sourceQuery.data !== undefined && <SourceListing source={sourceQuery.data} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} fullSourceUrl={selectedSourceUrl} />}
          </>}
        </section>}
          <dl>
            <div><dt>Address</dt><dd>{selectedUnit.address || 'Not supplied'}</dd></div>
            <div><dt>Size</dt><dd>{formatBytes(selectedUnit.sizeBytes)}</dd></div>
            <div><dt>Decompiler output</dt><dd>{selectedUnit.sourceLanguage && selectedUnit.language === 'C' ? 'C-like pseudocode' : selectedUnit.language || 'Not identified'}</dd></div>
            {selectedUnit.sourceLanguage && <div><dt>Binary source language</dt><dd>{selectedUnit.sourceLanguage} (metadata)</dd></div>}
            <div><dt>Unit type</dt><dd>{selectedUnit.unitType || 'Code unit'}</dd></div>
            {selectedUnit.bundlePath && <div><dt>Bundle module</dt><dd>{selectedUnit.bundlePath}</dd></div>}
            <div><dt>Artifact</dt><dd>{selectedUnit.artifactPath || 'Not linked'}</dd></div>
            <div><dt>Provider</dt><dd>{selectedUnit.source}</dd></div>
          </dl>
          {(selectedUnit.classReferences?.length ?? 0) > 0 && <section className={styles.classReferences} aria-label="Related classes">
            <div><strong>Related classes</strong><span>From Android bytecode references</span></div>
            <ul>{selectedUnit.classReferences?.slice(0, 24).map((name) => <li key={name}>
              <button type="button" onClick={() => { setFilter(name); setSelectedId(null); setGraphUnit(null); setFolderPath([]) }} title={`Find ${name} in this run`}>{name}</button>
            </li>)}</ul>
            {(selectedUnit.classReferences?.length ?? 0) > 24 && <small>Showing 24 of {selectedUnit.classReferences?.length} references.</small>}
          </section>}
          {(selectedUnit.referencedStrings?.length ?? 0) > 0 && <section className={styles.classReferences} aria-label="Strings referenced by this function">
            <div><strong>Referenced strings</strong><span>Data references recovered by Ghidra from this function</span></div>
            <ul>{selectedUnit.referencedStrings?.slice(0, 12).map((value, index) => <li key={`${index}:${value}`}><code>{value}</code></li>)}</ul>
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
        {(visualizerView === 'treemap' || visualizerView === 'function-map') && currentRun?.providerId === selectedUnit?.source && selectedUnit?.unitType === 'function' && <CallGraphPanel
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
        {(currentRun?.providerId === 'reamon-ghidra' || currentRun?.providerId === 'reamon-wabt' || currentRun?.providerId === 'reamon-jadx' || currentRun?.providerId === 'reamon-ilspy')
          && selectedUnit?.source === currentRun.providerId && Boolean(selectedSimilarityTarget) && <section className={styles.similarFunctions} aria-labelledby="similar-functions-heading">
          <div className={styles.similarFunctionsHeading}><h3 id="similar-functions-heading">Similar instruction patterns</h3><span>Same project · compatible instruction set</span></div>
          {similarFunctionsQuery.isLoading && <p className={styles.message}>Comparing this function with stored instruction sequences from completed analyses…</p>}
          {similarFunctionsQuery.isError && <p className={styles.error}>{similarFunctionsQuery.error instanceof Error ? similarFunctionsQuery.error.message : 'Unable to find similar functions'}</p>}
          {!similarFunctionsQuery.isLoading && !similarFunctionsQuery.isError && similarFunctionsQuery.data?.matches.length === 0 && <p className={styles.message}>No close instruction-pattern matches were found in this project.</p>}
          {similarFunctionsQuery.data?.matches.map(({ codeUnit, similarity, artifact }) => <button type="button" className={styles.similarFunction} key={codeUnit.id} onClick={() => {
            setGraphUnit(codeUnit)
            setSelectedId(codeUnit.id)
            setSelectedFunctionMapMember(null)
            setCopyStatus('')
            setAssemblyCopyStatus('')
            setExplanation(null)
            setExplainError('')
          }}>
            <span><strong>{codeUnit.name}</strong><small>{codeUnit.address || codeUnit.artifactPath || 'Function'}</small><small>{artifact.name}{artifact.sha256 ? ` · ${artifact.sha256.slice(0, 12)}` : ''}</small></span>
            <b>{similarity}%</b>
          </button>)}
          {similarFunctionsQuery.data?.truncated && <p className={styles.message}>The comparison reached its history limit; older stored function observations may not have been included.</p>}
        </section>}
        </aside>
        </div>

        {selectedUnit && selectedSourceUrl && <section className={styles.maintainPanel} aria-labelledby="code-maintain-heading">
          <div>
            <h3 id="code-maintain-heading"><WandSparkles size={16} /> Reverse engineer into maintainable code</h3>
            <p>Use decompiled source, related classes, bytecode, and project memory to recover intent and keep names consistent. AI drafts are stored with this project for follow-up work; review and save a maintained copy before its names become trusted project-wide evidence. The original decompilation stays intact.</p>
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
          </>}
          {largeSource && !memberOutlineEligible && <p className={styles.message}>This source exceeds the single request limit, and function-level rewriting is unavailable for this code unit.</p>}
          {memberOutlineEligible && sourceByteLength !== null && sourceByteLength > MAX_MEMBER_OUTLINE_BYTES && <p className={styles.message}>Function and method outlining is limited to source files of 2 MiB or less.</p>}
          {memberOutlineAvailable && <section className={styles.classReferences} aria-label="Function and method outline">
            <div><strong>Reverse engineer one function or method at a time</strong><span>Each rewrite replaces only the selected function or method in the editable copy, so you can use a smaller change even when the full source fits in one request.</span></div>
            {memberOutlineQuery.isLoading && <p className={styles.message}>Reading function and method outline…</p>}
            {memberOutlineQuery.isError && <p className={styles.error} role="alert">{memberOutlineQuery.error instanceof Error ? memberOutlineQuery.error.message : 'Could not read the function and method outline'}</p>}
            {memberOutlineQuery.data && <>
              <label className={styles.explainField}>Find a function or method
                <input value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)} placeholder="Filter by function or method name" />
              </label>
              {memberOutlineQuery.data.unsupported && <p className={styles.message}>No Tree-sitter grammar is available for {selectedUnit?.language || 'this source'} yet. File-level reverse engineering is still available.</p>}
              {!memberOutlineQuery.data.unsupported && memberOutlineQuery.data.members.length === 0 && <p className={styles.message}>No functions or methods with bodies were found in this source.</p>}
              {memberOutlineQuery.data.members.length > 0 && filteredMembers.length === 0 && <p className={styles.message}>No functions or methods match this filter.</p>}
              <ul>{filteredMembers.map((member) => {
                const key = `${member.start_byte}:${member.end_byte}`
                const tooLarge = member.source_bytes > MAX_MEMBER_REWRITE_BYTES
                return <li key={key}>
                  <button type="button" className={styles.copyButton} onClick={() => void deobfuscateMember(member)} disabled={!selectedProviderId || transforming || tooLarge || rewrittenMembers.has(key) || sourceQuery.isError} title={tooLarge ? 'This function or method exceeds the single request limit' : undefined}>
                    {member.kind} {member.name} · line {member.line} · {formatBytes(member.source_bytes)}{rewrittenMembers.has(key) ? ' · rewritten' : tooLarge ? ' · too large' : ''}
                  </button>
                </li>
              })}</ul>
              {memberOutlineQuery.data.members.length > filteredMembers.length && <p className={styles.message}>Showing {filteredMembers.length} functions or methods. Filter the list to find others.</p>}
              {memberOutlineQuery.data.truncated && <p className={styles.message}>The outline reached its 10,000 member limit; some functions or methods may not be listed.</p>}
            </>}
          </section>}
          {maintenanceError && <p className={styles.error} role="alert">{maintenanceError}</p>}
          {maintenanceMeta && <p className={styles.message}>Reverse-engineered draft from {maintenanceMeta.providerName} · {maintenanceMeta.model}. {maintenanceMeta.syntaxValidated === true ? 'The source parser found no syntax errors. Review the reconstructed logic and behavior before saving.' : maintenanceMeta.syntaxValidated === false ? 'Syntax validation was unavailable for this language. Check the reconstructed code and its behavior before saving.' : 'This draft has changed or predates saved validation metadata. Recheck its syntax and behavior before saving.'}</p>}
          {(codeDraftQuery.data?.attempts?.length ?? 0) > 0 && <section className={styles.attemptHistory} aria-label="Recent AI rewrite attempts">
            <h4>Recent AI attempts for this source version</h4>
            <ol>{codeDraftQuery.data?.attempts?.map((attempt) => <li key={attempt.id}>
              <details>
                <summary>
                  <strong>{attempt.status === 'SUCCEEDED' ? 'Completed' : attempt.status === 'FAILED' ? 'Failed' : 'Interrupted or still running'}</strong>
                  <span>{attempt.providerName} · {attempt.modelIdentifier} · {attempt.scope} · {new Date(attempt.createdAt).toLocaleString()}</span>
                </summary>
                {attempt.question && <p>Request: {attempt.question}</p>}
                {attempt.status === 'SUCCEEDED' && <p>{attempt.syntaxValidated === true ? 'The source parser found no syntax errors.' : 'Syntax validation was unavailable for this language; review the source and behavior.'}</p>}
                {attempt.errorMessage && <p className={styles.error}>{attempt.errorMessage}{attempt.errorCode ? ` (${attempt.errorCode})` : ''}</p>}
                {attempt.resultSource && <pre className={styles.attemptSource}><code>{attempt.resultSource}</code></pre>}
              </details>
            </li>)}</ol>
          </section>}
          {maintainedQuery.isError && <p className={styles.error} role="alert">{maintainedQuery.error instanceof Error ? maintainedQuery.error.message : 'Could not load maintained source'}</p>}
          {codeDraftQuery.isError && <p className={styles.error} role="alert">{codeDraftQuery.error instanceof Error ? codeDraftQuery.error.message : 'Could not load the saved AI draft'}</p>}
          {maintainedDraft && <>
            <div className={styles.maintainedComparison}>
              <div><strong>Original decompilation</strong>
                {sourceQuery.data !== undefined && <SourceListing source={sourceQuery.data} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} fullSourceUrl={selectedSourceUrl} />}
              </div>
              <label>Editable maintained copy
              <textarea ref={maintainedEditorRef} aria-label="Editable maintained source" value={maintainedDraft} spellCheck={false} onChange={(event) => { setMaintainedDraft(event.target.value); setMaintainedSaved(false); setMaintenanceMeta((current) => current ? { ...current, syntaxValidated: null } : current) }} />
              </label>
            </div>
            <div className={styles.maintainedActions}>
              <button type="button" className={styles.copyButton} onClick={() => void saveCodeDraft()} disabled={savingDraft || !maintainedDraft.trim() || !maintainedDraftDiffersFromSource || maintainedDraft === draftSource}>{savingDraft ? 'Saving draft…' : maintainedDraft === draftSource ? 'Draft saved to project memory' : 'Save draft'}</button>
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
      <button type="button" className={styles.refresh} onClick={() => void refreshMap()} disabled={query.isFetching}>
        <RefreshCw size={14} className={query.isFetching ? styles.spin : undefined} /> {query.isFetching ? 'Refreshing…' : 'Refresh map'}
      </button>
    </section>
  )
}
