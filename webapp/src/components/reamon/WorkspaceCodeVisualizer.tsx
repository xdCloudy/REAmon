'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Code2, Copy, Download, ExternalLink, RefreshCw, Search, WandSparkles } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { mergeDiff3 } from 'node-diff3'
import { buildCodeUnitTreemapEntries, filterCodeUnits, filterCodeUnitsByFolder, layoutCodeUnitTreemap, parseCodeUnitFilter, summarizeCodeUnits, type CodeUnit, type CodeUnitTreemapEntry } from '@/lib/reamon/code-units'
import { ProjectFunctionAgentQueue } from './ProjectFunctionAgentQueue'
import { ProjectCSharpBuild } from './ProjectCSharpBuild'
import { ProjectGoBuild } from './ProjectGoBuild'
import { sourceSyntaxLanguage } from './source-language'
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
    notObservedUnitCount: number
    notIndexedUnitCount: number
    unreturnedDiscoveredUnitCount: number | null
    skippedUnitCount: number | null
    unsupportedUnitCount: number | null
    excludedUnitCount: number | null
    omittedUnitCount: number | null
    linkPercent: number | null
    codeBytes: number | null
    truncated: boolean
    inventoryAvailable: boolean
    warnings: string
    failedClassDetails?: Array<{ dexEntry: string; classIndex: number; descriptor: string | null; reason: string }>
    failedClassDetailsTruncated?: boolean
    discoveredMethodCount?: number | null
    returnedMethodCount?: number | null
    indexedMethodCount?: number
    methodsTruncated?: boolean
    returnedCallCount?: number | null
    returnedReferenceCount?: number | null
    callGraphTruncated?: boolean
    referencesTruncated?: boolean
    failedUnitCount: number | null
    visitedUnitCount: number | null
    notVisitedUnitCount: number | null
  }>
  failedRuns: Array<{
    id: string
    title: string
    status: string
    progressMessage: string
    error: string
    createdAt: string
    completedAt: string | null
    artifactName: string
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
  hasControlFlowGraph: boolean
  parentCodeUnit: CodeUnit
}

type FunctionMapCellTarget = { kind: 'unit'; unit: CodeUnit }
  | { kind: 'member'; member: FunctionMapMember }

interface FunctionMapCell {
  key: string
  label: string
  detail: string
  accessibleLabel: string
  color: 'complete' | 'partial' | 'none' | 'unknown' | 'drafted'
  selected: boolean
  target: FunctionMapCellTarget
}

interface FunctionControlFlowGraph {
  label: string
  instructionLabel: string
  entryBlock: number
  exitBlock: number
  exitBlocks?: number[]
  blockCount: number
  edgeCount: number
  truncated: boolean
  instructionSamplesTruncated: boolean
  blocks: Array<{
    id: number
    kind: string
    instructionCount: number
    rawInstructionCount: number
    instructionSamples: string[]
    rawInstructionSamples: string[]
    address?: string
  }>
  edges: Array<{ from: number; to: number; kind: string }>
}

interface MaintainedCoverageResponse {
  taskId: string
  codeUnitCount: number
  maintainedUnitCount: number
  reviewedUnitCount: number | null
  validatedUnitCount: number | null
  unmatchedLegacyValidationUnitCount: number | null
  coveragePercent: number
  reviewedPercent: number | null
  validatedPercent: number | null
  decompilationCoveragePercent: number | null
  sourceLinkedPercent: number
  codeBytes: number
  measuredBytes: number
}

interface SimilarFunctionsResponse {
  matches: Array<{ codeUnit: CodeUnit; taskId?: string | null; function?: { id: string; taskId?: string; name: string; address: string | null; hasControlFlowGraph: boolean }; similarity: number; instructionSimilarity: number; controlFlowSimilarity: number | null; controlFlowTopologySimilarity: number | null; stringReferenceSimilarity: number | null; graphAnchorSupport: { acceptedMatchCount: number; relations: Array<'caller' | 'callee'> } | null; artifact: { name: string; sha256: string | null; provider: string } }>
  truncated: boolean
  graphAnchorEvidenceTruncated?: boolean
  unavailableReason?: string
}

interface PersistedFunctionMatch {
  id: string
  taskAId: string
  taskBId: string
  functionAObservationId: string | null
  functionBObservationId: string | null
  similarity: number
  instructionSimilarity: number
  controlFlowSimilarity: number | null
  controlFlowTopologySimilarity: number | null
  stringReferenceSimilarity: number | null
  reviews: Array<{ decision: string; rationale: string; reviewerId: string; createdAt: string }>
}

interface PersistedFunctionMatchesResponse { matches: PersistedFunctionMatch[] }

interface AlternateDecompilerOutput {
  id: string
  providerId: string
  providerName: string
  version: string | null
  name: string | null
  language: string
  relativePath: string
  inputSha256: string
  outputSha256: string
  completedAt: string | null
  source: string
}

interface AlternateDecompilerResponse { alternates: AlternateDecompilerOutput[]; truncated?: boolean }

interface CodeExplanationProvider { id: string; name: string; modelIdentifier: string }
interface CodeExplanationResponse { explanation: string; providerName: string; model: string; sourceTruncated: boolean }
interface ApkBuildResponse { buildId: string; taskId: string; fileName: string; sizeBytes: number; sha256: string; signed: false; changedFileCount: number; warnings?: string; downloadUrl: string }
interface JvmBuildResponse { buildId: string; taskId: string; codeUnitId: string; fileName: string; sizeBytes: number; sha256: string; sourceSha256: string; changedClassCount: number; removedClassCount: number; javaRelease: number; compilerVersion: string; diagnostics: string; warnings: string; downloadUrl: string }
interface CodeMaintenanceResponse { sourceCode: string; providerName: string; model: string; attemptId?: string | null; syntaxValidated?: boolean | null; validationStatus?: 'PASSED' | 'FAILED' | 'UNAVAILABLE' | null; validationMethod?: string | null; validationMessage?: string | null }
interface CodeDraftRecord { id: string; sourceCode: string; sourceAttemptId: string | null; providerName: string; modelIdentifier: string; question: string; scope: 'file' | 'member'; syntaxValidated: boolean | null; validationStatus: 'PASSED' | 'FAILED' | 'UNAVAILABLE' | null; validationMethod: string | null; validationMessage: string | null; updatedAt: string }
interface RewriteHistoryEntry { round: number; sourceCode: string; sourceSha256: string; validationStatus: string; validationMethod: string; validationMessage: string }
interface RewriteContextSummary { fingerprint: string; evidence: string[]; relatedUnits: Array<{ name: string; language: string; unitId: string; sourceSha256: string; sourceBytes: number }>; relatedUnitsTruncated: boolean }
interface CodeQualityReview { status: 'NO_ISSUE_FOUND' | 'NEEDS_REVIEW' | 'UNCERTAIN' | 'UNAVAILABLE'; candidateSha256: string; summary: string; findings: string[]; modelUsed: string }
interface CodeAttemptRecord { id: string; providerName: string; modelIdentifier: string; question: string; scope: 'file' | 'member' | 'rename-suggestions'; status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; cancelRequested: boolean; errorCode: string | null; errorMessage: string | null; resultSource: string | null; qualityReview?: CodeQualityReview | null; context?: RewriteContextSummary; rewriteHistoryRoundCount: number; renameProposals?: SafeRenameProposal[]; proposalSourceSha256?: string; proposalProviderId?: string; projectSymbolContextSha256?: string; proposalCandidateCount?: number; syntaxValidated: boolean | null; validationStatus: 'PASSED' | 'FAILED' | 'UNAVAILABLE' | null; validationMethod: string | null; validationMessage: string | null; createdAt: string; completedAt: string | null }
interface CodeAgentBatchAttempt { id: string; providerName: string; modelIdentifier: string; memberName: string; memberStartByte: number | null; memberEndByte: number | null; status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; cancelRequested: boolean; errorMessage: string | null; resultSource: string | null; inputSource: string | null; qualityReview?: CodeQualityReview | null; context?: RewriteContextSummary; createdAt: string; completedAt: string | null }
interface CodeDraftResponse { exists: boolean; draft: CodeDraftRecord | null; agentBatch?: { id: string; attempts: CodeAgentBatchAttempt[] } | null; attempts?: CodeAttemptRecord[] }
interface CodeUnitNoteResponse { unitId: string; note: string; stale: boolean; updatedAt: string | null }
interface CodeReviewRecord {
  id: string
  reviewerId: string
  decision: 'ACCEPTED' | 'REJECTED' | 'REVOKED'
  rationale: string
  maintainedSourceHash: string
  validationStatus?: 'PASSED' | 'FAILED' | 'UNAVAILABLE' | null
  validationMethod?: string | null
  validationMessage?: string | null
  sourceAvailable?: boolean
  createdAt: string
}
interface AcceptedRenameAlias { bindingId: string; oldName: string; newName: string; kind: string }
interface CodeMemberOutline { name: string; kind: 'function' | 'method' | 'constructor'; start_byte: number; end_byte: number; line: number; source_bytes: number }
interface SafeRenameProposal { bindingId: string; oldName: string; newName: string; kind: string; referenceCount: number; rationale: string }
interface SafeRenameSuggestions { sourceSha256: string; providerId: string; providerName: string; model: string; attemptId: string; projectSymbolContextSha256: string; candidates: number; renames: SafeRenameProposal[] }

interface ReviewDiffRow { kind: 'added' | 'removed'; text: string; beforeLine: number | null; afterLine: number | null }
interface ReviewDiff { rows: ReviewDiffRow[]; added: number; removed: number; truncated: boolean; unavailable: boolean }

function sourceLineCount(source: string): number {
  let lines = 1
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\r') {
      lines += 1
      if (source[index + 1] === '\n') index += 1
    } else if (source[index] === '\n') lines += 1
  }
  return lines
}

function buildReviewDiff(before: string, after: string): ReviewDiff {
  const beforeLineCount = sourceLineCount(before)
  const afterLineCount = sourceLineCount(after)
  const columns = afterLineCount + 1
  const cells = (beforeLineCount + 1) * columns
  if (cells > 1_000_000) return { rows: [], added: 0, removed: 0, truncated: false, unavailable: true }
  const beforeLines = before.replace(/\r\n?/g, '\r\n').split('\r\n')
  const afterLines = after.replace(/\r\n?/g, '\r\n').split('\r\n')
  const lengths = new Uint32Array(cells)
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const index = beforeIndex * columns + afterIndex
      lengths[index] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? lengths[(beforeIndex + 1) * columns + afterIndex + 1] + 1
        : Math.max(lengths[(beforeIndex + 1) * columns + afterIndex], lengths[beforeIndex * columns + afterIndex + 1])
    }
  }
  const rows: ReviewDiffRow[] = []
  const MAX_ROWS = 600
  let beforeIndex = 0
  let afterIndex = 0
  let added = 0
  let removed = 0
  let truncated = false
  const append = (row: ReviewDiffRow) => {
    if (rows.length < MAX_ROWS) rows.push(row)
    else truncated = true
  }
  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      beforeIndex += 1
      afterIndex += 1
    } else if (lengths[(beforeIndex + 1) * columns + afterIndex] >= lengths[beforeIndex * columns + afterIndex + 1]) {
      append({ kind: 'removed', text: beforeLines[beforeIndex], beforeLine: beforeIndex + 1, afterLine: null })
      removed += 1
      beforeIndex += 1
    } else {
      append({ kind: 'added', text: afterLines[afterIndex], beforeLine: null, afterLine: afterIndex + 1 })
      added += 1
      afterIndex += 1
    }
  }
  while (beforeIndex < beforeLines.length) {
    append({ kind: 'removed', text: beforeLines[beforeIndex], beforeLine: beforeIndex + 1, afterLine: null })
    removed += 1
    beforeIndex += 1
  }
  while (afterIndex < afterLines.length) {
    append({ kind: 'added', text: afterLines[afterIndex], beforeLine: null, afterLine: afterIndex + 1 })
    added += 1
    afterIndex += 1
  }
  return { rows, added, removed, truncated, unavailable: false }
}

function containsUnresolvedMergeMarkers(source: string): boolean {
  return /^(?:<<<<<<< .+|\|{7} .+|=======|>>>>>>> .+)$/m.test(source)
}

function sourceLines(source: string): string[] {
  return source.replace(/\r\n?/g, '\n').split('\n')
}

function validationSummary(validation: Pick<CodeMaintenanceResponse, 'syntaxValidated' | 'validationStatus' | 'validationMethod' | 'validationMessage'>): string {
  const method = validation.validationMethod || 'Source parser'
  if (validation.validationStatus === 'PASSED') return `${method} passed${validation.validationMessage ? `: ${validation.validationMessage}` : '.'} Review reconstructed logic and behavior before saving.`
  if (validation.validationStatus === 'FAILED') return `${method} rejected this source${validation.validationMessage ? `: ${validation.validationMessage}` : '.'}`
  if (validation.validationStatus === 'UNAVAILABLE') return `Validation unavailable${validation.validationMethod ? ` (${validation.validationMethod})` : ''}${validation.validationMessage ? `: ${validation.validationMessage}` : ' for this language. Check syntax and behavior before saving.'}`
  if (validation.syntaxValidated === true) return 'The source parser found no syntax errors. Review reconstructed logic and behavior before saving.'
  if (validation.syntaxValidated === false) return 'Syntax validation was unavailable for this language. Check syntax and behavior before saving.'
  return 'This draft has changed or predates saved validation metadata. Recheck its syntax and behavior before saving.'
}

function RewriteContextDetails({ context }: { context: RewriteContextSummary }) {
  return <details className={styles.rewriteContext}>
    <summary>Evidence context · {context.fingerprint.slice(0, 12)}</summary>
    {context.evidence.length > 0
      ? <ul>{context.evidence.map((source) => <li key={source}>{source}</li>)}</ul>
      : <p>No additional project evidence was attached.</p>}
    {context.relatedUnits.length > 0 && <>
      <p>Related code included:</p>
      <ul>{context.relatedUnits.map((unit, index) => <li key={`${unit.name}:${unit.language}:${unit.unitId}:${unit.sourceSha256}:${index}`}>
        {unit.name}{unit.language ? ` · ${unit.language}` : ''}
        {unit.unitId ? <small title={`Project code-unit record ${unit.unitId}`}> · record {unit.unitId.slice(0, 10)}</small> : null}
        <small title={`SHA-256 ${unit.sourceSha256}`}>
          {' '}· snapshot {unit.sourceSha256.slice(0, 12)} · {unit.sourceBytes.toLocaleString()} bytes
        </small>
      </li>)}</ul>
      {context.relatedUnitsTruncated && <p>Additional related units were omitted from this summary.</p>}
    </>}
  </details>
}

function CodeQualityReviewDetails({ review }: { review: CodeQualityReview }) {
  const label = review.status === 'NO_ISSUE_FOUND' ? 'No issue identified'
    : review.status === 'NEEDS_REVIEW' ? 'Needs review'
      : review.status === 'UNCERTAIN' ? 'Uncertain' : 'Unavailable'
  return <details className={styles.rewriteContext}>
    <summary>AI evidence check · {label}</summary>
    <p>{review.summary}</p>
    {review.modelUsed && <p>Reviewer model: {review.modelUsed}</p>}
    <p title={`SHA-256 ${review.candidateSha256}`}>Checked candidate snapshot {review.candidateSha256.slice(0, 12)}</p>
    {review.findings.length > 0 && <ul>{review.findings.map((finding, index) => <li key={`${index}:${finding}`}>{finding}</li>)}</ul>}
    <p>This is an advisory LLM review. “No issue identified” does not establish behavioral equivalence.</p>
  </details>
}

