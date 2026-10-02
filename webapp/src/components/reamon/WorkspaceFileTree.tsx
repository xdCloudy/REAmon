'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, File, Folder, Search } from 'lucide-react'
import type { CapabilityMatch, TargetProfile } from '@/lib/reamon'
import styles from './WorkspaceFileTree.module.css'

interface WorkspaceArtifact {
  id: string
  originalName: string
  relativePath: string
  sizeBytes: number
  sha256: string
  mimeType: string
  status: string
  profile: TargetProfile
  capabilities: CapabilityMatch[]
  updatedAt: string
}

interface WorkspaceArtifactDetails {
  tasks: Array<{ id: string; title: string; status: string; progress: number }>
  findings: Array<{ id: string; title: string; severity: string; status: string }>
  hypotheses: Array<{ id: string; statement: string; status: string }>
  evidence: Array<{ id: string; summary: string; source: string }>
}

interface TreeNode {
  name: string
  path: string
  directory: boolean
  children: Map<string, TreeNode>
  artifact?: WorkspaceArtifact
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function profileLabel(profile: TargetProfile): string {
  const details = [profile.format.toUpperCase()]
  if (profile.architecture) details.push(profile.architecture)
  if (profile.platform) details.push(profile.platform)
  return details.join(' · ')
}

function buildTree(artifacts: WorkspaceArtifact[]): TreeNode {
  const root: TreeNode = { name: '', path: '', directory: true, children: new Map() }
  for (const artifact of artifacts) {
    const parts = artifact.relativePath.split('/').filter(Boolean)
    if (!parts.length) continue
    let cursor = root
    parts.forEach((part, index) => {
      const path = cursor.path ? `${cursor.path}/${part}` : part
      const isFile = index === parts.length - 1
      let child = cursor.children.get(part)
      if (!child) {
        child = { name: part, path, directory: !isFile, children: new Map() }
        cursor.children.set(part, child)
      }
      if (isFile && (!child.artifact || child.artifact.updatedAt < artifact.updatedAt)) child.artifact = artifact
      cursor = child
    })
  }
  return root
}

function filterTree(node: TreeNode, query: string): TreeNode | null {
  if (!query) return node
  const matches = node.path.toLowerCase().includes(query)
  const children = new Map<string, TreeNode>()
  for (const [name, child] of node.children) {
    const filtered = filterTree(child, query)
    if (filtered) children.set(name, filtered)
  }
  if (matches || children.size) return { ...node, children }
  return null
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

function TreeRows({
  node,
  depth,
  expanded,
  toggle,
  select,
  selectedId,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  select: (artifact: WorkspaceArtifact) => void
  selectedId: string | null
}) {
  return (
    <>
      {sortedChildren(node).map((child) => {
        const isExpanded = expanded.has(child.path)
        const artifact = child.artifact
        return (
          <div key={child.path}>
            <div className={`${styles.row} ${artifact?.id === selectedId ? styles.selected : ''}`} style={{ paddingLeft: `${depth * 18 + 8}px` }}>
              {child.directory ? (
                <button type="button" className={styles.expand} onClick={() => toggle(child.path)} aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${child.name}`}>
                  {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
              ) : <span className={styles.expandPlaceholder} />}
              {child.directory ? <Folder size={16} className={styles.folder} /> : <File size={16} className={styles.file} />}
              {child.directory ? <span className={styles.name}>{child.name}</span> : (
                <button type="button" className={styles.nameButton} onClick={() => artifact && select(artifact)} title={child.path}>{child.name}</button>
              )}
              {!child.directory && artifact && <>
                <span className={styles.profile}>{profileLabel(artifact.profile)}</span>
                <span className={styles.size}>{formatBytes(artifact.sizeBytes)}</span>
                <span className={`${styles.status} ${artifact.status === 'VERIFIED' ? styles.good : ''}`}>{artifact.status}</span>
                <span className={styles.capabilityDots} title={artifact.capabilities.map((match) => match.pluginName).join(', ') || 'No compatible capabilities'}>
                  {artifact.capabilities.slice(0, 3).map((match) => <i key={match.pluginId} />)}
                </span>
              </>}
            </div>
            {child.directory && isExpanded && <TreeRows node={child} depth={depth + 1} expanded={expanded} toggle={toggle} select={select} selectedId={selectedId} />}
          </div>
        )
      })}
    </>
  )
}

export function WorkspaceFileTree({ projectId, rootName, artifacts, totalArtifacts, hasMoreArtifacts }: {
  projectId: string
  rootName: string
  artifacts: WorkspaceArtifact[]
  totalArtifacts: number
  hasMoreArtifacts: boolean
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [selected, setSelected] = useState<WorkspaceArtifact | null>(null)
  const [details, setDetails] = useState<WorkspaceArtifactDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState(false)
  const [additionalArtifacts, setAdditionalArtifacts] = useState<WorkspaceArtifact[]>([])
  const [moreAvailable, setMoreAvailable] = useState(hasMoreArtifacts)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState(false)
  const [searchResults, setSearchResults] = useState<WorkspaceArtifact[] | null>(null)
  const [searchTotal, setSearchTotal] = useState(0)
  const [searchMoreAvailable, setSearchMoreAvailable] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const searchTerm = query.trim()
  const loadedArtifacts = useMemo(() => {
    const source = searchTerm ? searchResults || [] : [...artifacts, ...additionalArtifacts]
    const unique = new Map(source.map((artifact) => [artifact.id, artifact]))
    return [...unique.values()]
  }, [additionalArtifacts, artifacts, searchResults, searchTerm])
  const tree = useMemo(() => filterTree(buildTree(loadedArtifacts), searchTerm.toLowerCase()), [loadedArtifacts, searchTerm])

  useEffect(() => {
    setAdditionalArtifacts([])
    setMoreAvailable(hasMoreArtifacts)
    setLoadMoreError(false)
  }, [artifacts, hasMoreArtifacts])

  useEffect(() => {
    if (!searchTerm) {
      setSearchResults(null)
      setSearchTotal(0)
      setSearchMoreAvailable(false)
      setSearchLoading(false)
      setSearchError(false)
      return
    }
    const controller = new AbortController()
    setSearchResults(null)
    setSearchLoading(true)
    setSearchError(false)
    const loadSearch = async () => {
      try {
        const params = new URLSearchParams({ search: searchTerm, limit: '500' })
        const response = await fetch(`/api/projects/${projectId}/workspace/files?${params.toString()}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Unable to search workspace files')
        const result = await response.json() as { artifacts: WorkspaceArtifact[]; total: number; hasMore: boolean }
        setSearchResults(result.artifacts)
        setSearchTotal(result.total)
        setSearchMoreAvailable(result.hasMore)
      } catch {
        if (!controller.signal.aborted) setSearchError(true)
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false)
      }
    }
    void loadSearch()
    return () => controller.abort()
  }, [projectId, searchTerm])
  const selectedId = selected?.id

  useEffect(() => {
    if (!selectedId) {
      setDetails(null)
      setDetailsLoading(false)
      setDetailsError(false)
      return
    }
    const controller = new AbortController()
    setDetails(null)
    setDetailsLoading(true)
    setDetailsError(false)
    const loadDetails = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/workspace/files/${selectedId}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Unable to load artifact details')
        const nextDetails = await response.json() as WorkspaceArtifactDetails
        setDetails(nextDetails)
      } catch (error) {
        if (!controller.signal.aborted) setDetailsError(true)
      } finally {
        if (!controller.signal.aborted) setDetailsLoading(false)
      }
    }
    void loadDetails()
    return () => controller.abort()
  }, [projectId, selectedId])

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const loadMore = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    setLoadMoreError(false)
    try {
      const params = new URLSearchParams({ limit: '500', offset: String(loadedArtifacts.length) })
      if (searchTerm) params.set('search', searchTerm)
      const response = await fetch(`/api/projects/${projectId}/workspace/files?${params.toString()}`)
      if (!response.ok) throw new Error('Unable to load more workspace files')
      const result = await response.json() as { artifacts: WorkspaceArtifact[]; total: number; hasMore: boolean }
      if (searchTerm) {
        setSearchResults((current) => [...(current || []), ...result.artifacts])
        setSearchTotal(result.total)
        setSearchMoreAvailable(result.hasMore)
      } else {
        setAdditionalArtifacts((current) => [...current, ...result.artifacts])
        setMoreAvailable(result.hasMore)
      }
    } catch {
      setLoadMoreError(true)
    } finally {
      setLoadingMore(false)
    }
  }

  const total = searchTerm ? searchTotal : totalArtifacts
  const canLoadMore = searchTerm ? searchMoreAvailable : moreAvailable

  return (
    <div className={styles.layout}>
      <div className={styles.explorer}>
        <div className={styles.toolbar}>
          <div className={styles.search}><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workspace files" aria-label="Search workspace files" /></div>
          <span className={styles.count}>{loadedArtifacts.length.toLocaleString()} of {total.toLocaleString()} files</span>
        </div>
        {searchLoading && <p className={styles.empty}>Searching workspace inventory…</p>}
        {searchError && <p className={styles.empty}>Workspace search is temporarily unavailable.</p>}
        {!searchLoading && !searchError && tree && tree.children.size ? <div className={styles.tree} role="tree" aria-label={`${rootName} files`}><div className={styles.root}><Folder size={16} className={styles.folder} /><strong>{rootName}</strong></div><TreeRows node={tree} depth={0} expanded={expanded} toggle={toggle} select={setSelected} selectedId={selected?.id || null} /></div> : !searchLoading && !searchError && <p className={styles.empty}>No files match this workspace search.</p>}
        {canLoadMore && <div className={styles.loadMore}><button type="button" className="secondaryButton" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading files…' : 'Load more files'}</button>{loadMoreError && <span>Unable to load the next page.</span>}</div>}
      </div>
      <aside className={styles.details} aria-label="Artifact details">
        {selected ? <>
          <div className={styles.detailHeading}><File size={18} /><strong>{selected.relativePath}</strong></div>
          <dl>
            <div><dt>Profile</dt><dd>{profileLabel(selected.profile)}</dd></div>
            <div><dt>Size</dt><dd>{formatBytes(selected.sizeBytes)}</dd></div>
            <div><dt>MIME</dt><dd>{selected.mimeType || 'unknown'}</dd></div>
            <div><dt>Status</dt><dd>{selected.status}</dd></div>
            <div><dt>SHA-256</dt><dd className={styles.hash}>{selected.sha256}</dd></div>
          </dl>
          <p className={styles.detailLabel}>Available capabilities</p>
          {selected.capabilities.length ? <div className={styles.tags}>{selected.capabilities.flatMap((match) => match.capabilities).filter((value, index, values) => values.indexOf(value) === index).map((capability) => <span key={capability}>{capability.replaceAll('_', ' ')}</span>)}</div> : <p className={styles.emptyDetail}>No compatible providers are registered for this artifact.</p>}
          {detailsLoading && <p className={styles.detailLabel}>Loading related workspace records…</p>}
          {detailsError && <p className={styles.detailError}>Related workspace records are temporarily unavailable.</p>}
          {details && <div className={styles.relatedSummary} aria-label="Related workspace records"><p className={styles.detailLabel}>Related investigation records</p><div><span>{details.tasks.length} tasks</span><span>{details.findings.length} findings</span><span>{details.hypotheses.length} hypotheses</span><span>{details.evidence.length} evidence</span></div></div>}
          <a className="secondaryButton" href={`/api/projects/${projectId}/artifacts/${selected.id}`} download><Download size={15} /> Download artifact</a>
        </> : <div className={styles.emptyDetail}><File size={24} /><span>Select a file to inspect its profile, hash, and capabilities.</span></div>}
      </aside>
    </div>
  )
}