function FunctionControlFlowPanel({
  name,
  query,
  onAddressSelect,
}: {
  name: string
  query: { data?: FunctionControlFlowGraph; isLoading: boolean; error: unknown }
  onAddressSelect?: (address: string) => void
}) {
  const graph = query.data
  const exitBlocks = graph?.exitBlocks?.length ? graph.exitBlocks : (graph ? [graph.exitBlock] : [])
  const columns = Math.min(4, Math.max(1, graph?.blocks.length || 1))
  const nodeWidth = 220
  const columnGap = 30
  const rowHeight = 108
  const width = columns * (nodeWidth + columnGap) + 10
  const rows = Math.ceil((graph?.blocks.length || 1) / columns)
  const height = rows * rowHeight + 16
  const positions = new Map((graph?.blocks || []).map((block, index) => [
    block.id,
    { x: 10 + (index % columns) * (nodeWidth + columnGap), y: 10 + Math.floor(index / columns) * rowHeight },
  ]))

  return <section className={styles.cfgPanel} aria-label={`Control-flow graph for ${name}`}>
    <div className={styles.cfgHeader}>
      <div>
        <h3>Control-flow graph</h3>
        <p>{graph ? `${graph.blockCount} blocks · ${graph.edgeCount} edges` : 'Bounded graph summary from the selected decompiler.'}</p>
      </div>
      {graph?.truncated && <span className={styles.graphBadge}>Partial graph</span>}
      {graph?.instructionSamplesTruncated && <span className={styles.graphBadge}>Instruction samples omitted</span>}
    </div>
    {query.isLoading && <p className={styles.cfgMessage} role="status">Loading control-flow graph…</p>}
    {Boolean(query.error) && <p className={styles.cfgMessage} role="alert">{query.error instanceof Error ? query.error.message : 'Could not load the control-flow graph.'}</p>}
    {graph && graph.blocks.length > 0 && <>
      <div className={styles.cfgLegend}><span>Entry block {graph.entryBlock}</span><span>Exit blocks {exitBlocks.join(', ')}</span></div>
      <div className={styles.cfgCanvas}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${graph.blocks.length} displayed basic blocks and ${graph.edges.length} displayed control-flow edges`}>
          <defs>
            <marker id="reamon-cfg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {graph.edges.map((edge, index) => {
            const from = positions.get(edge.from)
            const to = positions.get(edge.to)
            if (!from || !to) return null
            const startX = from.x + nodeWidth / 2
            const startY = from.y + 78
            const endX = to.x + nodeWidth / 2
            const endY = to.y
            const middleY = (startY + endY) / 2
            return <g key={`${edge.from}:${edge.to}:${edge.kind}:${index}`} className={styles.cfgEdge}>
              <path d={`M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`} markerEnd="url(#reamon-cfg-arrow)" />
              <text x={(startX + endX) / 2 + 4} y={middleY - 3}>{edge.kind}</text>
            </g>
          })}
          {graph.blocks.map((block) => {
            const position = positions.get(block.id)
            if (!position) return null
            return <g
              key={block.id}
              className={`${styles.cfgNode} ${block.id === graph.entryBlock ? styles.cfgEntry : ''} ${exitBlocks.includes(block.id) ? styles.cfgExit : ''}`}
              role={block.address && onAddressSelect ? 'button' : undefined}
              tabIndex={block.address && onAddressSelect ? 0 : undefined}
              aria-label={block.address && onAddressSelect ? `Basic block ${block.id} at ${block.address}; navigate to disassembly` : undefined}
              style={block.address && onAddressSelect ? { cursor: 'pointer' } : undefined}
              onClick={block.address && onAddressSelect ? () => onAddressSelect(block.address!) : undefined}
              onKeyDown={block.address && onAddressSelect ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onAddressSelect(block.address!)
                }
              } : undefined}
            >
              <rect x={position.x} y={position.y} width={nodeWidth} height={78} rx={8} />
              <text x={position.x + 12} y={position.y + 21}>Block {block.id} · {block.kind}</text>
              <text x={position.x + 12} y={position.y + 41}>{block.instructionCount} {graph.instructionLabel}</text>
              {block.address && <>
                <text x={position.x + 12} y={position.y + 62}>{block.address.slice(0, 30)}</text>
                <title>{`Block ${block.id} begins at ${block.address}`}</title>
              </>}
            </g>
          })}
        </svg>
      </div>
      {graph.blocks.some((block) => block.instructionSamples.length || block.rawInstructionSamples.length) && <details className={styles.cfgEvidence} open>
        <summary>Sampled instructions</summary>
        <div>
          {graph.blocks.filter((block) => block.instructionSamples.length || block.rawInstructionSamples.length).map((block) => <article key={block.id}>
            <h4>Block {block.id}</h4>
            {block.instructionSamples.map((line, index) => <p key={`ir:${index}`}><strong>IR</strong><code>{line}</code></p>)}
            {block.rawInstructionSamples.map((line, index) => <p key={`raw:${index}`}><strong>Bytecode / raw</strong><code>{line}</code></p>)}
          </article>)}
        </div>
      </details>}
      <p className={styles.cfgMessage}>This view shows bounded graph topology and instruction excerpts. Decompiled source remains the editable module artifact.</p>
    </>}
    {graph && graph.blocks.length === 0 && <p className={styles.cfgMessage}>This function has no basic blocks to display.</p>}
  </section>
}

type CffRecovery = NonNullable<CodeUnit['controlFlowFlattening']>

function CffRecoveryGraph({ recovery, onAddressSelect }: { recovery: CffRecovery; onAddressSelect: (address: string) => void }) {
  const columns = Math.min(4, Math.max(1, recovery.nodes.length))
  const nodeWidth = 190
  const nodeHeight = 58
  const columnGap = 34
  const rowGap = 50
  const width = columns * (nodeWidth + columnGap) + 10
  const rows = Math.ceil(recovery.nodes.length / columns)
  const height = rows * (nodeHeight + rowGap) + 10
  const positions = new Map(recovery.nodes.map((node, index) => [node.head, {
    x: 5 + (index % columns) * (nodeWidth + columnGap),
    y: 5 + Math.floor(index / columns) * (nodeHeight + rowGap),
  }]))
  const edges = recovery.nodes.flatMap((node) => node.successors.flatMap((target, index) => {
    const from = positions.get(node.head)
    const to = positions.get(target)
    if (!from || !to) return []
    const label = node.status === 'cond'
      ? target === node.trueSuccessor ? 'true' : target === node.falseSuccessor ? 'false' : 'branch'
      : ''
    const selfLoop = node.head === target
    return [{ from, to, label: selfLoop ? 'loop' : label, selfLoop, key: `${node.head}:${target}:${index}` }]
  }))

  return <div className={styles.cfgCanvas}>
    <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Recovered flattened control-flow graph">
      <defs>
        <marker id="reamon-cff-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {edges.map((edge) => {
        if (edge.selfLoop) {
          const x = edge.from.x + nodeWidth
          const y = edge.from.y
          return <g key={edge.key} className={styles.cfgEdge}>
            <path d={`M ${x} ${y + 14} C ${x + 28} ${y + 14}, ${x + 28} ${y + 44}, ${x} ${y + 44}`} markerEnd="url(#reamon-cff-arrow)" />
            <text x={x + 4} y={y + 33}>loop</text>
          </g>
        }
        const startX = edge.from.x + nodeWidth / 2
        const startY = edge.from.y + nodeHeight
        const endX = edge.to.x + nodeWidth / 2
        const endY = edge.to.y
        const middleY = (startY + endY) / 2
        return <g key={edge.key} className={styles.cfgEdge}>
          <path d={`M ${startX} ${startY} C ${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`} markerEnd="url(#reamon-cff-arrow)" />
          {edge.label && <text x={(startX + endX) / 2 + 4} y={middleY - 3}>{edge.label}</text>}
        </g>
      })}
      {recovery.nodes.map((node) => {
        const position = positions.get(node.head)
        if (!position) return null
        const entry = node.head === recovery.entry || node.head === recovery.firstHead
        return <g
          key={node.head}
          className={`${styles.cfgNode} ${entry ? styles.cfgEntry : ''} ${styles.cfgInteractive}`}
          role="button"
          tabIndex={0}
          aria-label={`Recovered block ${node.head}, ${node.status}. Inspect disassembly.`}
          onClick={() => onAddressSelect(node.head)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onAddressSelect(node.head)
            }
          }}
        >
          <title>{`${node.head} · ${node.status}${node.selfLoop ? ' · self-loop' : ''}${node.complete ? '' : ' · incomplete'}`}</title>
          <rect x={position.x} y={position.y} width={nodeWidth} height={nodeHeight} rx="4" />
          <text x={position.x + 9} y={position.y + 23}>{node.head}</text>
          <text x={position.x + 9} y={position.y + 43}>{node.status}{node.selfLoop ? ' · self-loop' : ''}{node.complete ? '' : ' · incomplete'}</text>
        </g>
      })}
    </svg>
  </div>
}

const EMPTY_CODE_UNITS: CodeUnit[] = []
const AUTO_LOAD_CODE_UNIT_LIMIT = 2_000
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
      || (result.reviewedUnitCount !== undefined && result.reviewedUnitCount !== null && !Number.isSafeInteger(result.reviewedUnitCount))
      || (result.validatedUnitCount !== undefined && result.validatedUnitCount !== null && !Number.isSafeInteger(result.validatedUnitCount))
      || (result.unmatchedLegacyValidationUnitCount !== undefined && result.unmatchedLegacyValidationUnitCount !== null && !Number.isSafeInteger(result.unmatchedLegacyValidationUnitCount))
      || (result.reviewedPercent !== undefined && result.reviewedPercent !== null && !Number.isSafeInteger(result.reviewedPercent))
      || (result.validatedPercent !== undefined && result.validatedPercent !== null && !Number.isSafeInteger(result.validatedPercent))
      || !(result.decompilationCoveragePercent === null || Number.isSafeInteger(result.decompilationCoveragePercent))
      || !Number.isSafeInteger(result.sourceLinkedPercent) || !Number.isSafeInteger(result.codeBytes) || !Number.isSafeInteger(result.measuredBytes)) {
    throw new Error('Maintained-source coverage response is incomplete')
  }
  return {
    ...result,
    reviewedUnitCount: result.reviewedUnitCount ?? null,
    validatedUnitCount: result.validatedUnitCount ?? null,
    unmatchedLegacyValidationUnitCount: result.unmatchedLegacyValidationUnitCount ?? null,
    reviewedPercent: result.reviewedPercent ?? null,
    validatedPercent: result.validatedPercent ?? null,
  } as MaintainedCoverageResponse
}

async function fetchFunctionControlFlowGraph(projectId: string, taskId: string, functionId: string, signal?: AbortSignal): Promise<FunctionControlFlowGraph> {
  const params = new URLSearchParams({ taskId, functionId })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/function-cfg?${params.toString()}`, { signal, cache: 'no-store' })
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(detail?.error || 'Unable to load this function control-flow graph')
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

async function fetchSavedFunctionMatches(projectId: string, taskId: string, functionId: string, signal?: AbortSignal): Promise<PersistedFunctionMatchesResponse> {
  const params = new URLSearchParams({ taskId, functionId })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/function-matches?${params.toString()}`, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to load saved function comparison reviews')
  return response.json()
}

function artifactUrl(projectId: string, unit: CodeUnit, codeArtifactId: string | null): string | null {
  if (!unit.artifactId || !codeArtifactId) return null
  const sourcePath = codeArtifactId.split('/').map(encodeURIComponent).join('/')
  return '/api/projects/' + encodeURIComponent(projectId) + '/artifacts/' + encodeURIComponent(unit.artifactId) + '/decompiled/' + sourcePath
}

function languageLabel(unit: CodeUnit): string {
  if (unit.representation) return `${unit.language || 'Generated source'} · ${unit.decompiler || 'reconstruction'}`
  if (unit.source === 'reamon-oxidizer') return 'Rust-like pseudocode · Oxidizer'
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

async function fetchRewriteHistory(projectId: string, attemptId: string, signal?: AbortSignal): Promise<RewriteHistoryEntry[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate/attempts/${encodeURIComponent(attemptId)}`, { signal, cache: 'no-store' })
  const result = await response.json().catch(() => null) as { rewriteHistory?: unknown; error?: string } | null
  if (!response.ok) throw new Error(result?.error || 'Could not load saved syntax-repair candidates')
  return Array.isArray(result?.rewriteHistory) ? result.rewriteHistory as RewriteHistoryEntry[] : []
}

function SavedRewriteHistory({ projectId, attemptId, roundCount }: { projectId: string; attemptId: string; roundCount: number }) {
  const [open, setOpen] = useState(false)
  const historyQuery = useQuery({
    queryKey: ['reamon-rewrite-history', projectId, attemptId],
    queryFn: ({ signal }) => fetchRewriteHistory(projectId, attemptId, signal),
    enabled: open,
    staleTime: Infinity,
  })
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>View saved syntax-repair candidates ({roundCount})</summary>
    {historyQuery.isLoading && <p className={styles.message}>Loading saved candidates…</p>}
    {historyQuery.isError && <p className={styles.error}>{historyQuery.error instanceof Error ? historyQuery.error.message : 'Could not load saved candidates'}</p>}
    {historyQuery.data?.map((round) => <section key={`${round.round}:${round.sourceSha256}`}>
      <p>Round {round.round} · {round.validationStatus} via {round.validationMethod} · SHA-256 {round.sourceSha256}</p>
      <p>{round.validationMessage}</p>
      <pre className={styles.attemptSource}><code>{round.sourceCode}</code></pre>
    </section>)}
  </details>
}

async function fetchAlternateDecompilerOutputs(projectId: string, unitId: string, signal?: AbortSignal): Promise<AlternateDecompilerResponse> {
  const params = new URLSearchParams({ unitId })
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/alternates?${params.toString()}`, { signal, cache: 'no-store' })
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(detail?.error || 'Unable to load alternate decompiler output')
  }
  const result = await response.json() as Partial<AlternateDecompilerResponse>
  return { alternates: Array.isArray(result.alternates) ? result.alternates : [] }
}

async function fetchExplanationProviders(projectId: string): Promise<CodeExplanationProvider[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/providers`, { cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to load saved AI providers')
  const data = await response.json() as { providers?: CodeExplanationProvider[] }
  return Array.isArray(data.providers) ? data.providers : []
}

function isDisassemblyUnit(unit: CodeUnit | undefined): boolean {
  return unit?.language === 'WebAssembly Text (WAT)' || unit?.language === 'Smali' || unit?.representation === 'YARV instruction disassembly'
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

// The high-density cell sizing follows decomp.wtf's canvas map, adapted for REAmon's evidence layers.
// Upstream is MIT licensed: https://github.com/i12bp8/decomp.wtf/tree/575b4a30ed481ff5497dfb9ce4f599368a95a04a
const DENSE_FUNCTION_MAP_THRESHOLD = 900

function cssCanvasColor(token: string, fallback: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${token}, ${fallback})`
  document.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

function DenseFunctionMap({ cells, onSelect }: {
  cells: FunctionMapCell[]
  onSelect: (cell: FunctionMapCell) => void
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapId = useId()
  const [layout, setLayout] = useState<{ width: number; height: number; cellSize: number; gap: number; columns: number; dpr: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [hasFocus, setHasFocus] = useState(false)
  const [themeRevision, setThemeRevision] = useState(0)
  const boundedActiveIndex = Math.min(activeIndex, Math.max(0, cells.length - 1))

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => {
      const style = getComputedStyle(viewport)
      const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
      const width = Math.max(1, Math.floor(viewport.clientWidth - horizontalPadding))
      const count = Math.max(1, cells.length)
      let cellSize = Math.floor(Math.sqrt((width * 300) / count))
      cellSize = Math.max(5, Math.min(26, cellSize))
      const gap = cellSize >= 12 ? 3 : 2
      const columns = Math.max(1, Math.floor((width + gap) / (cellSize + gap)))
      const rows = Math.ceil(count / columns)
      setLayout({
        width,
        height: rows * (cellSize + gap) - gap,
        cellSize,
        gap,
        columns,
        dpr: Math.min(2, window.devicePixelRatio || 1),
      })
    }
    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(viewport)
    const themeObserver = new MutationObserver(() => setThemeRevision((revision) => revision + 1))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    return () => {
      resizeObserver.disconnect()
      themeObserver.disconnect()
    }
  }, [cells.length])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !layout) return
    canvas.width = Math.round(layout.width * layout.dpr)
    canvas.height = Math.round(layout.height * layout.dpr)
    canvas.style.width = `${layout.width}px`
    canvas.style.height = `${layout.height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0)
    context.clearRect(0, 0, layout.width, layout.height)
    const colors = {
      complete: cssCanvasColor('--status-success', '#00a876'),
      partial: cssCanvasColor('--status-warning', '#b99a3b'),
      none: cssCanvasColor('--status-error', '#9b4d4d'),
      unknown: cssCanvasColor('--status-neutral-bg', '#394458'),
      drafted: cssCanvasColor('--accent-secondary', '#5f9fe8'),
    }
    const radius = layout.cellSize >= 10 ? 2.5 : layout.cellSize >= 7 ? 1.5 : 1
    cells.forEach((cell, index) => {
      const x = (index % layout.columns) * (layout.cellSize + layout.gap)
      const y = Math.floor(index / layout.columns) * (layout.cellSize + layout.gap)
      context.fillStyle = colors[cell.color]
      context.beginPath()
      context.roundRect(x, y, layout.cellSize, layout.cellSize, radius)
      context.fill()
      if (cell.selected) {
        context.strokeStyle = '#ffffff'
        context.lineWidth = 2
        context.strokeRect(x - 1, y - 1, layout.cellSize + 2, layout.cellSize + 2)
      }
      if (hasFocus && index === boundedActiveIndex) {
        context.strokeStyle = colors.drafted
        context.lineWidth = 2
        context.strokeRect(x - 2, y - 2, layout.cellSize + 4, layout.cellSize + 4)
      }
    })
  }, [boundedActiveIndex, cells, hasFocus, layout, themeRevision])

  const activeCell = cells[boundedActiveIndex]
  const activeRow = layout ? Math.floor(boundedActiveIndex / layout.columns) + 1 : 1
  const activeColumn = layout ? boundedActiveIndex % layout.columns + 1 : 1

  function cellAtPointer(event: { clientX: number; clientY: number }): number {
    if (!layout) return -1
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return -1
    const x = event.clientX - rect.left
    // The canvas rect moves with the scrolled content, so this is already a
    // canvas-relative coordinate. Adding scrollTop again would offset hit tests.
    const y = event.clientY - rect.top
    const stride = layout.cellSize + layout.gap
    const column = Math.floor(x / stride)
    const row = Math.floor(y / stride)
    if (column < 0 || column >= layout.columns || x % stride >= layout.cellSize || y % stride >= layout.cellSize) return -1
    const index = row * layout.columns + column
    return index < cells.length ? index : -1
  }

  function moveActive(key: string) {
    if (!layout || !cells.length) return
    const rowStep = layout.columns
    const nextIndex = key === 'ArrowRight' ? Math.min(cells.length - 1, boundedActiveIndex + 1)
      : key === 'ArrowLeft' ? Math.max(0, boundedActiveIndex - 1)
        : key === 'ArrowDown' ? Math.min(cells.length - 1, boundedActiveIndex + rowStep)
          : key === 'ArrowUp' ? Math.max(0, boundedActiveIndex - rowStep)
            : key === 'Home' ? 0
              : key === 'End' ? cells.length - 1
                : key === 'PageDown' ? Math.min(cells.length - 1, boundedActiveIndex + rowStep * 10)
                  : key === 'PageUp' ? Math.max(0, boundedActiveIndex - rowStep * 10) : boundedActiveIndex
    setActiveIndex(nextIndex)
    if (key.startsWith('Arrow') || key.startsWith('Page')) {
      const row = Math.floor(nextIndex / rowStep)
      const scrollTarget = row * (layout.cellSize + layout.gap)
      const viewport = viewportRef.current
      if (viewport && (scrollTarget < viewport.scrollTop || scrollTarget > viewport.scrollTop + viewport.clientHeight - layout.cellSize)) {
        viewport.scrollTop = Math.max(0, scrollTarget - viewport.clientHeight / 2)
      }
    }
  }

  const activeCellId = `${mapId}-cell-${boundedActiveIndex}`
  return <>
    <p className={styles.functionMapNote}>Dense map: one cell per code unit or outlined function. Focus the map and use arrow keys, Home, End, or Page Up and Page Down; press Enter or Space to inspect the selected item. Hover a cell for its label.</p>
    <div
      ref={viewportRef}
      className={styles.denseFunctionMapViewport}
      role="grid"
      tabIndex={0}
      aria-label={`Dense function map with ${cells.length.toLocaleString()} code units and functions`}
      aria-rowcount={layout ? Math.ceil(cells.length / layout.columns) : undefined}
      aria-colcount={layout?.columns}
      aria-activedescendant={activeCell ? activeCellId : undefined}
      onFocus={() => setHasFocus(true)}
      onBlur={() => setHasFocus(false)}
      onPointerMove={(event) => {
        const index = cellAtPointer(event)
        event.currentTarget.title = index >= 0
          ? `${cells[index].label}${cells[index].detail ? ` · ${cells[index].detail}` : ''} · ${cells[index].accessibleLabel}`
          : ''
      }}
      onPointerLeave={(event) => {
        event.currentTarget.removeAttribute('title')
      }}
      onClick={(event) => {
        const index = cellAtPointer(event)
        if (index >= 0) {
          setActiveIndex(index)
          onSelect(cells[index])
        }
      }}
      onKeyDown={(event) => {
        if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
          event.preventDefault()
          moveActive(event.key)
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (activeCell) onSelect(activeCell)
        }
      }}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      {activeCell && <div className={styles.srOnly} role="row" aria-rowindex={activeRow}>
        <div id={activeCellId} role="gridcell" aria-colindex={activeColumn} aria-label={activeCell.accessibleLabel} />
      </div>}
    </div>
  </>
}

function shortenLabel(value: string, width: number): string {
  const maxCharacters = Math.max(0, Math.floor((width - 14) / 7.2))
  if (maxCharacters < 5) return ''
  return value.length > maxCharacters ? `${value.slice(0, maxCharacters - 1)}…` : value
}

const MAX_SOURCE_PREVIEW_CHARS = 25_000
const MAX_MEMBER_REWRITE_BYTES = 64 * 1024
const MAX_MEMBER_OUTLINE_BYTES = 2 * 1024 * 1024

function SourceListing({ source, language, fileName, fullSourceUrl, sourceAddressMap, onMappedAddressSelect, highlightAddress, lineIdPrefix, mappingLabel = 'instruction address' }: {
  source: string
  language: string | null | undefined
  fileName: string | null | undefined
  fullSourceUrl?: string | null
  sourceAddressMap?: Array<{ sourceLineNumber: number; address: string }>
  onMappedAddressSelect?: (addresses: string[]) => void
  highlightAddress?: string | null
  lineIdPrefix?: string
  mappingLabel?: string
}) {
  const syntaxLanguage = sourceSyntaxLanguage(language, fileName)
  const preview = source.length > MAX_SOURCE_PREVIEW_CHARS
    ? source.slice(0, MAX_SOURCE_PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/, '')
    : source
  const addressesByLine = useMemo(() => {
    const result = new Map<number, string[]>()
    for (const mapping of sourceAddressMap || []) {
      const addresses = result.get(mapping.sourceLineNumber) || []
      if (!addresses.includes(mapping.address)) addresses.push(mapping.address)
      result.set(mapping.sourceLineNumber, addresses)
    }
    return result
  }, [sourceAddressMap])
  const assemblyAddressByLine = useMemo(() => {
    const result = new Map<number, string>()
    preview.split(/\r\n?\r\n/).forEach((line, index) => {
      const address = line.match(/^\s*([A-Za-z0-9:_-]{1,128}):\s/)?.[1]
      if (address) result.set(index + 1, address)
    })
    return result
  }, [preview])
  useEffect(() => {
    if (!highlightAddress || !lineIdPrefix) return
    document.getElementById(`${lineIdPrefix}-${encodeURIComponent(highlightAddress)}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlightAddress, lineIdPrefix, preview])
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
      wrapLines
      lineProps={(lineNumber) => {
        const addresses = addressesByLine.get(lineNumber)
        const mappedAddresses = addresses || []
        const assemblyAddress = assemblyAddressByLine.get(lineNumber)
        const mappedLine = Boolean(mappedAddresses.length && onMappedAddressSelect)
        const selectedInstruction = Boolean(highlightAddress && assemblyAddress === highlightAddress)
        const mappedAddressLabel = mappedAddresses.length === 1
          ? mappingLabel
          : mappingLabel === 'instruction address' ? 'instruction addresses' : `${mappingLabel}s`
        return {
          ...(lineIdPrefix && assemblyAddress ? { id: `${lineIdPrefix}-${encodeURIComponent(assemblyAddress)}` } : {}),
          ...(mappedLine ? {
            role: 'button',
            tabIndex: 0,
            title: `Source line ${lineNumber}: click to jump to ${mappedAddresses.length} associated ${mappedAddressLabel}`,
            'aria-label': `Source line ${lineNumber}; click to navigate to associated ${mappingLabel}`,
            onClick: () => onMappedAddressSelect?.(mappedAddresses),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onMappedAddressSelect?.(mappedAddresses)
              }
            },
            className: styles.mappedSourceLine,
          } : {}),
          ...(selectedInstruction ? { className: styles.selectedInstructionLine } : {}),
        }
      }}
      lineNumberStyle={{ color: '#68788f', minWidth: '3.25em', paddingRight: '1.25em', userSelect: 'none' }}
      customStyle={{ margin: 0, borderRadius: 0, background: 'transparent', fontSize: 'inherit', lineHeight: 'inherit' }}
      codeTagProps={{ className: styles.sourceCodeText }}
    >{preview}</SyntaxHighlighter>
  </>
}

export function WorkspaceCodeVisualizer({ projectId, isAnalyzing, analysisTask, analysisHref, standalone = false }: {
  projectId: string
  isAnalyzing: boolean
  analysisTask?: { status: string; progressMessage?: string | null }
  analysisHref?: string
  standalone?: boolean
}) {
  const [filter, setFilter] = useState('')
  const [maintenanceFilter, setMaintenanceFilter] = useState<'all' | 'needs-work' | 'drafted' | 'maintained'>('all')
  const [serverSearch, setServerSearch] = useState('')
  const [visualizerView, setVisualizerView] = useState<'function-map' | 'treemap'>('function-map')
  const [mapContentPreference, setMapContentPreference] = useState<'auto' | 'units' | 'folders'>('auto')
  const [mapLayer, setMapLayer] = useState<'decompilation' | 'maintenance' | 'work'>('work')
  const [folderPath, setFolderPath] = useState<string[]>([])
  const [languageFilter, setLanguageFilter] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEvidenceAddress, setSelectedEvidenceAddress] = useState<string | null>(null)
  const [selectedFunctionMapMember, setSelectedFunctionMapMember] = useState<{ id: string; taskId?: string; parentUnitId: string; name: string; similarityAvailable: boolean; hasControlFlowGraph: boolean } | null>(null)
  const [savingFunctionMatchKey, setSavingFunctionMatchKey] = useState<string | null>(null)
  const [functionMatchActionError, setFunctionMatchActionError] = useState('')
  const [urlInitialized, setUrlInitialized] = useState(false)
  const [matchedUnitOverride, setMatchedUnitOverride] = useState<CodeUnit | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [compareAlternatesOpen, setCompareAlternatesOpen] = useState(false)
  const [compareDiffOpen, setCompareDiffOpen] = useState(false)
  const [selectedAlternateId, setSelectedAlternateId] = useState('')
  const [assemblyCopyStatus, setAssemblyCopyStatus] = useState('')
  const [providerId, setProviderId] = useState('')
  const [reviewerProviderId, setReviewerProviderId] = useState('')
  const [question, setQuestion] = useState('')
  const [projectNoteDraft, setProjectNoteDraft] = useState<{ unitId: string; note: string } | null>(null)
  const [savingProjectNote, setSavingProjectNote] = useState(false)
  const [projectNoteStatus, setProjectNoteStatus] = useState('')
  const [projectNoteError, setProjectNoteError] = useState('')
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
  const [safeRenameSuggestions, setSafeRenameSuggestions] = useState<SafeRenameSuggestions | null>(null)
  const [selectedSafeRenameIds, setSelectedSafeRenameIds] = useState<Set<string>>(new Set())
  const [suggestingSafeRenames, setSuggestingSafeRenames] = useState(false)
  const [applyingSafeRenames, setApplyingSafeRenames] = useState(false)
  const [safeRenameStatus, setSafeRenameStatus] = useState('')
  const [reviewRationale, setReviewRationale] = useState('')
  const [rebaseStatus, setRebaseStatus] = useState('')
  const [reviewStatus, setReviewStatus] = useState('')
  const [loadingMaintainedRevisionId, setLoadingMaintainedRevisionId] = useState<string | null>(null)
  const [restoreReviewId, setRestoreReviewId] = useState<string | null>(null)
  const [showReviewDiff, setShowReviewDiff] = useState(false)
  const [transforming, setTransforming] = useState(false)
  const [activeRewriteAttemptId, setActiveRewriteAttemptId] = useState<string | null>(null)
  const [cancellingRewrite, setCancellingRewrite] = useState(false)
  const [restoringAttemptId, setRestoringAttemptId] = useState<string | null>(null)
  const [savingMaintained, setSavingMaintained] = useState(false)
  const [maintainedSaved, setMaintainedSaved] = useState(false)
  const [smaliDraft, setSmaliDraft] = useState('')
  const [smaliSaved, setSmaliSaved] = useState(false)
  const [smaliReviewRationale, setSmaliReviewRationale] = useState('')
  const [smaliReviewStatus, setSmaliReviewStatus] = useState('')
  const [loadingSmaliRevisionId, setLoadingSmaliRevisionId] = useState<string | null>(null)
  const [savingSmali, setSavingSmali] = useState(false)
  const [smaliError, setSmaliError] = useState('')
  const [memberFilter, setMemberFilter] = useState('')
  const [rewrittenMembers, setRewrittenMembers] = useState<Set<string>>(new Set())
  const [selectedAgentMembers, setSelectedAgentMembers] = useState<Set<string>>(new Set())
  const [agentTeamRunning, setAgentTeamRunning] = useState(false)
  const [agentTeamDispatching, setAgentTeamDispatching] = useState(false)
  const [cancellingAgentBatch, setCancellingAgentBatch] = useState(false)
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
  const [jvmBuild, setJvmBuild] = useState<JvmBuildResponse | null>(null)
  const [buildingJvm, setBuildingJvm] = useState(false)
  const [jvmBuildError, setJvmBuildError] = useState('')
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
  const failedRuns = query.data?.failedRuns || []
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
    enabled: Boolean(selectedId && currentRunId
      && (!units.some((unit) => unit.id === selectedId) || units.find((unit) => unit.id === selectedId)?.source === 'reamon-ghidra')),
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
  const currentRun = runs.find((run) => run.id === currentRunId) || null
  const displayRunWarnings = currentRun?.warnings
    .replace(/(?:^|\s)Picked up JAVA_TOOL_OPTIONS:(?:\s+-\S+)*/g, '')
    .replace(/JADX exited with code 3\.?/g, 'JADX reported decompilation errors after producing output; some retained source may be incomplete (exit code 3).')
    .trim() || ''
  const maintainedCoverageQuery = useQuery({
    queryKey: ['reamon-maintained-coverage', projectId, currentRunId],
    queryFn: ({ signal }) => fetchMaintainedCoverage(projectId, currentRunId as string, signal),
    enabled: Boolean(currentRunId),
    staleTime: 5_000,
    refetchInterval: isAnalyzing ? 3000 : false,
    refetchIntervalInBackground: false,
  })
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
  const functionMapCells = useMemo(() => {
    const colorFor = (unit: CodeUnit): FunctionMapCell['color'] => {
      if (mapLayer === 'decompilation') {
        if (unit.coveragePercent === null) return 'unknown'
        if (unit.coveragePercent >= 100) return 'complete'
        return unit.coveragePercent > 0 ? 'partial' : 'none'
      }
      if (mapLayer === 'maintenance') return unit.maintainedSource ? 'complete' : 'none'
      if (unit.draftSource) return 'drafted'
      return unit.maintainedSource ? 'complete' : 'none'
    }
    const units = folderUnits.map((unit): FunctionMapCell => ({
      key: `unit:${unit.id}`,
      label: unit.name,
      detail: [languageLabel(unit), unit.address, formatBytes(unit.sizeBytes)].filter(Boolean).join(' · '),
      accessibleLabel: `${unit.name}, ${unit.unitType}, ${unit.coveragePercent === null ? 'decompilation completeness unmeasured' : `${Math.round(unit.coveragePercent)}% decompiled`}, ${unit.maintainedSource ? 'maintained source saved' : unit.draftSource ? 'draft saved for review' : 'needs reverse engineering'}`,
      color: colorFor(unit),
      selected: unit.id === selectedId,
      target: { kind: 'unit', unit },
    }))
    const members = visibleFunctionMapMembers.map((member): FunctionMapCell => {
      const parent = member.parentCodeUnit
      return {
        key: `function:${member.id}`,
        label: member.name,
        detail: [parent.name, member.language, member.address || (member.line ? `line ${member.line}` : null)].filter(Boolean).join(' · '),
        accessibleLabel: `${member.fullName}, ${member.memberKind} in ${parent.name}, ${parent.coveragePercent === null ? 'parent decompilation completeness unmeasured' : `${Math.round(parent.coveragePercent)}% parent coverage`}, ${parent.maintainedSource ? 'maintained source saved' : parent.draftSource ? 'draft saved for review' : 'needs reverse engineering'}`,
        color: colorFor(parent),
        selected: selectedFunctionMapMember?.id === member.id,
        target: { kind: 'member', member },
      }
    })
    return [...units, ...members]
  }, [folderUnits, mapLayer, selectedFunctionMapMember?.id, selectedId, visibleFunctionMapMembers])
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
  const listedSelectedUnit = folderUnits.find((unit) => unit.id === selectedId)
  const linkedSelectedUnit = linkedUnitQuery.data?.units.find((unit) => unit.id === selectedId)
  const selectedUnit = listedSelectedUnit
    ? {
      ...listedSelectedUnit,
      ...(linkedSelectedUnit ? {
        sourceAddressMap: linkedSelectedUnit.sourceAddressMap,
        sourceAddressMapTruncated: linkedSelectedUnit.sourceAddressMapTruncated,
        prototype: linkedSelectedUnit.prototype,
        recoveredVariables: linkedSelectedUnit.recoveredVariables,
        recoveredVariablesTruncated: linkedSelectedUnit.recoveredVariablesTruncated,
      } : {}),
    }
    : linkedSelectedUnit || (matchedUnitOverride?.id === selectedId ? matchedUnitOverride : undefined)
  const selectedLuaFunctionId = selectedFunctionMapMember?.hasControlFlowGraph
    && selectedFunctionMapMember.parentUnitId === selectedUnit?.id
    ? selectedFunctionMapMember.id
    : ''
  const selectedGhidraFunctionId = selectedUnit?.source === 'reamon-ghidra'
    && selectedUnit.unitType === 'function' && selectedUnit.controlFlowMetrics
    ? selectedUnit.id : ''
  const selectedControlFlowFunctionId = selectedLuaFunctionId || selectedGhidraFunctionId
  const functionControlFlowQuery = useQuery({
    queryKey: ['reamon-function-cfg', projectId, selectedLuaFunctionId ? selectedFunctionMapMember?.taskId || currentRunId : currentRunId, selectedControlFlowFunctionId],
    queryFn: ({ signal }) => fetchFunctionControlFlowGraph(projectId, (selectedLuaFunctionId ? selectedFunctionMapMember?.taskId || currentRunId : currentRunId) as string, selectedControlFlowFunctionId, signal),
    enabled: Boolean(currentRunId && selectedControlFlowFunctionId),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  })
  const selectedFunctionMapTarget = selectedFunctionMapMember && selectedFunctionMapMember.parentUnitId === selectedUnit?.id && selectedFunctionMapMember.similarityAvailable
    ? selectedFunctionMapMember.id
    : ''
  const selectedSimilarityTarget = selectedFunctionMapTarget || (selectedUnit?.unitType === 'function' ? selectedUnit.id : '')
  const selectedSimilarityTaskId = selectedFunctionMapTarget ? selectedFunctionMapMember?.taskId || currentRunId : currentRunId
  const similarFunctionsQuery = useQuery({
    queryKey: ['reamon-similar-functions', projectId, selectedSimilarityTaskId, selectedSimilarityTarget],
    queryFn: ({ signal }) => fetchSimilarFunctions(projectId, selectedSimilarityTaskId as string, selectedSimilarityTarget, signal),
    enabled: Boolean(currentRunId && selectedSimilarityTarget && selectedUnit?.source === currentRun?.providerId),
    staleTime: 5 * 60_000,
    gcTime: 60_000,
  })
  const savedFunctionMatchesQuery = useQuery({
    queryKey: ['reamon-function-matches', projectId, selectedSimilarityTaskId, selectedSimilarityTarget],
    queryFn: ({ signal }) => fetchSavedFunctionMatches(projectId, selectedSimilarityTaskId as string, selectedSimilarityTarget, signal),
    enabled: Boolean(currentRunId && selectedSimilarityTarget && selectedUnit?.source === currentRun?.providerId),
    staleTime: 30_000,
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
  const canCompareDecompilerOutputs = Boolean(selectedUnit
    && selectedUnit.inputArtifactSha256
    && selectedUnit.codeArtifactSha256)
  const alternateOutputsQuery = useQuery({
    queryKey: ['reamon-alternate-decompiler-outputs', projectId, selectedUnit?.id],
    queryFn: ({ signal }) => fetchAlternateDecompilerOutputs(projectId, selectedUnit?.id as string, signal),
    enabled: Boolean(compareAlternatesOpen && canCompareDecompilerOutputs && selectedUnit?.id),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  })
  const alternateOutputs = alternateOutputsQuery.data?.alternates || []
  const selectedAlternateOutput = alternateOutputs.find((output) => output.id === selectedAlternateId) || alternateOutputs[0]
  const alternateComparisonDiff = useMemo(() => compareDiffOpen && sourceQuery.data !== undefined && selectedAlternateOutput
    ? buildReviewDiff(sourceQuery.data, selectedAlternateOutput.source)
    : null, [compareDiffOpen, selectedAlternateOutput, sourceQuery.data])
  const disassemblyQuery = useQuery({
    queryKey: ['reamon-disassembly', selectedUnit?.id, selectedUnit?.disassemblyArtifactId],
    queryFn: ({ signal }) => fetchSource(selectedDisassemblyUrl as string, signal),
    enabled: Boolean(selectedDisassemblyUrl),
    staleTime: 5 * 60_000,
    gcTime: 60_000,
  })
  useEffect(() => { setSelectedEvidenceAddress(null) }, [selectedUnit?.id])
  const selectSourceAddress = useCallback((addresses: string[]) => {
    if (!addresses.length) return
    const currentIndex = selectedEvidenceAddress ? addresses.indexOf(selectedEvidenceAddress) : -1
    setSelectedEvidenceAddress(addresses[(currentIndex + 1) % addresses.length])
  }, [selectedEvidenceAddress])
  const smaliSourceQuery = useQuery({
    queryKey: ['reamon-maintained-smali', projectId, selectedUnit?.id],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit?.id || '')}/smali`, { signal, cache: 'no-store' })
      const result = await response.json().catch(() => ({})) as { sourceCode?: string; sourceHash?: string | null; exists?: boolean; error?: string; reviews?: CodeReviewRecord[] }
      if (!response.ok || typeof result.sourceCode !== 'string') throw new Error(result.error || 'Unable to load Smali source')
      return result as { sourceCode: string; sourceHash: string | null; acceptedReviewId?: string | null; exists: boolean; reviews?: CodeReviewRecord[] }
    },
    enabled: Boolean(selectedUnit?.disassemblyLanguage?.toLowerCase() === 'smali' && selectedUnit.disassemblyArtifactId),
    staleTime: 0,
    gcTime: 60_000,
  })
  const sourceByteLength = useMemo(() => sourceQuery.data === undefined ? null : new TextEncoder().encode(sourceQuery.data).byteLength, [sourceQuery.data])
  const largeSource = sourceByteLength !== null && sourceByteLength > MAX_MEMBER_REWRITE_BYTES
  const safeRenamePython = /^(python|python 3|python3)$/i.test(selectedUnit?.language || '')
  const safeRenamePhp = /^(php|php source)$/i.test(selectedUnit?.language || '')
  const safeRenameRuby = /^(ruby|ruby source|rb)$/i.test(selectedUnit?.language || '')
  const safeRenameGo = /^(go|golang)$/i.test(selectedUnit?.language || '')
  const safeRenameRust = /^(rust|rust source|rustlang)$/i.test(selectedUnit?.language || '')
  const safeRenameCpp = /^(c|c source|c\+\+|c\+\+ source|cpp|c\/c\+\+)$/i.test(selectedUnit?.language || '')
  const safeRenameJava = /^(java|java source)$/i.test(selectedUnit?.language || '')
  const safeRenameCSharp = /^(c#|csharp|cs)$/i.test(selectedUnit?.language || '')
  const safeRenameLua = /^(lua|lua source|lua(?: source)? 5\.[1-5])$/i.test(selectedUnit?.language || '')
  const safeRenameLuau = /^(luau|luau source)$/i.test(selectedUnit?.language || '')
  const safeRenameJavaScript = /^(javascript|typescript|jsx|tsx)$/i.test(selectedUnit?.language || '')
  const safeRenameSupported = safeRenamePython || safeRenamePhp || safeRenameRuby || safeRenameGo || safeRenameRust || safeRenameCpp || safeRenameJava || safeRenameCSharp || safeRenameLua || safeRenameLuau || safeRenameJavaScript
  const safeRenameSourceByteLength = new TextEncoder().encode(maintainedDraft || sourceQuery.data || '').byteLength
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
    || maintainedDraft.replace(/\r\n?/g, '\r\n').trim() !== sourceQuery.data.replace(/\r\n?/g, '\r\n').trim()
  const hasUnresolvedRebaseConflicts = containsUnresolvedMergeMarkers(maintainedDraft)
  const maintainedQuery = useQuery({
    queryKey: ['reamon-maintained-source', projectId, selectedUnit?.id],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit?.id || '')}`, { signal, cache: 'no-store' })
      if (!response.ok) throw new Error('Unable to load the maintained source copy')
      return response.json() as Promise<{
        exists: boolean
        sourceCode: string | null
        sourceHash?: string | null
        acceptedReviewId?: string | null
        updatedAt?: string
        reviews?: CodeReviewRecord[]
        acceptedRenameAliases?: AcceptedRenameAlias[]
        sourceLineage?: {
          baseSourceHash: string | null
          baseRunKey: string | null
          currentSourceHash: string | null
          baselineStatus: 'CURRENT' | 'CHANGED' | 'UNAVAILABLE' | 'UNRECORDED'
          baseSourceCode?: string | null
        }
      }>
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
    refetchInterval: (query) => query.state.data?.agentBatch?.attempts.some((attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING') ? 2000 : false,
  })
  const projectNoteQuery = useQuery({
    queryKey: ['reamon-code-note', projectId, selectedUnit?.id],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/notes/${encodeURIComponent(selectedUnit?.id || '')}`, { signal, cache: 'no-store' })
      if (!response.ok) throw new Error('Unable to load the saved code-unit note')
      return response.json() as Promise<CodeUnitNoteResponse>
    },
    enabled: Boolean(selectedUnit && selectedSourceUrl),
    staleTime: 0,
    gcTime: 60_000,
  })
  const noteResponse = projectNoteQuery.data
  const selectedNoteUnitId = selectedUnit?.id
  const visibleProjectNote = projectNoteDraft && projectNoteDraft.unitId === selectedNoteUnitId
    ? projectNoteDraft.note
    : noteResponse && noteResponse.unitId === selectedNoteUnitId ? noteResponse.note : ''
  useEffect(() => {
    if (!selectedNoteUnitId || !noteResponse || noteResponse.unitId !== selectedNoteUnitId) return
    setProjectNoteDraft({ unitId: selectedNoteUnitId, note: noteResponse.note })
  }, [noteResponse, selectedNoteUnitId])
  const maintainedBaselineStatus = maintainedQuery.data?.sourceLineage?.baselineStatus
  const maintainedBaselineNeedsReview = maintainedQuery.data?.exists && maintainedBaselineStatus !== 'CURRENT'
  const reviewBaselineSource = maintainedBaselineNeedsReview
    ? sourceQuery.data || ''
    : maintainedQuery.data?.exists && typeof maintainedQuery.data.sourceCode === 'string'
      ? maintainedQuery.data.sourceCode
      : sourceQuery.data || ''
  const reviewBaselineLabel = maintainedBaselineNeedsReview
    ? 'the current decompilation'
    : maintainedQuery.data?.exists ? 'the current saved maintained version' : 'the original decompilation'
  const normalizeReviewSource = (source: string) => source.replace(/\r\n?/g, '\r\n')
  const hasReviewDiff = Boolean(maintainedDraft.trim()) && normalizeReviewSource(reviewBaselineSource) !== normalizeReviewSource(maintainedDraft)
  const reviewDiff = showReviewDiff && hasReviewDiff ? buildReviewDiff(reviewBaselineSource, maintainedDraft) : null
  useEffect(() => {
    const unitId = selectedUnit?.id
    if (unitId) initializedMaintainedUnits.current.delete(unitId)
    setMaintainedSaved(false)
    setMaintenanceMeta(null)
    setMaintenanceError('')
    setSafeRenameSuggestions(null)
    setSelectedSafeRenameIds(new Set())
    setSafeRenameStatus('')
    setSuggestingSafeRenames(false)
    setApplyingSafeRenames(false)
    setReviewRationale('')
    setReviewStatus('')
    setRebaseStatus('')
    setLoadingMaintainedRevisionId(null)
    setRestoreReviewId(null)
    setShowReviewDiff(false)
    setMaintainedDraft('')
    setSmaliDraft('')
    setSmaliSaved(false)
    setSmaliReviewRationale('')
    setSmaliReviewStatus('')
    setLoadingSmaliRevisionId(null)
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
      && !selectedFunctionMapMember.hasControlFlowGraph
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
      setMaintenanceMeta({ sourceCode: savedDraft.sourceCode, providerName: savedDraft.providerName, model: savedDraft.modelIdentifier, syntaxValidated: savedDraft.syntaxValidated ?? undefined, validationStatus: savedDraft.validationStatus, validationMethod: savedDraft.validationMethod, validationMessage: savedDraft.validationMessage })
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
  function startMaintainedFromCurrentDecompilation() {
    if (typeof sourceQuery.data !== 'string') return
    setMaintainedDraft(sourceQuery.data)
    setRebaseStatus('')
    setRestoreReviewId(null)
    setMaintainedSaved(false)
    setMaintenanceMeta(null)
    setReviewRationale('')
    setReviewStatus('Started from the current decompilation. Reapply and review any maintained changes before accepting.')
  }
  function rebaseMaintainedChanges() {
    const baseline = maintainedQuery.data?.sourceLineage?.baseSourceCode
    const currentSource = sourceQuery.data
    if (maintainedBaselineStatus !== 'CHANGED' || typeof baseline !== 'string' || typeof currentSource !== 'string' || !maintainedDraft.trim()) return
    const merged = mergeDiff3(
      sourceLines(maintainedDraft),
      sourceLines(baseline),
      sourceLines(currentSource),
      {
        excludeFalseConflicts: true,
        label: { a: 'saved maintained copy', o: 'accepted baseline', b: 'current decompilation' },
      },
    )
    const lineEnding = currentSource.includes('\r\n') ? '\r\n' : '\n'
    setMaintainedDraft(merged.result.join('\n').replace(/\n/g, lineEnding))
    setMaintainedSaved(false)
    setRestoreReviewId(null)
    setJvmBuild(null)
    setMaintenanceMeta(null)
    setReviewRationale('')
    setMaintenanceError('')
    setRebaseStatus(merged.conflict
      ? 'Overlapping edits were marked in the editor. Resolve every marked section before saving a draft or accepting this source.'
      : 'Independent saved edits were reapplied to the current decompilation. Review the diff and validate the result before accepting it.')
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
  const selectedReviewerProviderId = explanationProviders.some((provider) => provider.id === reviewerProviderId)
    ? reviewerProviderId
    : ''
  async function saveFunctionMatch(taskBId: string, functionBId: string, candidateKey: string) {
    if (!selectedSimilarityTaskId || !selectedSimilarityTarget) return
    setSavingFunctionMatchKey(candidateKey)
    setFunctionMatchActionError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/function-matches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskAId: selectedSimilarityTaskId, functionAId: selectedSimilarityTarget, taskBId, functionBId }),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not save this function comparison')
      await queryClient.invalidateQueries({ queryKey: ['reamon-function-matches', projectId, selectedSimilarityTaskId, selectedSimilarityTarget] })
    } catch (error) {
      setFunctionMatchActionError(error instanceof Error ? error.message : 'Could not save this function comparison')
    } finally {
      setSavingFunctionMatchKey(null)
    }
  }

  async function reviewFunctionMatch(matchId: string, decision: 'ACCEPTED' | 'REJECTED') {
    setSavingFunctionMatchKey(matchId)
    setFunctionMatchActionError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/function-matches/${encodeURIComponent(matchId)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not save this match review')
      await queryClient.invalidateQueries({ queryKey: ['reamon-function-matches', projectId, selectedSimilarityTaskId, selectedSimilarityTarget] })
    } catch (error) {
      setFunctionMatchActionError(error instanceof Error ? error.message : 'Could not save this match review')
    } finally {
      setSavingFunctionMatchKey(null)
    }
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
        body: JSON.stringify({
          unitId: selectedUnit.id,
          ...(selectedFunctionMapMember?.parentUnitId === selectedUnit.id ? { functionId: selectedFunctionMapMember.id } : {}),
          providerId: selectedProviderId,
          question: question.trim(),
        }),
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

  async function saveProjectNote() {
    if (!selectedUnit) return
    setSavingProjectNote(true)
    setProjectNoteError('')
    setProjectNoteStatus('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/notes/${encodeURIComponent(selectedUnit.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: visibleProjectNote }),
      })
      const result = await response.json().catch(() => ({})) as CodeUnitNoteResponse & { error?: string }
      if (!response.ok || result.unitId !== selectedUnit.id) throw new Error(result.error || 'Could not save the project note')
      setProjectNoteDraft({ unitId: selectedUnit.id, note: result.note })
      queryClient.setQueryData(['reamon-code-note', projectId, selectedUnit.id], result)
      setProjectNoteStatus(result.note ? 'Saved in project memory for this code unit.' : 'Project note cleared.')
    } catch (error) {
      setProjectNoteError(error instanceof Error ? error.message : 'Could not save the project note')
    } finally {
      setSavingProjectNote(false)
    }
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
      body: JSON.stringify({ sourceCode, sourceAttemptId: meta.attemptId ?? null, providerName: meta.providerName, model: meta.model, question: draftQuestion, scope, syntaxValidated: meta.syntaxValidated ?? null, validationStatus: meta.validationStatus ?? null, validationMethod: meta.validationMethod ?? null, validationMessage: meta.validationMessage ?? null }),
    })
    const result = await response.json().catch(() => ({})) as { error?: string; draftId?: string; sourceAttemptId?: string | null; updatedAt?: string }
    if (!response.ok || !result.draftId || !result.updatedAt) throw new Error(result.error || 'Could not save this AI draft to project memory')
    const record: CodeDraftRecord = { id: result.draftId, sourceCode, sourceAttemptId: result.sourceAttemptId ?? meta.attemptId ?? null, providerName: meta.providerName, modelIdentifier: meta.model, question: draftQuestion, scope, syntaxValidated: meta.syntaxValidated ?? null, validationStatus: meta.validationStatus ?? null, validationMethod: meta.validationMethod ?? null, validationMessage: meta.validationMessage ?? null, updatedAt: result.updatedAt }
    setDraftId(record.id)
    setDraftSource(sourceCode)
    setDraftScope(scope)
    queryClient.setQueryData<CodeDraftResponse>(['reamon-code-draft', projectId, selectedUnit.id], (current) => ({ exists: true, draft: record, attempts: current?.attempts }))
    return record.id
  }

  async function waitForCodeRewrite(response: Response, unitId: string): Promise<CodeMaintenanceResponse> {
    const initial = await response.json().catch(() => ({})) as CodeMaintenanceResponse & { status?: string; error?: string }
    if (!response.ok) throw new Error(initial.error || 'Could not create a maintainable version')
    if (response.status !== 202) return initial
    if (!initial.attemptId) throw new Error('The rewrite job was queued without an attempt ID')

    setActiveRewriteAttemptId(initial.attemptId)
    const deadline = Date.now() + 10 * 60_000
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const statusResponse = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate/attempts/${encodeURIComponent(initial.attemptId)}`, { cache: 'no-store' })
        const status = await statusResponse.json().catch(() => ({})) as CodeMaintenanceResponse & { status?: string; cancelRequested?: boolean; error?: string }
        if (!statusResponse.ok) throw new Error(status.error || 'Could not load the rewrite job status')
        if (status.status === 'FAILED') throw new Error(status.error || 'The rewrite attempt failed')
        if (status.status === 'CANCELLED') throw new Error(status.error || 'The rewrite was cancelled')
        if (status.status === 'SUCCEEDED' && typeof status.sourceCode === 'string') return status
      }
      throw new Error(`Rewrite attempt ${initial.attemptId} is still queued or running. It remains saved in this unit's attempt history.`)
    } finally {
      setActiveRewriteAttemptId((current) => current === initial.attemptId ? null : current)
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, unitId] })
    }
  }

  async function cancelActiveCodeRewrite() {
    if (!selectedUnit || !activeRewriteAttemptId) return
    setCancellingRewrite(true)
    setMaintenanceError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate/attempts/${encodeURIComponent(activeRewriteAttemptId)}/cancel`, { method: 'POST' })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not cancel the rewrite')
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not cancel the rewrite')
    } finally {
      setCancellingRewrite(false)
    }
  }

  async function cancelFunctionAgentBatch(batchId: string) {
    if (!selectedUnit || agentTeamDispatching || cancellingAgentBatch) return
    setCancellingAgentBatch(true)
    setMaintenanceError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate/batches/${encodeURIComponent(batchId)}/cancel`, { method: 'POST' })
      const result = await response.json().catch(() => ({})) as { cancelledQueued?: number; cancelRequestedRunning?: number; remaining?: number; error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not cancel the function agent batch')
      setMaintenanceError(`${result.cancelledQueued ?? 0} queued function agent${result.cancelledQueued === 1 ? '' : 's'} cancelled; cancellation requested for ${result.cancelRequestedRunning ?? 0} running agent${result.cancelRequestedRunning === 1 ? '' : 's'}.${result.remaining ? ` ${result.remaining} still settling.` : ''}`)
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnit.id] })
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not cancel the function agent batch')
    } finally {
      setCancellingAgentBatch(false)
    }
  }

  async function restoreCodeAttempt(attempt: CodeAttemptRecord) {
    if (!selectedUnit || attempt.status !== 'SUCCEEDED' || !attempt.resultSource) return
    setRestoringAttemptId(attempt.id)
    setMaintenanceError('')
    try {
      let sourceCode = attempt.resultSource
      if (attempt.scope === 'member') {
        const baseSource = maintainedDraft || sourceQuery.data
        if (!baseSource) {
          throw new Error('This member result is missing its exact input. Reload the source before restoring it.')
        }
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate/attempts/${encodeURIComponent(attempt.id)}`, { cache: 'no-store' })
        const result = await response.json().catch(() => ({})) as { status?: string; inputSource?: string; error?: string }
        if (!response.ok || result.status !== 'SUCCEEDED' || !result.inputSource) {
          throw new Error(result.error || 'This member result is missing its exact input. Reload the source before restoring it.')
        }
        const firstMatch = baseSource.indexOf(result.inputSource)
        if (firstMatch < 0 || baseSource.indexOf(result.inputSource, firstMatch + 1) >= 0) {
          throw new Error('The original member is no longer uniquely present in the editable source. Review the result and merge it manually.')
        }
        sourceCode = `${baseSource.slice(0, firstMatch)}${attempt.resultSource}${baseSource.slice(firstMatch + result.inputSource.length)}`
      }
      const meta: CodeMaintenanceResponse = {
        sourceCode,
        providerName: attempt.providerName,
        model: attempt.modelIdentifier,
        attemptId: attempt.id,
        syntaxValidated: attempt.syntaxValidated,
        validationStatus: attempt.validationStatus,
        validationMethod: attempt.validationMethod,
        validationMessage: attempt.validationMessage,
      }
      setMaintainedDraft(sourceCode)
      setMaintenanceMeta(meta)
      revealMaintainedEditor()
      setMaintainedSaved(false)
      setDraftId(null)
      setDraftSource(null)
      setDraftScope(null)
      try {
        await persistCodeDraft(sourceCode, meta, attempt.scope === 'member' ? 'member' : 'file')
      } catch (error) {
        setMaintenanceError(`The completed result is loaded in the editor, but could not be saved to project memory: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not restore this completed result')
    } finally {
      setRestoringAttemptId(null)
    }
  }

  async function saveCodeDraft(): Promise<boolean> {
    if (!selectedUnit || !maintainedDraft.trim()) return false
    if (hasUnresolvedRebaseConflicts) {
      setMaintenanceError('Resolve all three-way merge conflict markers before saving this draft.')
      return false
    }
    const configuredProvider = explanationProviders.find((provider) => provider.id === selectedProviderId)
    const providerName = maintenanceMeta?.providerName || configuredProvider?.name
    const model = maintenanceMeta?.model || configuredProvider?.modelIdentifier
    if (!providerName || !model) {
      setMaintenanceError('Choose a saved AI provider before saving this draft to project memory.')
      return false
    }
    setSavingDraft(true)
    setMaintenanceError('')
    try {
      const existingDraftId = draftId
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/drafts/${encodeURIComponent(selectedUnit.id)}`, {
        method: existingDraftId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existingDraftId
          ? { draftId: existingDraftId, sourceCode: maintainedDraft }
          : { sourceCode: maintainedDraft, sourceAttemptId: maintenanceMeta?.attemptId ?? null, providerName, model, question: question.trim(), scope: 'file', syntaxValidated: null, validationStatus: null, validationMethod: null, validationMessage: null }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string; draftId?: string; sourceAttemptId?: string | null; updatedAt?: string }
      if (!response.ok || (!existingDraftId && !result.draftId) || !result.updatedAt) throw new Error(result.error || 'Could not save this draft to project memory')
      const record: CodeDraftRecord = {
        id: result.draftId || existingDraftId as string,
        sourceCode: maintainedDraft,
        sourceAttemptId: existingDraftId ? codeDraftQuery.data?.draft?.sourceAttemptId ?? null : result.sourceAttemptId ?? maintenanceMeta?.attemptId ?? null,
        providerName,
        modelIdentifier: model,
        question: question.trim(),
        scope: existingDraftId ? draftScope || 'file' : 'file',
        syntaxValidated: null,
        validationStatus: null,
        validationMethod: null,
        validationMessage: null,
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
      return true
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not save this draft to project memory')
      return false
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
        body: JSON.stringify({ unitId: selectedUnit.id, providerId: selectedProviderId, ...(selectedReviewerProviderId ? { reviewerProviderId: selectedReviewerProviderId } : {}), question: question.trim() }),
      })
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnit.id] })
      const result = await waitForCodeRewrite(response, selectedUnit.id)
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

  async function suggestSafeRenames() {
    const workingSource = maintainedDraft || sourceQuery.data
    if (!selectedUnit || !selectedProviderId || !workingSource) return
    setSuggestingSafeRenames(true)
    setMaintenanceError('')
    setSafeRenameStatus('')
    setSafeRenameSuggestions(null)
    setSelectedSafeRenameIds(new Set())
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/safe-renames`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'suggest', unitId: selectedUnit.id, providerId: selectedProviderId, sourceCode: workingSource, question: question.trim() }),
      })
      const result = await response.json().catch(() => ({})) as SafeRenameSuggestions & { error?: string }
      if (!response.ok || typeof result.sourceSha256 !== 'string' || result.providerId !== selectedProviderId || typeof result.attemptId !== 'string' || typeof result.projectSymbolContextSha256 !== 'string' || !Array.isArray(result.renames)) {
        throw new Error(result.error || 'Could not suggest scope-safe rename candidates')
      }
      setSafeRenameSuggestions(result)
      setSelectedSafeRenameIds(new Set(result.renames.map((proposal) => proposal.bindingId)))
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnit.id] })
      if (!result.renames.length) setSafeRenameStatus('No lexical binding names were clear enough to suggest from this source and reviewed project memory.')
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not suggest scope-safe rename candidates')
    } finally {
      setSuggestingSafeRenames(false)
    }
  }

  async function applySelectedSafeRenames() {
    const workingSource = maintainedDraft || sourceQuery.data
    if (!selectedUnit || !selectedProviderId || !safeRenameSuggestions || !workingSource) return
    const renames = safeRenameSuggestions.renames.filter((proposal) => selectedSafeRenameIds.has(proposal.bindingId))
    if (!renames.length) return
    setApplyingSafeRenames(true)
    setMaintenanceError('')
    setSafeRenameStatus('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/safe-renames`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'apply', unitId: selectedUnit.id, providerId: selectedProviderId, sourceCode: workingSource, expectedSha256: safeRenameSuggestions.sourceSha256, suggestionAttemptId: safeRenameSuggestions.attemptId, renames }),
      })
      const result = await response.json().catch(() => ({})) as CodeMaintenanceResponse & { error?: string; outputSha256?: string; renamedBindings?: Array<{ oldName: string; newName: string }> }
      if (!response.ok || typeof result.sourceCode !== 'string' || !result.attemptId) {
        throw new Error(result.error || 'Could not apply the selected safe renames')
      }
      setMaintainedDraft(result.sourceCode)
      setMaintenanceMeta(result)
      setMaintainedSaved(false)
      setDraftId(null)
      setDraftSource(null)
      setDraftScope('file')
      const draftId = await persistCodeDraft(result.sourceCode, result, 'file')
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnit.id] })
      setSafeRenameSuggestions(null)
      setSelectedSafeRenameIds(new Set())
      setSafeRenameStatus(`Applied ${result.renamedBindings?.length || renames.length} scope-safe rename${(result.renamedBindings?.length || renames.length) === 1 ? '' : 's'}; draft ${draftId} is saved for review.`)
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not apply the selected safe renames')
    } finally {
      setApplyingSafeRenames(false)
    }
  }

  async function loadSavedSafeRenames(attempt: CodeAttemptRecord) {
    const workingSource = maintainedDraft || sourceQuery.data
    if (!selectedUnit || !workingSource || !attempt.renameProposals?.length || !attempt.proposalSourceSha256
        || !attempt.proposalProviderId || !attempt.projectSymbolContextSha256) return
    if (selectedProviderId !== attempt.proposalProviderId) {
      setSafeRenameStatus('Select the provider used for this saved proposal before loading it.')
      return
    }
    try {
      const sourceBytes = new TextEncoder().encode(workingSource)
      const sourceDigest = await window.crypto.subtle.digest('SHA-256', sourceBytes)
      const sourceSha256 = Array.from(new Uint8Array(sourceDigest), (value) => value.toString(16).padStart(2, '0')).join('')
      if (sourceSha256 !== attempt.proposalSourceSha256) {
        setSafeRenameStatus('This saved proposal belongs to a different source version. Restore that source version or generate new suggestions.')
        return
      }
      setSafeRenameSuggestions({
        sourceSha256,
        providerId: attempt.proposalProviderId,
        providerName: attempt.providerName,
        model: attempt.modelIdentifier,
        attemptId: attempt.id,
        projectSymbolContextSha256: attempt.projectSymbolContextSha256,
        candidates: attempt.proposalCandidateCount ?? attempt.renameProposals.length,
        renames: attempt.renameProposals,
      })
      setSelectedSafeRenameIds(new Set(attempt.renameProposals.map((proposal) => proposal.bindingId)))
      setSafeRenameStatus('Loaded saved proposals. Review the selections before applying them.')
      setMaintenanceError('')
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not verify the saved proposal source')
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
        body: JSON.stringify({ unitId: selectedUnit.id, providerId: selectedProviderId, ...(selectedReviewerProviderId ? { reviewerProviderId: selectedReviewerProviderId } : {}), question: question.trim(), scope: 'member', startByte: member.start_byte, endByte: member.end_byte, memberName: member.name }),
      })
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnit.id] })
      const result = await waitForCodeRewrite(response, selectedUnit.id)
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

  async function runAgentTeam(members: CodeMemberOutline[]) {
    if (!selectedUnit || !selectedProviderId || !sourceQuery.data || transforming || members.length === 0 || members.length > 10) return
    const byRange = [...members].sort((left, right) => left.start_byte - right.start_byte)
    for (let index = 1; index < byRange.length; index += 1) {
      if (byRange[index].start_byte < byRange[index - 1].end_byte) {
        setMaintenanceError('Nested functions overlap in the source outline. Run one of the overlapping functions at a time.')
        return
      }
    }
    const baseline = sourceQuery.data
    const draft = maintainedDraft || baseline
    if (draft.replace(/\r\n?/g, '\n') !== baseline.replace(/\r\n?/g, '\n')) {
      setMaintenanceError('Save or reset the maintained copy to the current decompilation before starting a function team. The team needs stable function ranges to merge results safely.')
      return
    }
    const selectedUnitId = selectedUnit.id
    const agentBatchId = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    setAgentTeamRunning(true)
    setAgentTeamDispatching(true)
    setMaintenanceError('')
    try {
      const queueResults = await Promise.allSettled(members.map(async (member) => {
        const key = `${member.start_byte}:${member.end_byte}`
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unitId: selectedUnitId, providerId: selectedProviderId, ...(selectedReviewerProviderId ? { reviewerProviderId: selectedReviewerProviderId } : {}), question: question.trim(), scope: 'member', startByte: member.start_byte, endByte: member.end_byte, memberName: member.name, agentBatchId }),
        })
        const result = await response.json().catch(() => ({})) as { attemptId?: string; status?: string; error?: string }
        if (!response.ok || !result.attemptId) throw new Error(`${member.name}: ${result.error || 'Could not queue function rewrite'}`)
        return { member, key, attemptId: result.attemptId }
      }))
      setAgentTeamDispatching(false)
      const queued = queueResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      const failures = queueResults.flatMap((result) => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : 'Could not queue a function rewrite'] : [])
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnitId] })
      const pending = new Map(queued.map((item) => [item.attemptId, item]))
      const completed: Array<{ member: CodeMemberOutline; key: string; result: CodeMaintenanceResponse & { inputSource?: string } }> = []
      const deadline = Date.now() + 10 * 60_000
      while (pending.size && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const updates = await Promise.all([...pending.entries()].map(async ([attemptId, item]) => {
          try {
            const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate/attempts/${encodeURIComponent(attemptId)}`, { cache: 'no-store' })
            const status = await response.json().catch(() => ({})) as CodeMaintenanceResponse & { status?: string; inputSource?: string; error?: string }
            if (!response.ok) throw new Error(status.error || `Could not read status for ${item.member.name}`)
            return { attemptId, item, status }
          } catch (error) {
            return { attemptId, item, error }
          }
        }))
        for (const update of updates) {
          if ('error' in update) {
            failures.push(update.error instanceof Error ? update.error.message : `Could not read status for ${update.item.member.name}`)
            pending.delete(update.attemptId)
            continue
          }
          const { attemptId, item, status } = update
          if (status.status === 'SUCCEEDED' && typeof status.sourceCode === 'string') {
            completed.push({ member: item.member, key: item.key, result: { ...status, attemptId } })
            pending.delete(attemptId)
          } else if (status.status === 'FAILED' || status.status === 'CANCELLED') {
            failures.push(`${item.member.name}: ${status.error || 'Rewrite failed'}`)
            pending.delete(attemptId)
          }
        }
      }
      if (pending.size) failures.push(`${pending.size} function rewrite${pending.size === 1 ? '' : 's'} still queued or running; their attempts remain in project history.`)
      if (completed.length) {
        const bytes = new TextEncoder().encode(draft)
        const ordered = [...completed].sort((left, right) => right.member.start_byte - left.member.start_byte)
        let merged = bytes
        for (const { member, result } of ordered) {
          const currentSlice = new TextDecoder().decode(merged.subarray(member.start_byte, member.end_byte))
          if (result.inputSource === undefined || currentSlice !== result.inputSource) throw new Error(`The source for ${member.name} changed while the team was running, so results were kept in attempt history and not merged.`)
          const replacement = new TextEncoder().encode(result.sourceCode)
          const updated = new Uint8Array(merged.byteLength - (member.end_byte - member.start_byte) + replacement.byteLength)
          updated.set(merged.subarray(0, member.start_byte), 0)
          updated.set(replacement, member.start_byte)
          updated.set(merged.subarray(member.end_byte), member.start_byte + replacement.byteLength)
          merged = updated
        }
        const mergedDraft = new TextDecoder().decode(merged)
        const meta = completed[0].result
        setMaintainedDraft(mergedDraft)
        setMaintenanceMeta(meta)
        setMaintainedSaved(false)
        setRewrittenMembers((current) => new Set([...current, ...completed.map((item) => item.key)]))
        revealMaintainedEditor()
        try {
          await persistCodeDraft(mergedDraft, meta, 'member')
        } catch (error) {
          failures.push(`Results are in the editor, but saving project memory failed: ${error instanceof Error ? error.message : 'unknown error'}`)
        }
      }
      if (failures.length) setMaintenanceError(failures.join(' '))
      setSelectedAgentMembers(new Set())
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnitId] })
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'The function team could not complete')
    } finally {
      setAgentTeamRunning(false)
      setAgentTeamDispatching(false)
    }
  }

  async function applySavedFunctionAgentResults() {
    const batch = codeDraftQuery.data?.agentBatch
    if (!selectedUnit || !sourceQuery.data || !batch || agentTeamRunning) return
    if (batch.attempts.some((attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING')) {
      setMaintenanceError('Wait until every function agent in this batch has finished before applying the saved results.')
      return
    }
    if (maintainedDraftDiffersFromSource) {
      setMaintenanceError('Reset the maintained editor to the current decompilation before applying saved function-agent results.')
      return
    }
    const completed = batch.attempts.filter((attempt) => attempt.status === 'SUCCEEDED' && attempt.resultSource !== null)
    if (!completed.length) return
    const ordered = [...completed].sort((left, right) => (right.memberStartByte ?? -1) - (left.memberStartByte ?? -1))
    for (let index = 0; index < ordered.length; index += 1) {
      const item = ordered[index]
      if (item.memberStartByte === null || item.memberEndByte === null || item.inputSource === null || !item.resultSource) {
        setMaintenanceError(`Saved source ranges for ${item.memberName} are unavailable. The individual result remains in attempt history.`)
        return
      }
      const next = ordered[index + 1]
      if (next?.memberEndByte !== null && next?.memberEndByte !== undefined && item.memberStartByte < next.memberEndByte) {
        setMaintenanceError('These saved functions overlap in the source outline. Load their results one at a time instead.')
        return
      }
    }
    setMaintenanceError('')
    const draftBytes = new TextEncoder().encode(sourceQuery.data)
    let merged = draftBytes
    for (const item of ordered) {
      const start = item.memberStartByte as number
      const end = item.memberEndByte as number
      if (new TextDecoder().decode(merged.subarray(start, end)) !== item.inputSource) {
        setMaintenanceError(`The current source range for ${item.memberName} no longer matches its saved attempt. Results remain in history and were not merged.`)
        return
      }
      const replacement = new TextEncoder().encode(item.resultSource as string)
      const updated = new Uint8Array(merged.byteLength - (end - start) + replacement.byteLength)
      updated.set(merged.subarray(0, start), 0)
      updated.set(replacement, start)
      updated.set(merged.subarray(end), start + replacement.byteLength)
      merged = updated
    }
    const mergedDraft = new TextDecoder().decode(merged)
    const sourceAttempt = ordered[0]
    const meta: CodeMaintenanceResponse = { sourceCode: mergedDraft, attemptId: sourceAttempt.id, providerName: sourceAttempt.providerName, model: sourceAttempt.modelIdentifier }
    setMaintainedDraft(mergedDraft)
    setMaintenanceMeta(meta)
    setMaintainedSaved(false)
    setRewrittenMembers((current) => new Set([...current, ...completed.flatMap((attempt) => attempt.memberStartByte !== null && attempt.memberEndByte !== null ? [`${attempt.memberStartByte}:${attempt.memberEndByte}`] : [])]))
    revealMaintainedEditor()
    try {
      await persistCodeDraft(mergedDraft, meta, 'member')
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-draft', projectId, selectedUnit.id] })
    } catch (error) {
      setMaintenanceError(`Results are in the editor, but could not be saved to project memory: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  async function loadAcceptedMaintainedRevision(review: CodeReviewRecord) {
    if (!selectedUnit || review.decision !== 'ACCEPTED' || !review.sourceAvailable) return
    const currentEditorBaseline = maintainedQuery.data?.sourceCode ?? sourceQuery.data ?? ''
    if (maintainedDraft !== currentEditorBaseline
        && !window.confirm('Replace the current editor contents with this accepted source version? Unsaved changes will be lost.')) return
    const unitId = selectedUnit.id
    setLoadingMaintainedRevisionId(review.id)
    setMaintenanceError('')
    setReviewStatus('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(unitId)}?revision=${encodeURIComponent(review.id)}`, { cache: 'no-store' })
      const result = await response.json().catch(() => ({})) as { sourceCode?: string; error?: string }
      if (!response.ok || typeof result.sourceCode !== 'string') throw new Error(result.error || 'Could not load the accepted source version')
      if (selectedUnit?.id !== unitId) return
      setMaintainedDraft(result.sourceCode)
      setRestoreReviewId(review.id)
      setReviewRationale('')
      setMaintainedSaved(false)
      setMaintenanceMeta(null)
      setReviewStatus('Loaded the earlier accepted source. Review the diff and enter a rationale before accepting it as a new version.')
    } catch (error) {
      if (selectedUnit?.id === unitId) setMaintenanceError(error instanceof Error ? error.message : 'Could not load the accepted source version')
    } finally {
      setLoadingMaintainedRevisionId((current) => current === review.id ? null : current)
    }
  }

  async function loadAcceptedSmaliRevision(review: CodeReviewRecord) {
    if (!selectedUnit || review.decision !== 'ACCEPTED' || !review.sourceAvailable) return
    if (smaliDraft !== (smaliSourceQuery.data?.sourceCode ?? '')
        && !window.confirm('Replace the current Smali editor contents with this accepted version? Unsaved changes will be lost.')) return
    const unitId = selectedUnit.id
    setLoadingSmaliRevisionId(review.id)
    setSmaliError('')
    setSmaliReviewStatus('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(unitId)}/smali?revision=${encodeURIComponent(review.id)}`, { cache: 'no-store' })
      const result = await response.json().catch(() => ({})) as { sourceCode?: string; error?: string }
      if (!response.ok || typeof result.sourceCode !== 'string') throw new Error(result.error || 'Could not load the accepted Smali version')
      if (selectedUnit?.id !== unitId) return
      setSmaliDraft(result.sourceCode)
      setSmaliReviewRationale('')
      setSmaliSaved(false)
      setSmaliReviewStatus('Loaded the earlier accepted Smali source. Review it and enter a rationale before accepting it as a new version.')
    } catch (error) {
      if (selectedUnit?.id === unitId) setSmaliError(error instanceof Error ? error.message : 'Could not load the accepted Smali version')
    } finally {
      setLoadingSmaliRevisionId((current) => current === review.id ? null : current)
    }
  }

  async function saveMaintainedSource() {
    if (!selectedUnit || !maintainedDraft.trim()) return
    if (hasUnresolvedRebaseConflicts) {
      setMaintenanceError('Resolve all three-way merge conflict markers before accepting this source.')
      return
    }
    setSavingMaintained(true)
    setMaintenanceError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceCode: maintainedDraft, reviewRationale, expectedSourceHash: maintainedQuery.data?.sourceHash ?? null, ...(restoreReviewId ? { restoreReviewId } : {}) }),
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
      setRestoreReviewId(null)
      setReviewRationale('')
      setReviewStatus('')
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-coverage', projectId, currentRunId] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-source', projectId, selectedUnit.id] })
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not save the maintained source')
    } finally {
      setSavingMaintained(false)
    }
  }

  async function rejectMaintainedDraft() {
    if (!selectedUnit || !maintainedDraft.trim()) return
    if (reviewRationale.trim().length < 12 || reviewRationale.trim().length > 1000) {
      setMaintenanceError('Add between 12 and 1000 characters explaining why this draft was rejected.')
      return
    }
    setSavingMaintained(true)
    setMaintenanceError('')
    setReviewStatus('')
    try {
      if (draftSource !== maintainedDraft && !await saveCodeDraft()) return
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceCode: maintainedDraft, reviewRationale }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not record this rejection')
      setReviewRationale('')
      setReviewStatus('Rejection recorded. This reviewer feedback will guide future rewrites of this code unit.')
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-source', projectId, selectedUnit.id] })
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not record this rejection')
    } finally {
      setSavingMaintained(false)
    }
  }

  async function revokeMaintainedAcceptance() {
    if (!selectedUnit || !maintainedQuery.data?.acceptedReviewId || !maintainedQuery.data.sourceHash) return
    if (reviewRationale.trim().length < 12 || reviewRationale.trim().length > 1000) {
      setMaintenanceError('Add between 12 and 1000 characters explaining why this acceptance was revoked.')
      return
    }
    setSavingMaintained(true)
    setMaintenanceError('')
    setReviewStatus('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedSourceHash: maintainedQuery.data.sourceHash, reviewRationale }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not revoke this acceptance')
      setReviewRationale('')
      setReviewStatus('Acceptance revoked. This source and its naming context will no longer be treated as approved project memory.')
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-coverage', projectId, currentRunId] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-source', projectId, selectedUnit.id] })
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Could not revoke this acceptance')
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
        body: JSON.stringify({ sourceCode: smaliDraft, reviewRationale: smaliReviewRationale, expectedSourceHash: smaliSourceQuery.data?.sourceHash ?? null }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string; validationMessage?: string }
      if (!response.ok) throw new Error([result.error, result.validationMessage].filter(Boolean).join(' ')
        || 'Could not save Smali source')
      setSmaliSaved(true)
      setSmaliReviewRationale('')
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-smali', projectId, selectedUnit.id] })
    } catch (error) {
      setSmaliError(error instanceof Error ? error.message : 'Could not save Smali source')
    } finally {
      setSavingSmali(false)
    }
  }

  async function revokeSmaliAcceptance() {
    if (!selectedUnit || !smaliSourceQuery.data?.acceptedReviewId || !smaliSourceQuery.data.sourceHash) return
    if (smaliReviewRationale.trim().length < 12 || smaliReviewRationale.trim().length > 1000) {
      setSmaliError('Add between 12 and 1000 characters explaining why this acceptance was revoked.')
      return
    }
    setSavingSmali(true)
    setSmaliError('')
    setSmaliReviewStatus('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit.id)}/smali`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedSourceHash: smaliSourceQuery.data.sourceHash, reviewRationale: smaliReviewRationale }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not revoke Smali acceptance')
      setSmaliReviewRationale('')
      setSmaliReviewStatus('Acceptance revoked. This Smali source will no longer be treated as approved project memory.')
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-smali', projectId, selectedUnit.id] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
      await queryClient.invalidateQueries({ queryKey: ['reamon-maintained-coverage', projectId, currentRunId] })
    } catch (error) {
      setSmaliError(error instanceof Error ? error.message : 'Could not revoke Smali acceptance')
    } finally {
      setSavingSmali(false)
    }
  }

  function openTreemapEntry(entry: CodeUnitTreemapEntry) {
    setSelectedFunctionMapMember(null)
    if (entry.folderPath) {
      setFolderPath(entry.folderPath)
      setSelectedId(null)
      setExplanation(null)
      setExplainError('')
      return
    }
    if (!entry.codeUnit) return
    setSelectedId(entry.codeUnit.id)
    revealUnitInspector()
    setCopyStatus('')
    setAssemblyCopyStatus('')
    setExplanation(null)
    setExplainError('')
  }

  function selectFunctionMapCell(cell: FunctionMapCell) {
    if (cell.target.kind === 'unit') {
      const unit = cell.target.unit
      openTreemapEntry({
        key: `unit:${unit.id}`, name: unit.name, sizeBytes: unit.sizeBytes,
        coveragePercent: unit.coveragePercent, codeUnit: unit, unitCount: 1,
        maintainedUnitCount: unit.maintainedSource ? 1 : 0, draftedUnitCount: unit.draftSource ? 1 : 0,
      })
      return
    }
    const { member } = cell.target
    const parent = member.parentCodeUnit
    openTreemapEntry({
      key: `unit:${parent.id}`, name: parent.name, sizeBytes: parent.sizeBytes,
      coveragePercent: parent.coveragePercent, codeUnit: parent, unitCount: 1,
      maintainedUnitCount: parent.maintainedSource ? 1 : 0, draftedUnitCount: parent.draftSource ? 1 : 0,
    })
    setSelectedFunctionMapMember({
      id: member.id, parentUnitId: parent.id,
      name: member.name.replace(/#\d+$/, ''),
      similarityAvailable: member.similarityAvailable,
      hasControlFlowGraph: member.hasControlFlowGraph,
    })
  }

  function showFolder(path: string[]) {
    setFolderPath(path)
    setSelectedId(null)
    setExplanation(null)
    setExplainError('')
  }

  function showMaintenanceFilter(value: 'all' | 'needs-work' | 'drafted' | 'maintained') {
    setMaintenanceFilter(value)
    setSelectedId(null)
    setSelectedFunctionMapMember(null)
  }

  const loadMoreUnits = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError('')
    try {
      const page = await fetchCodeUnits(projectId, currentRunId, nextCursor, undefined, serverSearch)
      const loadedUnits = [...(pageState?.units || []), ...page.units]
      const byFunctionId = new Map((pageState?.functionMapMembers || query.data?.functionMapMembers || []).map((member) => [member.id, member]))
      for (const member of page.functionMapMembers || []) byFunctionId.set(member.id, member)
      const allFunctionMembers = [...byFunctionId.values()]
      setAdditionalPage({
        runId: currentRunId,
        search: serverSearch,
        units: loadedUnits,
        functionMapMembers: allFunctionMembers.slice(0, FUNCTION_MAP_CLIENT_LIMIT),
        functionMapTruncated: Boolean(pageState?.functionMapTruncated || query.data?.functionMapTruncated || page.functionMapTruncated || allFunctionMembers.length > FUNCTION_MAP_CLIENT_LIMIT),
        nextCursor: page.nextCursor || null,
      })
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
    void loadMoreUnits()
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

  async function rebuildJvmJar() {
    if (!currentRun || !selectedUnit || buildingJvm) return
    setBuildingJvm(true)
    setJvmBuildError('')
    setJvmBuild(null)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/jvm/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: currentRun.id, codeUnitId: selectedUnit.id }),
      })
      const result = await response.json().catch(() => ({})) as Partial<JvmBuildResponse> & { error?: string }
      if (!response.ok || typeof result.downloadUrl !== 'string' || typeof result.sha256 !== 'string'
          || typeof result.codeUnitId !== 'string') {
        throw new Error(result.error || 'Could not rebuild this JVM JAR')
      }
      setJvmBuild(result as JvmBuildResponse)
    } catch (error) {
      setJvmBuildError(error instanceof Error ? error.message : 'Could not rebuild this JVM JAR')
    } finally {
      setBuildingJvm(false)
    }
  }

  return (
    <section id="code-visualizer" className={`${styles.panel} ${standalone ? styles.standalone : ''}`} aria-labelledby="code-visualizer-heading">
      <div className={styles.header}>
        <div>
          <p className={styles.kicker}>Decompiled program</p>
          <h2 id="code-visualizer-heading"><Code2 size={18} /> Reverse engineering workspace</h2>
          <p className={styles.description}>Inspect analyzer output, then rewrite and save a maintainable source copy. Decompiled output stays available as evidence beside your reviewed version.</p>
        </div>
        <div className={styles.headerActions}>
          {query.data && <span className={styles.badge}>{nextCursor ? `${units.length.toLocaleString()} / ${query.data.total.toLocaleString()} code units` : `${units.length.toLocaleString()} code units`}</span>}
          {currentRun && <div className={styles.viewSwitcher} role="group" aria-label="Code visualizer view">
            <button type="button" className={visualizerView === 'function-map' ? styles.viewButtonActive : styles.viewButton} aria-pressed={visualizerView === 'function-map'} onClick={() => setVisualizerView('function-map')}>Code map</button>
            <button type="button" className={visualizerView === 'treemap' ? styles.viewButtonActive : styles.viewButton} aria-pressed={visualizerView === 'treemap'} onClick={() => setVisualizerView('treemap')}>Treemap</button>
          </div>}
          <Link className={styles.focusLink} href={standalone ? `/projects/${encodeURIComponent(projectId)}` : `/projects/${encodeURIComponent(projectId)}/visualizer`}>
            {standalone ? 'Back to workspace' : 'Open full visualizer'}
          </Link>
        </div>
      </div>

      {failedRuns.length > 0 && <details className={styles.failedRunList}>
        <summary className={styles.failedRunHeading}>
          <strong>Recent unsuccessful runs ({failedRuns.length})</strong>
          <span>These attempts are kept separate from completed output.</span>
        </summary>
        {failedRuns.map((run) => <article className={styles.failedRun} key={run.id}>
          <div className={styles.failedRunTitle}>
            <strong>{run.status === 'CANCELLED' ? 'Cancelled' : 'Failed'} · {run.title}</strong>
            <span>{run.artifactName} · {new Date(run.completedAt || run.createdAt).toLocaleString()}</span>
          </div>
          {run.progressMessage && <p>Last recorded step: {run.progressMessage}</p>}
          {run.error && <p className={styles.failedRunError}>{run.error}</p>}
          <small>Run {run.id.slice(-8)}</small>
          <a className={styles.failedRunLink} href="#analysis-tasks">Review task controls</a>
        </article>)}
      </details>}

      {currentRun && <div className={styles.progressCards}>
      <div className={styles.runSummary} aria-label="Selected analysis summary">
        <div className={styles.runSummaryHeading}>
          <div>
            <strong>{maintainedCoverageQuery.data?.decompilationCoveragePercent !== null && maintainedCoverageQuery.data?.decompilationCoveragePercent !== undefined
              ? `${maintainedCoverageQuery.data.decompilationCoveragePercent}% of measured code decompiled`
              : maintainedCoverageQuery.isLoading
                ? 'Checking decompilation completeness…'
                : maintainedCoverageQuery.isError
                  ? 'Decompilation measurements unavailable'
                  : 'Decompilation completeness not measured'}</strong>
            <span>{maintainedCoverageQuery.data
              ? `${maintainedCoverageQuery.data.sourceLinkedPercent}% have viewable source · `
              : ''}{currentRun.indexedUnitCount.toLocaleString()} code units indexed{currentRun.discoveredUnitCount !== null
                ? ` of ${currentRun.discoveredUnitCount.toLocaleString()} discovered ${currentRun.unitLabel}`
                : ''}</span>
          </div>
          <span>Code {formatBytes(maintainedCoverageQuery.data?.codeBytes ?? currentRun.codeBytes ?? units.reduce((sum, unit) => sum + unit.sizeBytes, 0))}</span>
        </div>
        {maintainedCoverageQuery.data?.decompilationCoveragePercent !== null && maintainedCoverageQuery.data?.decompilationCoveragePercent !== undefined && <div className={styles.runProgress} role="progressbar"
          aria-label="Measured decompilation completeness"
          aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={maintainedCoverageQuery.data.decompilationCoveragePercent}
          aria-valuetext={`${maintainedCoverageQuery.data.decompilationCoveragePercent}% of measured code decompiled`}>
          <span style={{ width: `${maintainedCoverageQuery.data.decompilationCoveragePercent}%` }} />
        </div>}
        {maintainedCoverageQuery.data?.decompilationCoveragePercent === null && <p className={styles.runSummaryMeta}>The analyzer did not provide enough measurements to calculate decompilation completeness. Indexed records and viewable source are counted separately.</p>}
        <details className={styles.runDiagnostics}>
          <summary>Run diagnostics{currentRun.truncated || currentRun.methodsTruncated || currentRun.callGraphTruncated || currentRun.referencesTruncated || currentRun.notObservedUnitCount > 0 || currentRun.notIndexedUnitCount > 0 || currentRun.failedUnitCount !== null && currentRun.failedUnitCount > 0 ? ' · issues reported' : ''}</summary>
        {(currentRun.truncated || currentRun.notObservedUnitCount > 0 || currentRun.notIndexedUnitCount > 0 || (currentRun.failedUnitCount !== null && currentRun.failedUnitCount > 0)
          || currentRun.methodsTruncated
          || currentRun.callGraphTruncated
          || currentRun.referencesTruncated
          || (currentRun.notVisitedUnitCount !== null && currentRun.notVisitedUnitCount > 0)
          || (currentRun.skippedUnitCount !== null && currentRun.skippedUnitCount > 0)
          || (currentRun.unsupportedUnitCount !== null && currentRun.unsupportedUnitCount > 0)
          || (currentRun.excludedUnitCount !== null && currentRun.excludedUnitCount > 0)
          || (currentRun.omittedUnitCount !== null && currentRun.omittedUnitCount > 0)) && <div className={styles.runSummaryMeta}>
          {currentRun.truncated && <span>Partial index. The counts below describe stored output; they do not indicate whether the task finished.</span>}
          {currentRun.truncated && analysisHref && <a className={styles.runAgain} href={analysisHref}>View analysis proposals</a>}
          {currentRun.notObservedUnitCount > 0 && <span>{currentRun.notObservedUnitCount.toLocaleString()} provider-reported results had no returned observation.</span>}
          {currentRun.notIndexedUnitCount > 0 && <span>{currentRun.notIndexedUnitCount.toLocaleString()} provider-returned code units could not be indexed.</span>}
          {currentRun.discoveredMethodCount !== null && currentRun.discoveredMethodCount !== undefined && <span>{currentRun.indexedMethodCount?.toLocaleString() ?? 0} of {currentRun.discoveredMethodCount.toLocaleString()} discovered methods indexed{currentRun.returnedMethodCount !== null && currentRun.returnedMethodCount !== undefined && currentRun.returnedMethodCount < currentRun.discoveredMethodCount ? ` (${currentRun.returnedMethodCount.toLocaleString()} returned by the analyzer)` : ''}.</span>}
          {currentRun.methodsTruncated && <span>Method evidence is incomplete; the analyzer or result ingestion reached a method limit.</span>}
          {currentRun.returnedCallCount !== null && currentRun.returnedCallCount !== undefined && <span>{currentRun.returnedCallCount.toLocaleString()} call edges returned{currentRun.callGraphTruncated ? '; the call graph is truncated.' : '.'}</span>}
          {currentRun.returnedReferenceCount !== null && currentRun.returnedReferenceCount !== undefined && <span>{currentRun.returnedReferenceCount.toLocaleString()} field/string references returned{currentRun.referencesTruncated ? '; reference evidence is truncated.' : '.'}</span>}
          {currentRun.callGraphTruncated && currentRun.returnedCallCount === null && <span>The analyzer marked call graph evidence as truncated.</span>}
          {currentRun.referencesTruncated && currentRun.returnedReferenceCount === null && <span>The analyzer marked field/string reference evidence as truncated.</span>}
          {currentRun.notVisitedUnitCount !== null && currentRun.notVisitedUnitCount > 0 && <span>{currentRun.notVisitedUnitCount.toLocaleString()} discovered units were not visited by the analyzer.</span>}
          {currentRun.failedUnitCount !== null && currentRun.failedUnitCount > 0 && <span>{currentRun.failedUnitCount.toLocaleString()} functions could not be decompiled{currentRun.visitedUnitCount !== null ? ` of ${currentRun.visitedUnitCount.toLocaleString()} visited` : ''}</span>}
          {currentRun.skippedUnitCount !== null && currentRun.skippedUnitCount > 0 && <span>{currentRun.skippedUnitCount.toLocaleString()} units were reported skipped.</span>}
          {currentRun.unsupportedUnitCount !== null && currentRun.unsupportedUnitCount > 0 && <span>{currentRun.unsupportedUnitCount.toLocaleString()} units were reported unsupported.</span>}
          {currentRun.excludedUnitCount !== null && currentRun.excludedUnitCount > 0 && <span>{currentRun.excludedUnitCount.toLocaleString()} units were reported excluded.</span>}
          {currentRun.omittedUnitCount !== null && currentRun.omittedUnitCount > 0 && <span>{currentRun.omittedUnitCount.toLocaleString()} invalid or excess records were omitted by the provider adapter.</span>}
        </div>}
        {currentRun.inventoryAvailable && currentRun.unreturnedDiscoveredUnitCount !== null && currentRun.unreturnedDiscoveredUnitCount > 0 && <p className={styles.runSummaryMeta}>
          {currentRun.unreturnedDiscoveredUnitCount.toLocaleString()} discovered {currentRun.unitLabel} were not returned by the provider. Reported failures, omissions, skips, unsupported units, and exclusions are breakdowns where available; the remaining units are not assigned a cause.
        </p>}
        {(currentRun.failedClassDetails?.length || 0) > 0 && <div className={styles.runSummaryMeta}>
          <strong>Unreconstructed DEX classes</strong>
          <ul>
            {currentRun.failedClassDetails?.map((detail) => <li key={`${detail.dexEntry}:${detail.classIndex}`}>
              <code>{detail.descriptor || `${detail.dexEntry} class #${detail.classIndex + 1}`}</code>
              {` · ${detail.reason}`}
            </li>)}
          </ul>
          {currentRun.failedClassDetailsTruncated && <span>Additional failed-class identities are saved with the run result.</span>}
        </div>}
        {!currentRun.inventoryAvailable && currentRun.discoveredUnitCount !== null && currentRun.discoveredUnitCount > currentRun.indexedUnitCount && <p className={styles.runSummaryMeta}>
          {(currentRun.discoveredUnitCount - currentRun.indexedUnitCount).toLocaleString()} discovered {currentRun.unitLabel} have no indexed code-unit record; this older run did not save separate returned and indexed counts.
        </p>}
        {!currentRun.inventoryAvailable && <p className={styles.runSummaryMeta}>This older run has no persisted shared coverage inventory; the displayed rate uses the available provider count.</p>}
        {maintainedCoverageQuery.data && <p className={styles.runSummaryMeta}>
          {maintainedCoverageQuery.data.codeBytes > 0
            ? `Completeness measurements are available for ${Math.round((maintainedCoverageQuery.data.measuredBytes / maintainedCoverageQuery.data.codeBytes) * 100)}% of indexed code bytes (${formatBytes(maintainedCoverageQuery.data.measuredBytes)} measured, ${formatBytes(Math.max(0, maintainedCoverageQuery.data.codeBytes - maintainedCoverageQuery.data.measuredBytes))} unmeasured). This is measurement availability; the decompiled percentage above shows how much of the measured code was decompiled. Graph and instruction-index limits are reported separately below.`
            : 'No indexed code size is available for decompilation measurement.'}
        </p>}
        {displayRunWarnings && <p className={styles.runWarning}>{displayRunWarnings}</p>}
        </details>
      </div>

      {currentRun && <div className={styles.runSummary} aria-label="Selected run maintainable-source progress">
        {maintainedCoverageQuery.isLoading && <p className={styles.message}>Checking reverse-engineered source coverage…</p>}
        {maintainedCoverageQuery.isError && <p className={styles.error} role="alert">Could not load maintainable-source progress. Refresh the map to try again.</p>}
        {maintainedCoverageQuery.data && <>
          <div className={styles.runSummaryHeading}>
            <div>
              <strong>{maintainedCoverageQuery.data.coveragePercent}% saved as maintainable source</strong>
              <span>{maintainedCoverageQuery.data.maintainedUnitCount.toLocaleString()} of {maintainedCoverageQuery.data.codeUnitCount.toLocaleString()} code units have a saved maintained copy</span>
            </div>
            <span>Only saved maintained copies count</span>
          </div>
          <details className={styles.runDiagnostics}>
          <summary>Review and validation details</summary>
          <p className={styles.runSummaryMeta}>
            {maintainedCoverageQuery.data.reviewedUnitCount !== null && maintainedCoverageQuery.data.validatedUnitCount !== null
              ? `${maintainedCoverageQuery.data.reviewedUnitCount.toLocaleString()} copies have a current accepted review receipt; ${maintainedCoverageQuery.data.validatedUnitCount.toLocaleString()} match passed whole-file structural validation.`
              : 'Review and validation breakdown is unavailable for this response.'}
            {maintainedCoverageQuery.data.unmatchedLegacyValidationUnitCount !== null && maintainedCoverageQuery.data.unmatchedLegacyValidationUnitCount > 0
              ? ` ${maintainedCoverageQuery.data.unmatchedLegacyValidationUnitCount.toLocaleString()} older validation record(s) lack an output hash, so they cannot be matched to the current source.`
              : ''}
          </p>
          </details>
          <div className={`${styles.runProgress} ${styles.maintainedProgress}`} role="progressbar" aria-label="Maintained source coverage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={maintainedCoverageQuery.data.coveragePercent} aria-valuetext={`${maintainedCoverageQuery.data.coveragePercent}% reverse engineered into maintainable source`}>
            <span style={{ width: `${maintainedCoverageQuery.data.coveragePercent}%` }} />
          </div>
        </>}
      </div>}
      </div>}

      {currentRun && <ProjectFunctionAgentQueue
        projectId={projectId}
        taskId={currentRun.id}
        providerId={selectedProviderId}
        reviewerProviderId={selectedReviewerProviderId}
      />}

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
          {analysisTask?.status === 'RUNNING' ? <>
            <strong>Analysis is running.</strong>
            <p>{analysisTask.progressMessage || 'The code map will fill in after the analyzer publishes its results.'}</p>
          </> : analysisTask?.status === 'QUEUED' ? <>
            <strong>Analysis is queued.</strong>
            <p>Open the task controls and choose Run to start the analyzer.</p>
            <a className={styles.emptyAction} href="#analysis-tasks">Open task controls</a>
          </> : analysisTask?.status === 'AWAITING_APPROVAL' ? <>
            <strong>Analysis is waiting for approval.</strong>
            <p>Approve the task in the task controls before running it.</p>
            <a className={styles.emptyAction} href="#analysis-tasks">Open task controls</a>
          </> : analysisTask?.status === 'COMPLETED' ? <>
            <strong>{currentRun?.indexedUnitCount === 0 ? 'This run indexed no viewable code units.' : 'The analyzer finished without viewable code units.'}</strong>
            <p>{currentRun && currentRun.discoveredUnitCount !== null
              ? `The analyzer reported ${currentRun.discoveredUnitCount.toLocaleString()} analyzed ${currentRun.unitLabel}; ${currentRun.indexedUnitCount.toLocaleString()} were indexed. Review provider warnings and limits under task controls.`
              : 'Review provider output and warnings under task controls to see why no units were indexed.'}</p>
            <a className={styles.emptyAction} href="#analysis-tasks">Review task</a>
          </> : analysisTask?.status === 'FAILED' || analysisTask?.status === 'CANCELLED' ? <>
            <strong>Analysis did not finish.</strong>
            <p>Review the task and retry it from the task controls.</p>
            <a className={styles.emptyAction} href="#analysis-tasks">Open task controls</a>
          </> : <>
            <strong>No code units have been analyzed yet.</strong>
            <p>Import files, then run a compatible analysis proposal to populate this map with code units and their relationships.</p>
            {analysisHref && <a className={styles.emptyAction} href={analysisHref}>View analysis proposals</a>}
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
      {(visualizerView === 'function-map' || visualizerView === 'treemap') && <details className={styles.mapOptions}>
        <summary>Map options <span>Filters, colors, and exports</span></summary>
        <div className={styles.visualizerToolbar}>
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
          {currentRun && <ProjectCSharpBuild projectId={projectId} taskId={currentRun.id} className={styles.runButton} />}
          {currentRun && <ProjectGoBuild projectId={projectId} taskId={currentRun.id} className={styles.runButton} />}
        </div></details>}
        {currentRun?.apktoolProjectAvailable && (visualizerView === 'function-map' || visualizerView === 'treemap') && <p className={styles.functionMapNote}>
          APK rebuilds apply saved Android resource and Smali edits to the retained Apktool project. Maintained JADX Java stays separate because it is not compiled back into DEX; the rebuilt APK is unsigned.
        </p>}
        {(visualizerView === 'function-map' || visualizerView === 'treemap') && nextCursor && <div className={styles.loadMore} role="group" aria-label="Map code unit loading">
          <span role="status">Loaded {units.length.toLocaleString()} of {query.data?.total.toLocaleString() || '0'} code units</span>
          <button type="button" className={styles.runButton} onClick={() => void loadMoreUnits()} disabled={loadingMore}>
            {loadingMore ? 'Loading code units…' : 'Load more code units'}
          </button>
          {loadMoreError && <p className={styles.error} role="alert">{loadMoreError}</p>}
        </div>}
      </>}

      {!query.isLoading && !query.isError && query.data && units.length > 0 && <>
        <details className={styles.mapMetrics}>
        <summary>Map metrics</summary>
        <div className={styles.stats}>
          <div><strong>{folderUnits.length.toLocaleString()}</strong><span>Code units in this map</span></div>
          <div><strong>{summary.sourceLinkedPercent === null ? 'Unknown' : `${summary.sourceLinkedPercent}%`}</strong><span>Viewable source links in map ({summary.sourceLinkedUnits.toLocaleString()}/{folderUnits.length.toLocaleString()})</span></div>
          <div><strong>{formatBytes(summary.totalBytes)}</strong><span>Code bytes in this map</span></div>
          <div><strong>{summary.coveragePercent === null ? 'Unknown' : `${summary.coveragePercent}%`}</strong><span>Decompilation completeness of measured bytes in map</span></div>
          <div><strong>{summary.decompiledUnits.toLocaleString()}</strong><span>Fully decompiled units in map</span></div>
          <div><strong>{maintainedUnits.toLocaleString()}</strong><span>Maintained source copies in map</span></div>
        </div>
        {summary.unmeasuredBytes > 0 && <p className={styles.message}>{formatBytes(summary.unmeasuredBytes)} of mapped code has no decompilation completeness value from its provider.</p>}
        </details>

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

        <div className={`${styles.workbench} ${selectedUnit ? '' : styles.workbenchMapOnly}`}>
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
          {functionMapCells.length > DENSE_FUNCTION_MAP_THRESHOLD ? <DenseFunctionMap cells={functionMapCells} onSelect={selectFunctionMapCell} /> : <div className={styles.functionMap} role="group" aria-label="Language-neutral functions and code units map">
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
                  setSelectedFunctionMapMember({ id: member.id, parentUnitId: parent.id, name: member.name.replace(/#\d+$/, ''), similarityAvailable: member.similarityAvailable, hasControlFlowGraph: member.hasControlFlowGraph })
                }}
              >
                <strong>{member.name}</strong>
                <span>{meta || member.memberKind}</span>
                <small>{coverage} · {work} · {member.memberKind}</small>
              </button>
            })}
          </div>}
          {selectedLuaFunctionId && <FunctionControlFlowPanel
            query={functionControlFlowQuery}
            name={selectedFunctionMapMember?.name || 'Lua prototype'}
          />}
          {visibleFunctionMapMembers.length > 0 && <p className={styles.functionMapNote} role="status">{visibleFunctionMapMembers.length.toLocaleString()} function or method entries from the loaded code units. Status reflects the containing source file; select an entry to open its source and any available function-level analysis.</p>}
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

        {nextCursor && <p className={styles.message}>Showing {units.length.toLocaleString()} of {query.data.total.toLocaleString()} code units matching your search. Load more to include additional units in size and coverage filters.</p>}
        </div>

        <aside ref={unitInspectorRef} className={styles.unitInspector} aria-label="Selected code unit inspector">
        {!selectedUnit && <div className={styles.inspectorEmpty}><strong>Select a code unit to inspect its source.</strong><span>Choose a tile from the map or search by class, function, address, path, or referenced string.</span></div>}
        {selectedUnit && <div className={styles.details}>
          <div className={styles.detailsHeading}>
            <div><span className={styles.detailLabel}>{selectedUnit.unitType === 'resource' ? 'Selected Android resource' : 'Selected code unit'}</span><strong>{selectedUnit.name}</strong>{selectedUnit.maintainedSource && <span className={styles.savedStatus}>Maintained source saved</span>}</div>
          {explanationProviders.length > 0 && selectedSourceUrl && selectedUnit.isExecutableSource !== false && !largeSource && <button type="button" className={styles.explainButton} onClick={() => void deobfuscateSelectedUnit()} disabled={!selectedProviderId || transforming || sourceQuery.isError || sourceQuery.isLoading || maintainedQuery.isLoading}>
              {transforming ? 'Reverse engineering…' : 'Create maintainable version'}
            </button>}
          </div>
        {selectedUnit.extractedBytecodeArtifactId && !selectedSourceUrl && <p className={styles.sourcePreviewNote} role="note">
          PyInstaller module {selectedUnit.pyinstallerArchivePath ? <code>{selectedUnit.pyinstallerArchivePath}</code> : selectedUnit.name} is saved as bytecode with SHA-256 {selectedUnit.extractedBytecodeSha256 || 'recorded in project provenance'}. Source reconstruction is pending; later PyInstaller analyses continue with up to four pending modules.
        </p>}
        {selectedUnit && selectedSourceUrl && <section className={styles.sourcePanel} aria-label={selectedUnit.representation === 'optimized intermediate representation' ? 'Intermediate representation evidence' : selectedUnit.representation === 'Editable .ud binary specification' ? 'Editable binary specification' : selectedUnit.unitType === 'resource' ? 'Decoded Android resource' : selectedDisassemblyUrl ? 'Decompilation and disassembly comparison' : (selectedUnit.language === 'WebAssembly Text (WAT)' ? 'WAT disassembly' : selectedUnit.representation === 'YARV instruction disassembly' ? 'YARV bytecode disassembly' : isDisassemblyUnit(selectedUnit) ? 'Smali disassembly' : 'Decompiled source')}>
          {selectedUnit.representationSemantics && <p className={styles.sourcePreviewNote} role="note">{selectedUnit.representationSemantics}</p>}
          {selectedUnit.roundTripByteIdentical !== null && selectedUnit.roundTripByteIdentical !== undefined && <p className={styles.sourcePreviewNote} role="status">
            univdreams compile-back {selectedUnit.roundTripByteIdentical ? 'matches the imported file byte-for-byte' : 'differs from the imported file'}
            {selectedUnit.roundTripSha256 ? ` · rebuilt SHA-256 ${selectedUnit.roundTripSha256}` : ''}
            {' · This is an encoding and layout comparison, not proof of equivalent behavior.'}
          </p>}
          {selectedUnit.roundTripError && <p className={styles.sourcePreviewNote} role="status">
            univdreams compile-back was unavailable: {selectedUnit.roundTripError}
          </p>}
          {selectedUnit.bytecodeMagicHex && <p className={styles.sourcePreviewNote} role="note">Bytecode magic: 0x{selectedUnit.bytecodeMagicHex} · raw header metadata; runtime version is not inferred.</p>}
          {selectedUnit.deobfuscationProvider && <p className={styles.sourcePreviewNote} role="note">
            {selectedUnit.deobfuscationProvider} {selectedUnit.deobfuscationProviderRevision ? `@ ${selectedUnit.deobfuscationProviderRevision.slice(0, 12)}` : 'transformation'} · transformed artifact {selectedUnit.deobfuscatedArtifactId?.split('/').pop() || 'recorded'}
            {selectedUnit.inputArtifactSha256 ? ` · original SHA-256 ${selectedUnit.inputArtifactSha256}` : ''}
            {selectedUnit.deobfuscatedArtifactSha256 ? ` · transformed SHA-256 ${selectedUnit.deobfuscatedArtifactSha256}` : ''}
            {selectedUnit.deobfuscationEnabledPasses?.length ? ` · enabled: ${selectedUnit.deobfuscationEnabledPasses.join(', ')}` : ''}
            {selectedUnit.deobfuscationDisabledPasses?.length ? ` · skipped: ${selectedUnit.deobfuscationDisabledPasses.join(', ')}` : ''}
          </p>}
          {selectedUnit.recurseInstructionCount != null && <p className={styles.sourcePreviewNote} role="note">Lifted {selectedUnit.recurseInstructionCount.toLocaleString()} instructions{selectedUnit.recurseOptimizerPasses ? ` · Optimizer passes: ${Object.entries(selectedUnit.recurseOptimizerPasses).map(([name, count]) => `${name.replaceAll('_', ' ')} ${count}`).join(', ')}` : ''}{selectedUnit.sizeEvidence === 'instruction-count-fallback' ? ' · Function byte size unavailable; visualizer size uses instruction count.' : ''}</p>}
          {selectedDisassemblyUrl ? <div className={styles.comparison}>
            <div className={styles.listingPane}>
              <div className={styles.sourceHeader}>
                <div><strong>{selectedUnit.representation === 'Editable .ud binary specification' ? 'Editable binary specification' : selectedUnit.representation === 'YARV instruction disassembly' ? 'YARV bytecode disassembly' : 'Decompiled source'}</strong><span>{languageLabel(selectedUnit)} · {selectedUnit.codeArtifactId?.split('/').pop()}</span></div>
                <button type="button" className={styles.copyButton} onClick={() => void copySource()} disabled={!sourceQuery.data}><Copy size={14} /> {copyStatus || (selectedUnit.representation === 'YARV instruction disassembly' ? 'Copy listing' : 'Copy source')}</button>
              </div>
              {selectedUnit.representation && <p className={styles.sourcePreviewNote} role="status">{selectedUnit.representation}{selectedUnit.decompilerVersion ? ` · ${selectedUnit.decompilerVersion}` : ''}{selectedUnit.nameEvidence ? ` · Name evidence: ${selectedUnit.nameEvidence}` : ''}</p>}
              {selectedUnit.sourceAddressMap?.length ? <p className={styles.sourcePreviewNote} role="status">Mapped source lines are clickable. Click again to cycle through associated {selectedUnit.disassemblyLanguage?.toLowerCase() === 'webassembly bytes' ? 'Wasm byte offsets' : 'instruction addresses'}.</p> : null}
              {selectedUnit.sourceAddressMapTruncated && <p className={styles.sourcePreviewNote} role="status">Some source-to-instruction mappings were omitted at the analyzer limit.</p>}
              {sourceQuery.isLoading && <p className={styles.message}>{selectedUnit.representation === 'YARV instruction disassembly' ? 'Loading bytecode evidence…' : 'Loading decompiled source…'}</p>}
              {sourceQuery.isError && <p className={styles.error}>{sourceQuery.error instanceof Error ? sourceQuery.error.message : 'Could not load decompiled source'}</p>}
              {sourceQuery.data !== undefined && <SourceListing source={sourceQuery.data} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} fullSourceUrl={selectedSourceUrl} sourceAddressMap={selectedUnit.sourceAddressMap} onMappedAddressSelect={selectSourceAddress} mappingLabel={selectedUnit.disassemblyLanguage?.toLowerCase() === 'webassembly bytes' ? 'Wasm byte offset' : 'instruction address'} />}
            </div>
            <div className={styles.listingPane}>
              <div className={styles.sourceHeader}>
                <div><strong>{selectedUnit.disassemblyLanguage || 'Disassembly'}</strong><span>{selectedUnit.address || 'Function listing'} · {selectedUnit.disassemblyArtifactId?.split('/').pop()}</span></div>
                <button type="button" className={styles.copyButton} onClick={() => void copySource(disassemblyQuery.data, true)} disabled={!disassemblyQuery.data}><Copy size={14} /> {assemblyCopyStatus || 'Copy assembly'}</button>
              </div>
              {disassemblyQuery.isLoading && <p className={styles.message}>Loading instruction listing…</p>}
              {disassemblyQuery.isError && <p className={styles.error}>{disassemblyQuery.error instanceof Error ? disassemblyQuery.error.message : 'Could not load instruction listing'}</p>}
              {disassemblyQuery.data !== undefined && <SourceListing source={disassemblyQuery.data} language={selectedUnit.disassemblyLanguage} fileName={selectedUnit.disassemblyArtifactId?.split('/').pop()} fullSourceUrl={selectedDisassemblyUrl} highlightAddress={selectedEvidenceAddress} lineIdPrefix={`disassembly-${selectedUnit.id}`} />}
              {selectedUnit.disassemblyLanguage?.toLowerCase() === 'smali' && <div className={styles.smaliEditor}>
                <label>Editable Smali source
                  <textarea aria-label="Editable Smali source" value={smaliDraft} spellCheck={false} onChange={(event) => { setSmaliDraft(event.target.value); setSmaliSaved(false); setSmaliError('') }} />
                </label>
                <label className={styles.reviewRationale}>Review rationale (required to accept or revoke this Smali version)
                  <textarea aria-label="Smali review rationale" value={smaliReviewRationale} maxLength={1000} onChange={(event) => setSmaliReviewRationale(event.target.value)} placeholder="Summarize what you checked before accepting, or why you are revoking acceptance." />
                </label>
                <div className={styles.maintainedActions}>
                  <button type="button" className={styles.explainButton} onClick={() => void saveSmaliSource()} disabled={savingSmali || !smaliDraft.trim() || smaliReviewRationale.trim().length < 12 || (smaliSaved && smaliDraft === smaliSourceQuery.data?.sourceCode)}>{savingSmali ? 'Saving Smali…' : smaliSaved ? 'Review and save Smali changes' : 'Review and accept Smali source'}</button>
                  {smaliSourceQuery.data?.acceptedReviewId && <button type="button" className={styles.copyButton} onClick={() => void revokeSmaliAcceptance()} disabled={savingSmali || smaliReviewRationale.trim().length < 12}>{savingSmali ? 'Recording review…' : 'Revoke current acceptance'}</button>}
                  {smaliReviewRationale.trim().length > 0 && smaliReviewRationale.trim().length < 12 && <span className={styles.message}>Add at least 12 characters describing your review.</span>}
                  {smaliSaved && <span className={styles.savedStatus} role="status">Accepted Smali source and review receipt saved; included in APK rebuilds</span>}
                  {smaliReviewStatus && <span className={styles.savedStatus} role="status">{smaliReviewStatus}</span>}
                </div>
                {(smaliSourceQuery.data?.reviews?.length || 0) > 0 && <section className={styles.reviewHistory} aria-label="Smali review history">
                  <strong>Recent Smali review receipts</strong>
                  <ol>{smaliSourceQuery.data?.reviews?.map((review) => <li key={review.id}>
                    <span>{review.decision.toLowerCase()} by {review.reviewerId} · {new Date(review.createdAt).toLocaleString()}</span>
                    <p>{review.rationale}</p>
                    {review.validationStatus && <p>Assembler validation: {review.validationStatus.toLowerCase()}{review.validationMethod ? ` via ${review.validationMethod}` : ''}{review.validationMessage ? ` — ${review.validationMessage}` : ''}</p>}
                    <code>sha256:{review.maintainedSourceHash}</code>
                    {review.decision === 'ACCEPTED' && review.sourceAvailable && review.maintainedSourceHash !== smaliSourceQuery.data?.sourceHash && <button type="button" className={styles.copyButton} onClick={() => void loadAcceptedSmaliRevision(review)} disabled={Boolean(loadingSmaliRevisionId)}>{loadingSmaliRevisionId === review.id ? 'Loading…' : 'Load this accepted version'}</button>}
                    {review.decision === 'ACCEPTED' && !review.sourceAvailable && <small>Source snapshot unavailable for this older receipt.</small>}
                  </li>)}</ol>
                </section>}
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
        {selectedUnit && selectedSourceUrl && canCompareDecompilerOutputs && <>
          {compareAlternatesOpen && <div className={styles.alternateComparisonBackdrop} aria-hidden="true" onMouseDown={() => setCompareAlternatesOpen(false)} />}
          <section
            className={`${styles.alternateComparison} ${compareAlternatesOpen ? styles.alternateComparisonModal : ''}`}
            aria-label="Compare decompiler outputs"
            role={compareAlternatesOpen ? 'dialog' : undefined}
            aria-modal={compareAlternatesOpen || undefined}
            onKeyDown={(event) => { if (event.key === 'Escape') setCompareAlternatesOpen(false) }}
          >
          <div className={styles.alternateComparisonHeader}>
            <div><strong>Compare decompiler outputs</strong><span>Only matching input artifact, source path, and language; both stored output hashes checked before display.</span></div>
            <button type="button" className={styles.copyButton} onClick={() => setCompareAlternatesOpen((open) => !open)} aria-expanded={compareAlternatesOpen}>
              {compareAlternatesOpen ? 'Hide comparison' : 'Compare providers'}
            </button>
          </div>
          {compareAlternatesOpen && <>
            {alternateOutputsQuery.isLoading && <p className={styles.message} role="status">Finding verified alternate outputs…</p>}
            {alternateOutputsQuery.isError && <p className={styles.error} role="alert">{alternateOutputsQuery.error instanceof Error ? alternateOutputsQuery.error.message : 'Could not load alternate outputs.'}</p>}
            {alternateOutputsQuery.data?.truncated && <p className={styles.message} role="status">This comparison reached its safety limit. Some older runs or provider outputs may be omitted.</p>}
            {!alternateOutputsQuery.isLoading && !alternateOutputsQuery.isError && alternateOutputs.length === 0 && <p className={styles.message}>No hash-verified output from another compatible decompiler is stored for this source unit.</p>}
            {alternateOutputs.length > 0 && <>
              <label className={styles.alternateProviderSelect}>Use this provider for the optional line diff
                <select aria-label="Alternate decompiler output" autoFocus={compareAlternatesOpen} value={selectedAlternateOutput?.id || ''} onChange={(event) => setSelectedAlternateId(event.target.value)}>
                  {alternateOutputs.map((output) => <option key={output.id} value={output.id}>{output.providerName}{output.version ? ` ${output.version}` : ''}</option>)}
                </select>
              </label>
              <div className={styles.comparison} role="group" aria-label="All verified decompiler outputs">
                <section className={styles.listingPane} aria-label="Selected provider output">
                  <div className={styles.sourceHeader}><div><strong>{selectedUnit.source.replace(/^reamon-/, '')} · selected output</strong><span>{selectedUnit.decompilerVersion || selectedUnit.language} · {selectedUnit.codeArtifactId?.split('/').pop()}</span></div></div>
                  {sourceQuery.data !== undefined
                    ? <SourceListing source={sourceQuery.data} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} fullSourceUrl={selectedSourceUrl} lineIdPrefix={`decompiler-primary-${selectedUnit.id}`} />
                    : <p className={styles.message}>Loading selected output…</p>}
                </section>
                {alternateOutputs.map((output) => <section key={output.id} className={styles.listingPane} aria-label={`${output.providerName} output`}>
                  <div className={styles.sourceHeader}><div><strong>{output.providerName} · alternate output</strong><span>{output.version || output.language} · sha256:{output.outputSha256.slice(0, 16)}</span></div></div>
                  <p className={styles.sourcePreviewNote} role="status">Independent reconstruction · input sha256:{output.inputSha256.slice(0, 16)}. Review differences as evidence; neither output is ground truth.</p>
                  <SourceListing source={output.source} language={output.language} fileName={output.relativePath.split('/').pop()} lineIdPrefix={`decompiler-alternate-${output.id}`} />
                </section>)}
              </div>
              {selectedAlternateOutput && <>
                <details className={styles.reviewDiff} open={compareDiffOpen} onToggle={(event) => setCompareDiffOpen(event.currentTarget.open)}>
                  <summary>Show line differences against the selected alternate</summary>
                  {compareDiffOpen && !sourceQuery.data && <p className={styles.message}>Loading the selected output before comparing…</p>}
                  {alternateComparisonDiff?.unavailable && <p className={styles.message}>These files are too large for the inline diff. Use the source panes or open the artifacts in your editor.</p>}
                  {alternateComparisonDiff && !alternateComparisonDiff.unavailable && <>
                    <p className={styles.message}>{alternateComparisonDiff.added} lines appear only in the alternate output · {alternateComparisonDiff.removed} lines appear only in the selected output{alternateComparisonDiff.truncated ? ' · display limited to the first 600 changed lines' : ''}. Textual differences do not establish behavioral differences.</p>
                    {alternateComparisonDiff.rows.length > 0
                      ? <pre className={styles.reviewDiffCode}><code>{alternateComparisonDiff.rows.map((row, index) => <span key={`${row.kind}:${row.beforeLine}:${row.afterLine}:${index}`} className={row.kind === 'added' ? styles.reviewDiffAdded : styles.reviewDiffRemoved}>
                        <span className={styles.reviewDiffGutter}>{row.beforeLine ?? ''}\t{row.afterLine ?? ''}\t{row.kind === 'added' ? '+' : '−'}</span>{row.text || ' '}
                      </span>)}</code></pre>
                      : <p className={styles.message}>No textual line differences.</p>}
                  </>}
                </details>
              </>}
            </>}
          </>}
          </section>
        </>}
          <dl>
            <div><dt>Address</dt><dd>{selectedUnit.address || 'Not supplied'}</dd></div>
            <div><dt>Size</dt><dd>{formatBytes(selectedUnit.sizeBytes)}</dd></div>
            <div><dt>Decompiler output</dt><dd>{selectedUnit.recoveredFromSourceMap
              ? `${selectedUnit.language || 'Source'} recovered from source map`
              : selectedUnit.source === 'reamon-oxidizer' ? 'Rust-like pseudocode' : selectedUnit.sourceLanguage && selectedUnit.language === 'C' ? 'C-like pseudocode' : selectedUnit.language || 'Not identified'}</dd></div>
            {selectedUnit.sourceLanguage && <div><dt>Binary source language</dt><dd>{selectedUnit.sourceLanguage} (metadata)</dd></div>}
            {selectedUnit.symbolSource && <div><dt>Recovered symbol source</dt><dd>{selectedUnit.symbolSource} (provider evidence)</dd></div>}
            {selectedUnit.packageName && <div><dt>Recovered Go package</dt><dd>{selectedUnit.packageName} (address-matched metadata)</dd></div>}
            {selectedUnit.goUnstripSignature && <div><dt>unstrip method signature</dt><dd><code>{selectedUnit.goUnstripSignature}</code></dd></div>}
            {selectedUnit.goUnstripSourceFile && <div><dt>unstrip source location</dt><dd><code>{selectedUnit.goUnstripSourceFile}{selectedUnit.goUnstripSourceLine ? `:${selectedUnit.goUnstripSourceLine}` : ''}</code> (metadata evidence)</dd></div>}
            {selectedUnit.source === 'reamon-tocode-import' && selectedUnit.toCodeInputProvenance && <div><dt>ToCode input provenance</dt><dd>
              <span>{selectedUnit.toCodeInputProvenance === 'HASH_MATCHED_IMPORTED_ARTIFACT'
                ? `ToCode inventory's SHA-256 matches imported file ${selectedUnit.toCodeInputRelativePath || selectedUnit.toCodeClaimedInputPath || '(path unavailable)'}`
                : `ToCode inventory claims ${selectedUnit.toCodeClaimedInputPath || 'an input file'}, but matching bytes are not in this workspace import`}</span>
              {selectedUnit.toCodeClaimedInputSha256 && <code>sha256:{selectedUnit.toCodeClaimedInputSha256}</code>}
            </dd></div>}
            <div><dt>Unit type</dt><dd>{selectedUnit.unitType || 'Code unit'}</dd></div>
            {selectedUnit.bundlePath && <div><dt>Bundle module</dt><dd>{selectedUnit.bundlePath}</dd></div>}
            <div><dt>Artifact</dt><dd>{selectedUnit.artifactPath || 'Not linked'}</dd></div>
            <div><dt>Provider</dt><dd>{selectedUnit.source}</dd></div>
          </dl>
          {selectedUnit.recoveredFromSourceMap && <section className={styles.classReferences} aria-label="Recovered source-map provenance">
            <div><strong>Build-provided source content</strong><span>Recovered from the compiled bundle’s source map</span></div>
            <ul>
              <li>Bundle: <code>{selectedUnit.sourceMapBundleRelativePath || selectedUnit.artifactPath || 'not recorded'}</code></li>
              <li>Map source: <code>{selectedUnit.sourceMapRelativePath || 'not recorded'}</code></li>
              {selectedUnit.sourceMapSectionRelativePath && <li>Indexed map section: <code>{selectedUnit.sourceMapSectionRelativePath}</code></li>}
              <li>Original source path: <code>{selectedUnit.sourceMapSourcePath || selectedUnit.relativePath || 'not recorded'}</code></li>
              {selectedUnit.sourceMapSha256 && <li>Source-map SHA-256: <code>{selectedUnit.sourceMapSha256}</code></li>}
              {selectedUnit.sourceMapSectionSha256 && <li>Section-map SHA-256: <code>{selectedUnit.sourceMapSectionSha256}</code></li>}
              {selectedUnit.sourceMapSourceContentSha256 && <li>Embedded source SHA-256: <code>{selectedUnit.sourceMapSourceContentSha256}</code></li>}
            </ul>
            <small>Embedded source content may be stale or unrelated to this compiled artifact. Compare it with the generated output and validate it before accepting maintained source.</small>
          </section>}
          {selectedUnit.controlFlowMetrics && <section className={styles.classReferences} aria-label="Ghidra control-flow structure">
            <div><strong>Control-flow structure</strong><span>Ghidra BasicBlockModel</span></div>
            <ul>
              <li><code>{selectedUnit.controlFlowMetrics.blockCount.toLocaleString()} basic blocks</code></li>
              <li><code>{selectedUnit.controlFlowMetrics.edgeCount.toLocaleString()} intra-function edges</code></li>
              <li><code>{selectedUnit.controlFlowMetrics.entryBlockCount.toLocaleString()} entry blocks</code></li>
              <li><code>{selectedUnit.controlFlowMetrics.exitBlockCount.toLocaleString()} exit blocks</code></li>
            </ul>
            <small>{selectedUnit.controlFlowMetrics.truncated
              ? 'The counts are lower bounds because CFG extraction reached an analysis limit. They describe structure and do not establish function identity or behavioral equivalence.'
              : 'These counts describe Ghidra’s recovered structure; they do not establish function identity or behavioral equivalence.'}</small>
          </section>}
          {selectedUnit.controlFlowFlattening && <section className={styles.classReferences} aria-label="Ghidra control-flow flattening recovery evidence">
            <div><strong>Flattened control-flow recovery</strong><span>Ghidra p-code emulation · score {selectedUnit.controlFlowFlattening.score.toFixed(3)}</span></div>
            <ul>
              <li><code>{selectedUnit.controlFlowFlattening.resolved} recovered</code></li>
              <li><code>{selectedUnit.controlFlowFlattening.conditional} conditional</code></li>
              <li><code>{selectedUnit.controlFlowFlattening.unresolved} unresolved</code></li>
              {selectedUnit.controlFlowFlattening.dispatcher && <li><code>dispatcher {selectedUnit.controlFlowFlattening.dispatcher}</code></li>}
              {selectedUnit.controlFlowFlattening.state && <li><code>state {selectedUnit.controlFlowFlattening.state}</code></li>}
            </ul>
            <details>
              <summary>Recovered transitions ({selectedUnit.controlFlowFlattening.nodes.length} blocks)</summary>
              <CffRecoveryGraph recovery={selectedUnit.controlFlowFlattening} onAddressSelect={setSelectedEvidenceAddress} />
              <p className={styles.cfgMessage}>Only edges between displayed recovered blocks are drawn. Click or keyboard-select a block to inspect its disassembly.</p>
            </details>
            <small>{selectedUnit.controlFlowFlattening.lowConfidence
              ? `Low-confidence provider recovery${selectedUnit.controlFlowFlattening.confidenceNote ? `: ${selectedUnit.controlFlowFlattening.confidenceNote}` : '.'}`
              : 'Provider confidence checks passed; this remains a structural recovery lead, not proof of equivalent behavior.'}
              {selectedUnit.controlFlowFlattening.truncated ? ' The recovered report is truncated.' : ''} Click a block address to inspect its disassembly.</small>
          </section>}
          {selectedGhidraFunctionId && <FunctionControlFlowPanel
            query={functionControlFlowQuery}
            name={selectedUnit.name}
            onAddressSelect={(address) => setSelectedEvidenceAddress(address)}
          />}
          {(selectedUnit.prototype || (selectedUnit.recoveredVariables?.length ?? 0) > 0) && <details className={styles.recoveredVariables}>
            <summary>Recovered signature and variables <span>{(selectedUnit.recoveredVariables?.length ?? 0).toLocaleString()}</span></summary>
            {selectedUnit.prototype && <p><strong>Provider signature</strong><code>{selectedUnit.prototype}</code></p>}
            {(selectedUnit.recoveredVariables?.length ?? 0) > 0 && <div className={styles.recoveredVariablesTableWrap}>
              <table>
                <thead><tr><th>Kind</th><th>Name</th><th>Recovered type</th><th>Provider constraints</th><th>Size</th><th>Storage</th></tr></thead>
                <tbody>{selectedUnit.recoveredVariables?.map((variable, index) => <tr key={`${variable.kind}:${variable.parameterIndex ?? index}:${variable.name}`}>
                  <td>{variable.kind === 'parameter' ? `Parameter ${variable.parameterIndex ?? ''}` : 'Local'}</td>
                  <td><code>{variable.name}</code></td>
                  <td><code>{variable.dataType || 'Unknown'}</code></td>
                  <td>{variable.nameLocked === undefined ? 'Name: not reported' : `Name: ${variable.nameLocked ? 'locked' : 'unlocked'}`}<br />{variable.typeLocked === undefined ? 'Type: not reported' : `Type: ${variable.typeLocked ? 'locked' : 'unlocked'}`}</td>
                  <td>{variable.sizeBytes === undefined ? 'Unknown' : `${variable.sizeBytes} B`}</td>
                  <td><code>{variable.storageStartAddress || 'Not reported'}</code></td>
                </tr>)}</tbody>
              </table>
            </div>}
            <p className={styles.recoveredVariablesNote}>{selectedUnit.source === 'reamon-ghidra'
              ? 'These names and types are provisional Ghidra evidence. Lock flags describe constraints on its decompiler model, not proof of original-source provenance or correctness.'
              : `These names and types are provisional evidence reported by ${selectedUnit.source}; they are not reviewed canonical names.`}</p>
            {selectedUnit.recoveredVariablesTruncated && <p className={styles.sourcePreviewNote} role="status">The decompiler variable inventory was truncated by an analysis limit.</p>}
          </details>}
          {(selectedUnit.goUnstripInterfaces?.length ?? 0) > 0 && <section className={styles.classReferences} aria-label="Go interface dispatch evidence">
            <div><strong>Go interface dispatch</strong><span>Address-matched unstrip itab metadata</span></div>
            <ul>{selectedUnit.goUnstripInterfaces?.slice(0, 16).map((item, index) => <li key={`${item.itabAddress}:${item.method}:${index}`}>
              <code>{item.interfaceName}.{item.method} → {item.concreteType} at {item.concreteFunctionAddress}{item.incomplete ? ' (incomplete itab)' : ''}</code>
            </li>)}</ul>
            <small>Dispatch records are provider evidence; they do not prove a runtime call path. {selectedUnit.goUnstripInterfacesTruncated ? 'The inventory was truncated by an analysis limit.' : ''}</small>
          </section>}
          {(selectedUnit.classReferences?.length ?? 0) > 0 && <section className={styles.classReferences} aria-label="Related classes">
            <div><strong>Related classes</strong><span>From Android bytecode references</span></div>
            <ul>{selectedUnit.classReferences?.slice(0, 24).map((name) => <li key={name}>
              <button type="button" onClick={() => { setFilter(name); setSelectedId(null); setFolderPath([]) }} title={`Find ${name} in this run`}>{name}</button>
            </li>)}</ul>
            {(selectedUnit.classReferences?.length ?? 0) > 24 && <small>Showing 24 of {selectedUnit.classReferences?.length} references.</small>}
          </section>}
          {(selectedUnit.referencedStrings?.length ?? 0) > 0 && <section className={styles.classReferences} aria-label="Strings referenced by this function">
            <div><strong>Referenced strings</strong><span>{selectedUnit.source === 'reamon-tocode-import' ? 'Address-linked ToCode string cross-references' : 'Data references recovered by Ghidra from this function'}</span></div>
            <ul>{selectedUnit.referencedStrings?.slice(0, 12).map((value, index) => <li key={`${index}:${value}`}><code>{value}</code></li>)}</ul>
            {selectedUnit.referencedStringsTruncated && <small>Additional references were omitted by an analysis limit.</small>}
          </section>}
          {(selectedUnit.flossRecoveredStrings?.length ?? 0) > 0 && <section className={styles.classReferences} aria-label="FLOSS recovered strings">
            <div><strong>Recovered strings</strong><span>FLOSS {selectedUnit.flossVersion || ''} static analysis · stack, tight-loop, or decoded</span></div>
            <ul>{selectedUnit.flossRecoveredStrings?.slice(0, 16).map((item, index) => <li key={`${item.kind}:${item.value}:${index}`}>
              <code>{item.value}</code><small>{item.kind}{item.encoding ? ` · ${item.encoding}` : ''}{item.decodedAt ? ` · decoded at ${item.decodedAt}` : ''}</small>
            </li>)}</ul>
            <small>These strings are address-associated static-analysis evidence, not proof that the program uses them at runtime. {selectedUnit.flossRecoveredStringsTruncated ? 'The list was truncated by an analysis limit.' : ''}</small>
          </section>}
          {(selectedUnit.importedCalls?.length ?? 0) > 0 && <section className={styles.classReferences} aria-label="Imported calls from this function">
            <div><strong>Imported calls</strong><span>ToCode reports these external symbols as called by this function</span></div>
            <ul>{selectedUnit.importedCalls?.slice(0, 32).map((value) => <li key={value}><code>{value}</code></li>)}</ul>
          </section>}
          {(selectedUnit.fieldReferences?.length ?? 0) > 0 && <section className={styles.classReferences} aria-label="Fields referenced by this function">
            <div><strong>Referenced fields</strong><span>ToCode field references; access direction is not reported</span></div>
            <ul>{selectedUnit.fieldReferences?.slice(0, 32).map((value) => <li key={value}><code>{value}</code></li>)}</ul>
            {selectedUnit.fieldReferencesTruncated && <small>Additional field references were omitted by an analysis limit.</small>}
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
        {selectedUnit?.source === currentRun?.providerId && Boolean(selectedSimilarityTarget) && <section className={styles.similarFunctions} aria-labelledby="similar-functions-heading">
          <div className={styles.similarFunctionsHeading}><h3 id="similar-functions-heading">Similar functions</h3><span>Instructions, CFG, strings, and accepted caller/callee matches can guide ranking</span></div>
          {similarFunctionsQuery.isLoading && <p className={styles.message}>Comparing this function with stored evidence from completed analyses…</p>}
          {similarFunctionsQuery.isError && <p className={styles.error}>{similarFunctionsQuery.error instanceof Error ? similarFunctionsQuery.error.message : 'Unable to find similar functions'}</p>}
          {!similarFunctionsQuery.isLoading && !similarFunctionsQuery.isError && similarFunctionsQuery.data?.matches.length === 0 && <p className={styles.message}>{similarFunctionsQuery.data.unavailableReason || 'No close function matches were found in this project.'}</p>}
          {similarFunctionsQuery.data?.graphAnchorEvidenceTruncated && <p className={styles.message}>Call-graph support was skipped because the bounded evidence scan was incomplete; function scores are unaffected.</p>}
          {similarFunctionsQuery.data?.matches.map(({ codeUnit, taskId: matchTaskId, function: matchedFunction, similarity, instructionSimilarity, controlFlowSimilarity, controlFlowTopologySimilarity, stringReferenceSimilarity, graphAnchorSupport, artifact }) => {
            const functionBId = matchedFunction?.id || codeUnit.id
            const candidateKey = `${matchTaskId || ''}:${functionBId}`
            const savedMatch = savedFunctionMatchesQuery.data?.matches.find((match) =>
              (match.taskAId === selectedSimilarityTaskId && match.taskBId === matchTaskId && match.functionAObservationId === selectedSimilarityTarget && match.functionBObservationId === functionBId)
              || (match.taskBId === selectedSimilarityTaskId && match.taskAId === matchTaskId && match.functionBObservationId === selectedSimilarityTarget && match.functionAObservationId === functionBId))
            const latestReview = savedMatch?.reviews[0]
            return <div className={styles.similarFunctionRow} key={candidateKey}>
              <button type="button" className={styles.similarFunction} onClick={() => {
                if (matchTaskId) setSelectedRunId(matchTaskId)
                setMatchedUnitOverride(codeUnit)
                setSelectedId(codeUnit.id)
                setSelectedFunctionMapMember(matchedFunction ? {
                  id: matchedFunction.id,
                  ...(matchedFunction.taskId ? { taskId: matchedFunction.taskId } : {}),
                  parentUnitId: codeUnit.id,
                  name: matchedFunction.name.replace(/#\d+$/, ''),
                  similarityAvailable: true,
                  hasControlFlowGraph: matchedFunction.hasControlFlowGraph,
                } : null)
                setCopyStatus('')
                setAssemblyCopyStatus('')
                setExplanation(null)
                setExplainError('')
              }}>
                <span><strong>{matchedFunction?.name || codeUnit.name}</strong><small>{matchedFunction?.address || codeUnit.address || codeUnit.artifactPath || 'Function'}</small><small>{artifact.name}{artifact.sha256 ? ` · ${artifact.sha256.slice(0, 12)}` : ''} · {artifact.provider}{matchedFunction ? ` · in ${codeUnit.name}` : ''}</small><small>Candidate score {similarity}% · instructions {instructionSimilarity}%{controlFlowSimilarity === null ? '' : ` · CFG counts ${controlFlowSimilarity}%`}{controlFlowTopologySimilarity === null ? '' : ` · CFG topology ${controlFlowTopologySimilarity}%`}{stringReferenceSimilarity === null ? '' : ` · string refs ${stringReferenceSimilarity}%`}{graphAnchorSupport ? ` · supported by ${graphAnchorSupport.acceptedMatchCount} accepted graph neighbor${graphAnchorSupport.acceptedMatchCount === 1 ? '' : 's'} (${graphAnchorSupport.relations.join(' and ')})` : ''} · ranking signal, not proof of identity</small></span>
                <b aria-label={`Candidate similarity score ${similarity} percent, not an identity confidence`}>{similarity}%</b>
              </button>
              <div className={styles.functionMatchActions}>
                {savedMatch ? <>
                  <span>Saved comparison{latestReview ? ` · ${latestReview.decision.toLowerCase()}` : ' · proposed'}</span>
                  <button type="button" disabled={savingFunctionMatchKey === savedMatch.id} onClick={() => void reviewFunctionMatch(savedMatch.id, 'ACCEPTED')}>Accept</button>
                  <button type="button" disabled={savingFunctionMatchKey === savedMatch.id} onClick={() => void reviewFunctionMatch(savedMatch.id, 'REJECTED')}>Reject</button>
                </> : <button type="button" disabled={!matchTaskId || matchTaskId === selectedSimilarityTaskId || savingFunctionMatchKey === candidateKey} onClick={() => matchTaskId && void saveFunctionMatch(matchTaskId, functionBId, candidateKey)}>
                  {savingFunctionMatchKey === candidateKey ? 'Saving…' : 'Save comparison'}
                </button>}
              </div>
            </div>
          })}
          {functionMatchActionError && <p className={styles.error} role="alert">{functionMatchActionError}</p>}
          {similarFunctionsQuery.data?.truncated && <p className={styles.message}>The comparison reached its history limit; older stored function observations may not have been included.</p>}
        </section>}
        </aside>
        </div>

        {selectedUnit && selectedSourceUrl && selectedUnit.isExecutableSource === false
          ? <section className={styles.maintainPanel} aria-label="Bytecode inspection evidence">
              <div>
                <h3><WandSparkles size={16} /> Bytecode inspection evidence</h3>
                <p>This CRuby YARV listing is saved with the original artifact hash, disassembly hash, and runtime version. REAmon has not reconstructed Ruby source from this bytecode yet.</p>
                {selectedUnit.runtimeVersion && <p className={styles.sourcePreviewNote}>Inspected with {selectedUnit.runtimeVersion}{selectedUnit.instructionCount !== undefined && selectedUnit.instructionCount !== null ? ` · ${selectedUnit.instructionCount.toLocaleString()} instruction rows` : ''}{selectedUnit.binarySignature ? ` · ${selectedUnit.binarySignature} ISeq` : ''}</p>}
                {selectedUnit.structuredBytecode && <details className={styles.attemptHistory}>
                  <summary>Structured ISeq evidence · {selectedUnit.structuredBytecode.sequenceCount} sequences · {selectedUnit.structuredBytecode.instructionCount} instructions</summary>
                  <p className={styles.sourcePreviewNote}>MRI exposes this version-specific bytecode structure for analysis. Operands and nested sequence references are evidence; this view is not recovered Ruby source.{selectedUnit.structuredBytecode.truncated ? ' The stored structure was capped.' : ''}</p>
                  {selectedUnit.structuredBytecode.sequences.map((sequence) => <details key={sequence.id}>
                    <summary>{sequence.label} · {sequence.type}{sequence.firstLine === null ? '' : ` · line ${sequence.firstLine}`} · {sequence.instructions.length} rows{sequence.truncated ? ' · capped' : ''}</summary>
                    <p>Locals: {sequence.locals.length ? sequence.locals.join(', ') : 'none recorded'}</p>
                    {sequence.parameters !== null && <p>Parameters: <code>{JSON.stringify(sequence.parameters)}</code></p>}
                    {sequence.catchTable.length > 0 && <p>Catch table: <code>{JSON.stringify(sequence.catchTable)}</code></p>}
                    {sequence.controlFlow && <div><p>Label-derived control flow · {sequence.controlFlow.blocks.length} blocks{sequence.controlFlow.unresolvedEdges ? ` · ${sequence.controlFlow.unresolvedEdges} unresolved edges` : ''}{sequence.controlFlow.truncated ? ' · incomplete' : ''}</p><ol>{sequence.controlFlow.blocks.map((block) => <li key={block.id}>B{block.id} · instructions {block.startIndex}–{block.endIndex}{block.successors.length ? ` → ${block.successors.map((edge) => edge.blockId === undefined ? `${edge.label || '?'} (${edge.kind})` : `B${edge.blockId} (${edge.kind})`).join(', ')}` : ' · exit'}</li>)}</ol></div>}
                    <pre>{sequence.instructions.map((instruction, index) => `${String(index).padStart(4, '0')}  ${instruction.event || instruction.opcode || 'unknown'}${instruction.operands.length ? `  ${JSON.stringify(instruction.operands)}` : ''}`).join('\n')}</pre>
                  </details>)}
                </details>}
              </div>
            </section>
          : selectedUnit && selectedSourceUrl && <section className={styles.maintainPanel} aria-labelledby="code-maintain-heading">
          <div>
            <h3 id="code-maintain-heading"><WandSparkles size={16} /> Reverse engineer into maintainable code</h3>
            <p>Use decompiled source, related classes, bytecode, and project memory to recover intent and keep names consistent. AI drafts are stored with this project for follow-up work; review and save a maintained copy before its names become trusted project-wide evidence. The original decompilation stays intact.</p>
          </div>
          <section className={styles.classReferences} aria-label="Persistent code-unit project note">
            <div><strong>Project note for this code unit</strong><span>Saved in the database and supplied to future rewrites, explanations, and agent dossiers for this exact unit as untrusted background context. Keep evidence and naming hints specific.</span></div>
            {projectNoteQuery.isLoading && <p className={styles.message}>Loading saved project note…</p>}
            {projectNoteQuery.isError && <p className={styles.error} role="alert">{projectNoteQuery.error instanceof Error ? projectNoteQuery.error.message : 'Could not load the saved project note'}</p>}
            {projectNoteQuery.data?.unitId === selectedUnit.id && projectNoteQuery.data.stale && <p className={styles.message}>This note was saved against a different source hash, so it is withheld from AI context. Review and save it again for the current source.</p>}
            <label className={styles.explainField}>Shared code-unit note
              <textarea value={visibleProjectNote} maxLength={3000} rows={3} onChange={(event) => {
                setProjectNoteDraft({ unitId: selectedUnit.id, note: event.target.value })
                setProjectNoteStatus('')
                setProjectNoteError('')
              }} placeholder="Record evidence-backed facts, unresolved questions, or naming conventions for this unit." />
            </label>
            <button type="button" className={styles.copyButton} onClick={() => void saveProjectNote()} disabled={savingProjectNote || projectNoteQuery.isLoading || projectNoteQuery.isError || visibleProjectNote.length > 3000}>
              {savingProjectNote ? 'Saving project note…' : 'Save project note'}
            </button>
            {projectNoteStatus && <p className={styles.message} role="status">{projectNoteStatus}</p>}
            {projectNoteError && <p className={styles.error} role="alert">{projectNoteError}</p>}
          </section>
          {explanationProvidersQuery.isLoading && <p className={styles.message}>Loading saved providers…</p>}
          {explanationProvidersQuery.isError && <p className={styles.error}>Could not load saved AI providers.</p>}
          {!explanationProvidersQuery.isLoading && !explanationProvidersQuery.isError && explanationProviders.length === 0 && <p className={styles.message}>No OpenAI-compatible provider is saved yet. <a href="/settings">Add one in Settings</a>.</p>}
          {explanationProviders.length > 0 && <>
            <label className={styles.explainField}>Saved provider
              <select value={selectedProviderId} onChange={(event) => { setProviderId(event.target.value); setSafeRenameSuggestions(null); setSelectedSafeRenameIds(new Set()) }}>
                {explanationProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.modelIdentifier}</option>)}
              </select>
            </label>
            <label className={styles.explainField}>Evidence reviewer
              <select value={selectedReviewerProviderId} onChange={(event) => setReviewerProviderId(event.target.value)}>
                <option value="">Use rewrite provider</option>
                {explanationProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.modelIdentifier}</option>)}
              </select>
            </label>
            <p className={styles.message}>The reviewer makes a separate advisory check after each rewrite. Choosing another provider uses an additional model call.</p>
            <label className={styles.explainField}>Reverse-engineering guidance (optional)
              <textarea value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1000} rows={3} placeholder="For example: recover the purpose of short names and simplify generated control flow." />
            </label>
          </>}
          {safeRenameSupported && <section className={styles.classReferences} aria-label="Scope-safe identifier renaming">
            <div><strong>Suggest names, apply them through lexical scopes</strong><span>The configured model uses source and reviewed project names to suggest bindings. {safeRenameGo ? 'Go AST and go/types rename selected local bindings by object identity, reject name capture, and reparse the output.' : safeRenamePython ? 'LibCST renames selected function-local variables and parameters; module-level names and imports are excluded.' : safeRenamePhp ? 'Phpactor resolves function-local variables and parameters; PHP lint checks the resulting syntax. Project-wide names and dynamic lookups are not renamed.' : safeRenameRuby ? 'Solargraph resolves same-file local variables and parameters; Ripper limits edits to local identifier tokens and ruby -c checks syntax. Keyword labels, project-wide references, and behavior are not checked.' : safeRenameRust ? 'rust-analyzer resolves selected local bindings and their same-file references; dependency builds and behavior are not checked.' : safeRenameCpp ? 'clangd resolves same-file C/C++ local variables and parameters. Macro, conditional-compilation, and template source is excluded; builds and behavior are not checked.' : safeRenameJava ? 'javac resolves selected Java local bindings and checks the renamed source; project dependencies and behavior are not checked.' : safeRenameCSharp ? 'Roslyn resolves selected C# local bindings and parses the renamed source; project references and behavior are not checked.' : safeRenameLuau ? 'Luau LSP resolves selected local bindings and applies same-file edits; the result receives a syntax check without executing it.' : safeRenameLua ? 'LuaLS resolves selected local bindings and applies same-file edits; behavior is not checked.' : 'Babel applies selected JavaScript or TypeScript renames and checks syntax and scope collisions.'} Structural validation does not verify behavior.</span></div>
            <button type="button" className={styles.copyButton} onClick={() => void suggestSafeRenames()} disabled={!selectedProviderId || suggestingSafeRenames || applyingSafeRenames || transforming || sourceByteLength === null || safeRenameSourceByteLength > 64 * 1024 || sourceQuery.isError}>
              {suggestingSafeRenames ? 'Checking source and suggesting names…' : 'Suggest scope-safe renames'}
            </button>
            {safeRenameSourceByteLength > 64 * 1024 && <p className={styles.message}>AI rename suggestions are limited to editable source of 64 KiB or less.</p>}
            {safeRenameSuggestions && safeRenameSuggestions.renames.length > 0 && <div className={styles.attemptHistory}>
              <p>{safeRenameSuggestions.renames.length} saved, unreviewed proposals from {safeRenameSuggestions.providerName} · {safeRenameSuggestions.model}. They are recorded in project attempt history and are not applied until selected. Source SHA-256: {safeRenameSuggestions.sourceSha256.slice(0, 16)}…</p>
              <ul>{safeRenameSuggestions.renames.map((proposal) => <li key={proposal.bindingId}>
                <label className={styles.explainField}>
                  <input type="checkbox" checked={selectedSafeRenameIds.has(proposal.bindingId)} onChange={(event) => setSelectedSafeRenameIds((current) => {
                    const next = new Set(current)
                    if (event.target.checked) next.add(proposal.bindingId)
                    else next.delete(proposal.bindingId)
                    return next
                  })} />
                  <strong>{proposal.oldName} → {proposal.newName}</strong> · {proposal.kind} · {proposal.referenceCount} reference{proposal.referenceCount === 1 ? '' : 's'}
                  <span>{proposal.rationale}</span>
                </label>
              </li>)}</ul>
              <button type="button" className={styles.explainButton} onClick={() => void applySelectedSafeRenames()} disabled={selectedSafeRenameIds.size === 0 || applyingSafeRenames || suggestingSafeRenames || transforming}>
                {applyingSafeRenames ? 'Applying and saving draft…' : `Apply ${selectedSafeRenameIds.size} selected rename${selectedSafeRenameIds.size === 1 ? '' : 's'}`}
              </button>
            </div>}
            {safeRenameStatus && <p className={styles.message} role="status">{safeRenameStatus}</p>}
          </section>}
          {largeSource && !memberOutlineEligible && <p className={styles.message}>This source exceeds the single request limit, and function-level rewriting is unavailable for this code unit.</p>}
          {memberOutlineEligible && sourceByteLength !== null && sourceByteLength > MAX_MEMBER_OUTLINE_BYTES && <p className={styles.message}>Function and method outlining is limited to source files of 2 MiB or less.</p>}
          {memberOutlineAvailable && <section className={styles.classReferences} aria-label="Function and method outline">
            <div><strong>Reverse engineer functions and methods with AI agents</strong><span>Run one member at a time or select a batch for parallel agents. Each worker runs up to three at once. Every attempt uses saved project context; completed results are merged into the editable copy for review.</span></div>
            {memberOutlineQuery.isLoading && <p className={styles.message}>Reading function and method outline…</p>}
            {memberOutlineQuery.isError && <p className={styles.error} role="alert">{memberOutlineQuery.error instanceof Error ? memberOutlineQuery.error.message : 'Could not read the function and method outline'}</p>}
            {memberOutlineQuery.data && <>
              <label className={styles.explainField}>Find a function or method
                <input value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)} placeholder="Filter by function or method name" />
              </label>
              {memberOutlineQuery.data.unsupported && <p className={styles.message}>No Tree-sitter grammar is available for {selectedUnit?.language || 'this source'} yet. File-level reverse engineering is still available.</p>}
              {!memberOutlineQuery.data.unsupported && memberOutlineQuery.data.members.length === 0 && <p className={styles.message}>No functions or methods with bodies were found in this source.</p>}
              {memberOutlineQuery.data.members.length > 0 && filteredMembers.length === 0 && <p className={styles.message}>No functions or methods match this filter.</p>}
              {filteredMembers.length > 0 && <div className={styles.functionAgentControls}>
                <span>Select up to 10 functions for parallel AI agents. Results use the saved project context and return to this editor for review.</span>
                <div>
                  <button type="button" className={styles.copyButton} onClick={() => setSelectedAgentMembers(new Set(filteredMembers.filter((member) => member.source_bytes <= MAX_MEMBER_REWRITE_BYTES).map((member) => `${member.start_byte}:${member.end_byte}`).slice(0, 10)))} disabled={agentTeamRunning || transforming}>Select first 10 visible</button>
                  <button type="button" className={styles.copyButton} onClick={() => setSelectedAgentMembers(new Set())} disabled={agentTeamRunning || transforming || selectedAgentMembers.size === 0}>Clear selection</button>
                  <button type="button" className={styles.explainButton} onClick={() => void runAgentTeam(filteredMembers.filter((member) => selectedAgentMembers.has(`${member.start_byte}:${member.end_byte}`)))} disabled={!selectedProviderId || agentTeamRunning || transforming || selectedAgentMembers.size === 0 || selectedAgentMembers.size > 10 || maintainedDraftDiffersFromSource || sourceQuery.isError}>
                    {agentTeamRunning ? 'Agents working…' : `Run ${selectedAgentMembers.size} function agent${selectedAgentMembers.size === 1 ? '' : 's'}`}
                  </button>
                </div>
                {!explanationProvidersQuery.isLoading && !explanationProvidersQuery.isError && explanationProviders.length === 0 && <small>No AI provider is configured, so function agents cannot run yet. <a href="/settings">Add an OpenAI-compatible provider in Settings</a>.</small>}
                {maintainedDraftDiffersFromSource && <small>Reset the maintained editor to current decompilation before starting a parallel batch, so function results can be merged at stable source ranges.</small>}
              </div>}
              <ul>{filteredMembers.map((member) => {
                const key = `${member.start_byte}:${member.end_byte}`
                const tooLarge = member.source_bytes > MAX_MEMBER_REWRITE_BYTES
                return <li key={key} className={styles.functionAgentRow}>
                  <label className={styles.functionAgentChoice}>
                    <input type="checkbox" checked={selectedAgentMembers.has(key)} disabled={agentTeamRunning || transforming || tooLarge || rewrittenMembers.has(key)} onChange={(event) => setSelectedAgentMembers((current) => {
                      const next = new Set(current)
                      if (event.target.checked && next.size < 10) next.add(key)
                      else next.delete(key)
                      return next
                    })} aria-label={`Select ${member.kind} ${member.name} for an AI agent`} />
                  </label>
                  <button type="button" className={styles.copyButton} onClick={() => void deobfuscateMember(member)} disabled={!selectedProviderId || transforming || agentTeamRunning || tooLarge || rewrittenMembers.has(key) || sourceQuery.isError} title={tooLarge ? 'This function or method exceeds the single request limit' : undefined}>
                    {member.kind} {member.name} · line {member.line} · {formatBytes(member.source_bytes)}{rewrittenMembers.has(key) ? ' · rewritten' : tooLarge ? ' · too large' : ''}
                  </button>
                </li>
              })}</ul>
              {(codeDraftQuery.data?.agentBatch?.attempts.length ?? 0) > 0 && <section className={styles.attemptHistory} aria-live="polite" aria-label="Saved function agent batch progress">
                <h4>Saved function agent batch</h4>
                <p>{codeDraftQuery.data?.agentBatch?.attempts.filter((attempt) => attempt.status === 'SUCCEEDED').length ?? 0} of {codeDraftQuery.data?.agentBatch?.attempts.length ?? 0} functions ready. This batch is stored in project history and keeps updating if you reload.</p>
                <ol>{codeDraftQuery.data?.agentBatch?.attempts.map((attempt) => <li key={attempt.id}>
                  <strong>{attempt.memberName}</strong> · {attempt.status === 'QUEUED' ? 'Queued' : attempt.status === 'RUNNING' ? attempt.cancelRequested ? 'Cancelling' : 'Working' : attempt.status === 'SUCCEEDED' ? 'Ready to review' : attempt.status === 'CANCELLED' ? 'Cancelled' : 'Failed'}
                  {attempt.errorMessage && <p>{attempt.errorMessage}</p>}
                  {attempt.context && <RewriteContextDetails context={attempt.context} />}
                  {attempt.qualityReview && <CodeQualityReviewDetails review={attempt.qualityReview} />}
                </li>)}</ol>
                {codeDraftQuery.data?.agentBatch && codeDraftQuery.data.agentBatch.attempts.some((attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING') && <button type="button" className={styles.copyButton} onClick={() => void cancelFunctionAgentBatch(codeDraftQuery.data!.agentBatch!.id)} disabled={agentTeamDispatching || cancellingAgentBatch}>
                  {cancellingAgentBatch ? 'Requesting batch cancellation…' : 'Cancel remaining function agents'}
                </button>}
                {codeDraftQuery.data?.agentBatch && <button type="button" className={styles.explainButton} onClick={() => void applySavedFunctionAgentResults()} disabled={agentTeamRunning || maintainedDraftDiffersFromSource || savingDraft || codeDraftQuery.data.agentBatch.attempts.some((attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING') || !codeDraftQuery.data.agentBatch.attempts.some((attempt) => attempt.status === 'SUCCEEDED')}>
                  Apply completed agent results to the maintained editor
                </button>}
              </section>}
              {memberOutlineQuery.data.members.length > filteredMembers.length && <p className={styles.message}>Showing {filteredMembers.length} functions or methods. Filter the list to find others.</p>}
              {memberOutlineQuery.data.truncated && <p className={styles.message}>The outline reached its 10,000 member limit; some functions or methods may not be listed.</p>}
            </>}
          </section>}
          {maintenanceError && <p className={styles.error} role="alert">{maintenanceError}</p>}
          {transforming && activeRewriteAttemptId && <button type="button" className={styles.copyButton} onClick={() => void cancelActiveCodeRewrite()} disabled={cancellingRewrite}>
            {cancellingRewrite ? 'Cancelling rewrite…' : 'Cancel rewrite'}
          </button>}
          {maintenanceMeta && <p className={styles.message}>Reverse-engineered draft from {maintenanceMeta.providerName} · {maintenanceMeta.model}. {validationSummary(maintenanceMeta)}</p>}
          {(codeDraftQuery.data?.attempts?.length ?? 0) > 0 && <section className={styles.attemptHistory} aria-label="Recent AI rewrite attempts">
            <h4>Recent AI attempts for this source version</h4>
            <ol>{codeDraftQuery.data?.attempts?.map((attempt) => <li key={attempt.id}>
              <details>
                <summary>
                  <strong>{attempt.scope === 'rename-suggestions' && attempt.status === 'SUCCEEDED' ? 'Suggestions saved' : attempt.status === 'SUCCEEDED' ? 'Completed' : attempt.status === 'FAILED' ? 'Failed' : attempt.status === 'CANCELLED' ? 'Cancelled' : attempt.status === 'QUEUED' ? 'Queued' : attempt.cancelRequested ? 'Cancelling' : attempt.status === 'RUNNING' ? 'Running' : 'Interrupted'}</strong>
                  <span>{attempt.providerName} · {attempt.modelIdentifier} · {attempt.scope} · {new Date(attempt.createdAt).toLocaleString()}</span>
                </summary>
                {codeDraftQuery.data?.draft?.sourceAttemptId === attempt.id && <p>This attempt produced the current saved draft.</p>}
                {attempt.question && <p>Request: {attempt.question}</p>}
                {attempt.context && <RewriteContextDetails context={attempt.context} />}
                {attempt.qualityReview && <CodeQualityReviewDetails review={attempt.qualityReview} />}
                {attempt.renameProposals && attempt.renameProposals.length > 0 && <ul>{attempt.renameProposals.map((proposal) => <li key={proposal.bindingId}><strong>{proposal.oldName} → {proposal.newName}</strong> · {proposal.kind} · {proposal.referenceCount} reference{proposal.referenceCount === 1 ? '' : 's'}<p>{proposal.rationale}</p></li>)}</ul>}
                {attempt.scope === 'rename-suggestions' && attempt.renameProposals && attempt.renameProposals.length > 0 && <button type="button" className={styles.copyButton} onClick={() => void loadSavedSafeRenames(attempt)} disabled={!selectedProviderId || !attempt.proposalSourceSha256 || !attempt.proposalProviderId || !attempt.projectSymbolContextSha256 || !(maintainedDraft || sourceQuery.data)}>Load saved proposals into rename review</button>}
                {attempt.validationStatus && <p>{validationSummary(attempt)}</p>}
                {attempt.status === 'SUCCEEDED' && !attempt.validationStatus && <p>{validationSummary(attempt)}</p>}
                {attempt.errorMessage && <p className={styles.error}>{attempt.errorMessage}{attempt.errorCode ? ` (${attempt.errorCode})` : ''}</p>}
                {attempt.status === 'SUCCEEDED' && attempt.resultSource && <button type="button" className={styles.copyButton} onClick={() => void restoreCodeAttempt(attempt)} disabled={transforming || restoringAttemptId !== null || (attempt.scope === 'member' && !sourceQuery.data)}>
                  {restoringAttemptId === attempt.id ? 'Restoring result…' : 'Load result into editor'}
                </button>}
                {attempt.rewriteHistoryRoundCount > 0 && <SavedRewriteHistory projectId={projectId} attemptId={attempt.id} roundCount={attempt.rewriteHistoryRoundCount} />}
                {attempt.resultSource && <pre className={styles.attemptSource}><code>{attempt.resultSource}</code></pre>}
              </details>
            </li>)}</ol>
          </section>}
          {maintainedQuery.isError && <p className={styles.error} role="alert">{maintainedQuery.error instanceof Error ? maintainedQuery.error.message : 'Could not load maintained source'}</p>}
          {codeDraftQuery.isError && <p className={styles.error} role="alert">{codeDraftQuery.error instanceof Error ? codeDraftQuery.error.message : 'Could not load the saved AI draft'}</p>}
          {maintainedBaselineNeedsReview && <div className={styles.lineageWarning} role="status">
            <strong>{maintainedBaselineStatus === 'CHANGED' ? 'This maintained copy is based on older decompiler output.' : maintainedBaselineStatus === 'UNAVAILABLE' ? 'The original decompiler output for this maintained copy is unavailable.' : 'This maintained copy has no recorded decompiler baseline.'}</strong>
            <p>The saved copy remains available, but it is not current project memory. Compare it with the current decompilation and review any changes before accepting a new maintained version.</p>
            {maintainedBaselineStatus === 'CHANGED' && typeof maintainedQuery.data?.sourceLineage?.baseSourceCode === 'string' && <button type="button" className={styles.copyButton} onClick={rebaseMaintainedChanges}
              disabled={typeof sourceQuery.data !== 'string' || !maintainedDraft.trim() || hasUnresolvedRebaseConflicts}>
              Preview three-way merge in editor
            </button>}
            <button type="button" className={styles.copyButton} onClick={startMaintainedFromCurrentDecompilation} disabled={typeof sourceQuery.data !== 'string' || maintainedDraft === sourceQuery.data}>Replace editor contents with current decompilation</button>
            {(rebaseStatus || hasUnresolvedRebaseConflicts) && <p className={hasUnresolvedRebaseConflicts ? styles.error : styles.message} role="status">
              {hasUnresolvedRebaseConflicts ? 'Resolve every marked conflict section in the editor before saving a draft or accepting the source.' : rebaseStatus}
            </p>}
            {maintainedBaselineStatus === 'CHANGED' && maintainedQuery.data?.sourceLineage?.baseRunKey && <small>Saved from analysis {maintainedQuery.data.sourceLineage.baseRunKey}</small>}
          </div>}
          {maintainedQuery.data?.exists && !maintainedQuery.data.reviews?.length && <p className={styles.message}>This saved copy predates review receipts, so AI project memory will not treat it as an approved naming reference until you review and accept it here.</p>}
          {maintainedDraft && <>
            <div className={`${styles.maintainedComparison} ${maintainedBaselineNeedsReview && maintainedQuery.data?.sourceLineage?.baseSourceCode ? styles.maintainedComparisonStale : ''}`}>
              {maintainedBaselineNeedsReview && maintainedQuery.data?.sourceLineage?.baseSourceCode && <div><strong>Accepted decompiler baseline</strong>
                <SourceListing source={maintainedQuery.data.sourceLineage.baseSourceCode} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} />
              </div>}
              <div><strong>{maintainedBaselineNeedsReview ? 'Current decompilation' : 'Original decompilation'}</strong>
                {sourceQuery.data !== undefined && <SourceListing source={sourceQuery.data} language={selectedUnit.language} fileName={selectedUnit.codeArtifactId?.split('/').pop()} fullSourceUrl={selectedSourceUrl} />}
              </div>
              <label>Editable maintained copy
              <textarea ref={maintainedEditorRef} aria-label="Editable maintained source" value={maintainedDraft} spellCheck={false} onChange={(event) => { setMaintainedDraft(event.target.value); setRebaseStatus(''); setMaintenanceError(''); setMaintainedSaved(false); setJvmBuild(null); setMaintenanceMeta((current) => current ? { ...current, syntaxValidated: null, validationStatus: null, validationMethod: null, validationMessage: null } : current) }} />
              </label>
            </div>
            {hasReviewDiff && <details className={styles.reviewDiff} onToggle={(event) => setShowReviewDiff(event.currentTarget.open)}>
              <summary>Review changes against {reviewBaselineLabel}</summary>
              {reviewDiff?.unavailable && <p className={styles.message}>This source is too large for an inline diff. Compare the two source panes or open the files in your local editor.</p>}
              {reviewDiff && !reviewDiff.unavailable && <>
                <p className={styles.message}>{reviewDiff.added} lines added · {reviewDiff.removed} lines removed{reviewDiff.truncated ? ' · display limited to the first 600 diff lines' : ''}</p>
                <pre className={styles.reviewDiffCode}><code>{reviewDiff.rows.map((row, index) => <span key={`${row.kind}:${row.beforeLine}:${row.afterLine}:${index}`} className={row.kind === 'added' ? styles.reviewDiffAdded : styles.reviewDiffRemoved}>
                  <span className={styles.reviewDiffGutter}>{row.beforeLine ?? ''}\t{row.afterLine ?? ''}\t{row.kind === 'added' ? '+' : '−'}</span>{row.text || ' '}
                </span>)}</code></pre>
              </>}
            </details>}
            <label className={styles.reviewRationale}>Review rationale (required to accept, reject, or revoke)
              <textarea aria-label="Review rationale" value={reviewRationale} maxLength={1000} onChange={(event) => setReviewRationale(event.target.value)} placeholder="For acceptance, say what you checked. For rejection or revocation, explain the decision." />
            </label>
            <div className={styles.maintainedActions}>
              <button type="button" className={styles.copyButton} onClick={() => void saveCodeDraft()} disabled={savingDraft || !maintainedDraft.trim() || !maintainedDraftDiffersFromSource || maintainedDraft === draftSource || hasUnresolvedRebaseConflicts}>{savingDraft ? 'Saving draft…' : maintainedDraft === draftSource ? 'Draft saved to project memory' : 'Save draft'}</button>
              <button type="button" className={styles.explainButton} onClick={() => void saveMaintainedSource()} disabled={savingMaintained || !maintainedDraft.trim() || !maintainedDraftDiffersFromSource || reviewRationale.trim().length < 12 || hasUnresolvedRebaseConflicts}>{savingMaintained ? 'Saving…' : maintainedSaved ? 'Review and save changes' : 'Review and accept maintained copy'}</button>
              {maintainedQuery.data?.acceptedReviewId && <button type="button" className={styles.copyButton} onClick={() => void revokeMaintainedAcceptance()} disabled={savingMaintained || reviewRationale.trim().length < 12}>{savingMaintained ? 'Recording review…' : 'Revoke current acceptance'}</button>}
              <button type="button" className={styles.copyButton} onClick={() => void rejectMaintainedDraft()} disabled={savingMaintained || savingDraft || !maintainedDraft.trim() || !maintainedDraftDiffersFromSource || reviewRationale.trim().length < 12}>{savingMaintained ? 'Recording review…' : 'Reject this draft'}</button>
              {!maintainedDraftDiffersFromSource && <span className={styles.message}>Edit the decompilation or create a maintained version before saving.</span>}
              {reviewRationale.trim().length > 0 && reviewRationale.trim().length < 12 && <span className={styles.message}>Add at least 12 characters describing your review.</span>}
              {maintainedSaved && <a className={styles.copyButton} href={`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(selectedUnit.id)}?download=1`}><Download size={14} /> Download source</a>}
              {maintainedSaved && <span className={styles.savedStatus} role="status">Accepted source and review receipt saved separately</span>}
              {currentRun?.artifactName.toLowerCase().endsWith('.jar')
                && currentRun.providerId === selectedUnit.source
                && ['reamon-jadx', 'reamon-cfr', 'reamon-vineflower'].includes(selectedUnit.source)
                && selectedUnit.unitType === 'class'
                && selectedUnit.language?.toLowerCase() === 'java'
                && selectedUnit.maintainedSource && <>
                  <button type="button" className={styles.explainButton} onClick={() => void rebuildJvmJar()}
                    disabled={buildingJvm || savingMaintained || !maintainedQuery.data?.exists || maintainedQuery.data.sourceCode !== maintainedDraft}>
                    {buildingJvm ? 'Compiling accepted Java…' : 'Build derived JAR'}
                  </button>
                  {maintainedQuery.data?.exists && maintainedQuery.data.sourceCode !== maintainedDraft && <span className={styles.message}>Accept the current Java edits before building the JAR.</span>}
                  {jvmBuildError && <span className={styles.error} role="alert">{jvmBuildError}</span>}
                  {jvmBuild?.codeUnitId === selectedUnit.id && jvmBuild.sourceSha256 === maintainedQuery.data?.sourceHash && <>
                    <a className={styles.copyButton} href={jvmBuild.downloadUrl}><Download size={14} /> Download rebuilt JAR</a>
                    <span className={styles.savedStatus} role="status">
                      Built with Java {jvmBuild.javaRelease}; {jvmBuild.changedClassCount} class files compiled, {jvmBuild.removedClassCount} stale nested classes removed · sha256:{jvmBuild.sha256.slice(0, 16)}
                    </span>
                    {jvmBuild.diagnostics && <span className={styles.message}>{jvmBuild.diagnostics}</span>}
                    <span className={styles.message}>{jvmBuild.warnings}</span>
                  </>}
                </>}
              {reviewStatus && <span className={styles.savedStatus} role="status">{reviewStatus}</span>}
            </div>
            {(maintainedQuery.data?.acceptedRenameAliases?.length || 0) > 0 && <section className={styles.reviewHistory} aria-label="Accepted rename history">
              <strong>Accepted project rename history</strong>
              <p className={styles.message}>These binding-specific mappings came from a scope-safe rename attempt whose exact output was accepted. They are naming context, not proof of behavior.</p>
              <ul>{maintainedQuery.data?.acceptedRenameAliases?.map((alias) => <li key={alias.bindingId}>
                <code>{alias.oldName} → {alias.newName}</code><small>{alias.kind} · binding {alias.bindingId.slice(0, 8)}</small>
              </li>)}</ul>
            </section>}
            {(maintainedQuery.data?.reviews?.length || 0) > 0 && <section className={styles.reviewHistory} aria-label="Review history">
              <strong>Recent acceptance and rejection receipts</strong>
              <ol>{maintainedQuery.data?.reviews?.map((review) => <li key={review.id}>
                <span>{review.decision.toLowerCase()} by {review.reviewerId} · {new Date(review.createdAt).toLocaleString()}</span>
                {review.validationStatus && <small>Syntax validation: {review.validationStatus.toLowerCase()}{review.validationMethod ? ` · ${review.validationMethod}` : ''}{review.validationMessage ? ` · ${review.validationMessage}` : ''}</small>}
                <p>{review.rationale}</p>
                <code>sha256:{review.maintainedSourceHash}</code>
                {review.decision === 'ACCEPTED' && review.sourceAvailable && review.maintainedSourceHash !== maintainedQuery.data?.sourceHash && <button type="button" className={styles.copyButton} onClick={() => void loadAcceptedMaintainedRevision(review)} disabled={Boolean(loadingMaintainedRevisionId)}>{loadingMaintainedRevisionId === review.id ? 'Loading…' : 'Load this accepted version'}</button>}
                {review.decision === 'ACCEPTED' && !review.sourceAvailable && <small>Source snapshot unavailable for this older receipt.</small>}
              </li>)}</ol>
            </section>}
          </>}
        </section>}
        {selectedUnit && selectedSourceUrl && <section className={styles.explainPanel} aria-labelledby="code-explain-heading">
          <div>
            <h3 id="code-explain-heading">{selectedUnit.isExecutableSource === false ? 'Explain this bytecode evidence with AI' : 'Explain this code with AI'}</h3>
            <p>{selectedUnit.isExecutableSource === false ? 'The saved provider receives this version-matched YARV disassembly and its project evidence. Check any explanation against the instruction listing; it is not reconstructed Ruby source.' : 'When you choose Explain, this code is sent to the selected saved provider. API keys stay on the server. Check the explanation against the code before relying on it.'}</p>
          </div>
          {explanationProvidersQuery.isLoading && <p className={styles.message}>Loading saved providers…</p>}
          {explanationProvidersQuery.isError && <p className={styles.error}>Could not load saved AI providers.</p>}
          {!explanationProvidersQuery.isLoading && !explanationProvidersQuery.isError && explanationProviders.length === 0 && <p className={styles.message}>No OpenAI-compatible provider is saved yet. <a href="/settings">Add one in Settings</a>.</p>}
          {explanationProviders.length > 0 && <>
            <label className={styles.explainField}>Saved provider
              <select value={selectedProviderId} onChange={(event) => { setProviderId(event.target.value); setSafeRenameSuggestions(null); setSelectedSafeRenameIds(new Set()) }}>
                {explanationProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.modelIdentifier}</option>)}
              </select>
            </label>
            <label className={styles.explainField}>Question about {selectedUnit.isExecutableSource === false ? 'these instructions' : 'this code'} (optional)
              <textarea value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1000} rows={3} placeholder={selectedUnit.isExecutableSource === false ? 'What does this instruction sequence appear to do?' : 'What state does this method change?'} />
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
