'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, KeyRound, Loader2, Lock, Play, Plus, SlidersHorizontal, Square, Swords, Table2, Terminal, Trash2, X } from 'lucide-react'
import { useProject } from '@/providers/ProjectProvider'
import { useAiAttackSurface } from '@/hooks/useAiAttackSurface'
import { useScanStartFailure } from '@/hooks/useScanStartFailure'
import {
  ALL_CARDS, ATTACK_CHIPS, resolveAuth, splitUrl,
  type AuthMode, type ChipKey, type CustomTarget, type ToolCard,
} from '@/lib/aiAttackSurface'
import { WikiInfoButton } from '@/components/ui'
import styles from './page.module.css'
import { UpdatedAtCell, UpdatedAtTh, sortByUpdatedAt, useUpdatedAtSortDir } from '@/app/graph/components/RedZoneTables/updatedAt'
import { NodeIdCell, NodeIdTh } from '@/app/graph/components/RedZoneTables/nodeId'

const CHIP_BLUE = '#3b82f6'

function Chip({ chip, dim }: { chip: ChipKey; dim?: boolean }) {
  const m = ATTACK_CHIPS[chip]
  return (
    <span className={styles.chip} title={`${m.definition} (${m.owasp})`}
          style={{ borderColor: CHIP_BLUE, color: CHIP_BLUE, opacity: dim ? 0.35 : 1 }}>
      {m.label}
    </span>
  )
}

function sevColor(sev: string): string {
  return { critical: '#dc2626', high: '#ef4444', medium: '#f59e0b', low: '#3b82f6', info: '#9ca3af' }[sev] || '#9ca3af'
}

export default function AiAttackSurfacePage() {
  const { projectId } = useProject()
  const s = useAiAttackSurface(projectId)
  const { sortDir, toggleSort } = useUpdatedAtSortDir()
  // Scan Queue (Phase 3): a temporary launch refusal offers Cancel / Add to queue.
  const { handleStartFailure } = useScanStartFailure(projectId)
  const [filters, setFilters] = useState<Set<ChipKey>>(new Set())
  const [openTool, setOpenTool] = useState<string | null>(null)

  // garak detail-view state
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set())
  const [selectedProbes, setSelectedProbes] = useState<Set<string>>(
    new Set(['promptinject', 'dan', 'encoding', 'leakreplay']),
  )
  const [trials, setTrials] = useState(1)
  const [asrThreshold, setAsrThreshold] = useState(0.3)
  const [judgeModel, setJudgeModel] = useState('qwen2.5:0.5b')
  const [maxTurns, setMaxTurns] = useState(4)
  const [seed, setSeed] = useState(0)
  // Concurrent requests per tool (garak --parallel_attempts / promptfoo eval
  // concurrency). Default 2 - safe for a slow/CPU target; raise for GPU.
  const [parallelism, setParallelism] = useState(2)
  // Hard wall-clock budget for the whole tool run, in MINUTES. Default 600 (10h)
  // - big multi-family sweeps + slow probes need room before they're killed.
  const [timeoutMin, setTimeoutMin] = useState(600)
  const [roeConfirmed, setRoeConfirmed] = useState(false)
  // Shared: free-text description of the target app. Lifts giskard/promptfoo/pyrit.
  const [targetPurpose, setTargetPurpose] = useState('')
  // promptfoo: payload-mutation strategies. pyrit: optional custom objective.
  const [selectedStrategies, setSelectedStrategies] = useState<Set<string>>(new Set(['basic']))
  const [objective, setObjective] = useState('')

  // Shared: target auth (None / Bearer / Custom header) - reused by every tool.
  const [authMode, setAuthMode] = useState<AuthMode>('none')
  const [bearerToken, setBearerToken] = useState('')
  const [customHeaderName, setCustomHeaderName] = useState('x-api-key')
  const [customHeaderValue, setCustomHeaderValue] = useState('')

  // Shared: custom (off-graph) targets the operator types in.
  const [customTargets, setCustomTargets] = useState<CustomTarget[]>([])
  const [customUrl, setCustomUrl] = useState('')
  const [customIface, setCustomIface] = useState('llm-chat')
  const [customModel, setCustomModel] = useState('')
  const [customErr, setCustomErr] = useState<string | null>(null)

  useEffect(() => {
    if (projectId) {
      s.loadTargets()
      s.loadFindings()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Keep the log viewport pinned to the bottom as new lines stream in.
  const logsRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = logsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [s.logs])

  const hasChat = s.targets.length > 0
  const targetKey = (t: { baseUrl: string; path: string }) => `${t.baseUrl}|${t.path}`

  const cards = useMemo<ToolCard[]>(
    () => (filters.size
      ? ALL_CARDS.filter((c) => Array.from(filters).every((chip) => c.chips.includes(chip)))
      : ALL_CARDS),
    [filters],
  )

  const toggleFilter = (k: ChipKey) =>
    setFilters((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    apply(next)
  }

  const addCustomTarget = () => {
    const parsed = splitUrl(customUrl)
    if (!parsed) {
      setCustomErr('Enter a full URL, e.g. https://api.example.com/v1/chat/completions')
      return
    }
    if (!customModel.trim()) {
      setCustomErr('Enter the target model id (e.g. qwen2.5:0.5b) - sent as the "model" field in each request')
      return
    }
    setCustomErr(null)
    setCustomTargets((prev) => [...prev, {
      baseUrl: parsed.baseUrl, path: parsed.path, method: 'POST',
      interfaceType: customIface, model: customModel.trim(),
    }])
    setCustomUrl('')
    setCustomModel('')
  }

  // The tool whose detail view is open (garak / pyrit / …).
  const openCard = ALL_CARDS.find((c) => c.id === openTool && c.available) || null
  // Probes the operator can actually run: families needing a capability our
  // black-box HTTP chat target lacks (`requires`) are excluded from the count,
  // the grid and Select-all. (Inactive-by-default garak families that would
  // abort the run are dropped from the catalog entirely, not just hidden.)
  const runnableProbes = openCard ? openCard.probes.filter((p) => !p.requires) : []

  // The card's default probe selection: families flagged `default`, else its first.
  const defaultProbeIds = (card: ToolCard): string[] => {
    const flagged = card.probes.filter((p) => p.default).map((p) => p.id)
    return flagged.length ? flagged : card.probes.slice(0, 1).map((p) => p.id)
  }

  // Open a tool's detail view, defaulting its strategy selection.
  const openConfig = (card: ToolCard) => {
    if (openTool === card.id) { setOpenTool(null); return }
    setOpenTool(card.id)
    setSelectedProbes(new Set(defaultProbeIds(card)))
  }

  const launchTool = async () => {
    if (!openCard) return
    const chosen = s.targets.filter((t) => selectedTargets.has(targetKey(t)))
    const graphTargets = chosen.map((t) => ({ baseurl: t.baseUrl, path: t.path, method: t.method }))
    const custom = customTargets.map((c) => ({
      baseurl: c.baseUrl, path: c.path, method: c.method,
      interface_type: c.interfaceType, model: c.model || undefined, custom: true,
    }))
    const auth = resolveAuth({
      mode: authMode, bearerToken,
      headerName: customHeaderName, headerValue: customHeaderValue,
    })
    const payload = {
      tool: openCard.id,
      targets: [...graphTargets, ...custom],
      bounds: { trials, asr_threshold: asrThreshold, judge_model: judgeModel, max_turns: maxTurns, seed, parallelism, timeout: timeoutMin * 60 },
      roe_confirmed: roeConfirmed,
      probes: Array.from(selectedProbes),
      strategies: openCard.id === 'promptfoo' ? Array.from(selectedStrategies) : undefined,
      objective: openCard.id === 'pyrit' && objective.trim() ? objective.trim() : undefined,
      target_purpose: targetPurpose.trim() || undefined,
      ...auth,
    }
    const state = await s.launch(payload)
    if (!state) {
      // A launch carrying an inline api_key is not queueable; the handler shows
      // Cancel only in that case (Scan Queue Phase 3).
      await handleStartFailure('ai_attack', s.getLastStartError?.(), payload as Record<string, unknown>)
    }
  }

  const totalTargets = selectedTargets.size + customTargets.length
  const running = s.run?.status === 'running' || s.run?.status === 'starting'
  const canLaunch = totalTargets > 0 && selectedProbes.size > 0 && roeConfirmed && !s.launching && !running

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}><Swords size={22} /> AI Gauntlet</h1>
          <p className={styles.subtitle}>
            Deterministic offensive testing of the AI surface recon discovered.
            <span className={styles.discovered}> {s.targets.length} LLM endpoint(s) discovered</span>
          </p>
        </div>
        <div className={styles.headerActions}>
          <WikiInfoButton
            target="https://github.com/samugit83/redamon/wiki/AI-Gauntlet"
            title="Open the AI Gauntlet wiki"
            size={16}
          />
          <Link href="/graph?table=aiRisk&sheet=testedVulns" className={styles.showFindings}>
            <Table2 size={14} /> Show findings
          </Link>
          <Link href="/graph" className={styles.backBtn}>
            <ArrowLeft size={14} /> Back to Red Zone
          </Link>
        </div>
      </div>

      {/* Filter bar - the shared chip vocabulary */}
      <div className={styles.filterBar}>
        <span className={styles.filterLabel}>Filter by attack:</span>
        {(Object.keys(ATTACK_CHIPS) as ChipKey[]).map((k) => (
          <button key={k} type="button"
                  className={`${styles.filterChip} ${filters.has(k) ? styles.filterChipActive : ''}`}
                  style={{ borderColor: CHIP_BLUE, color: CHIP_BLUE }}
                  onClick={() => toggleFilter(k)}>
            {ATTACK_CHIPS[k].label}
          </button>
        ))}
        {filters.size > 0 && (
          <button type="button" className={styles.filterClear} onClick={() => setFilters(new Set())}>
            Clear
          </button>
        )}
      </div>

      {/* Card grid */}
      <div className={styles.grid}>
        {cards.map((card) => {
          // Greyed only when the tool isn't shipped. Even with no discovered
          // endpoint the card opens, so an operator can add a custom target.
          const greyed = !card.available
          // This tool's scan is in flight -> show a spinner and block (re)launch.
          const isRunning = running && s.run?.tool === card.id
          // While ANY scan runs, lock every OTHER tool: opening its config would
          // show that tool's settings next to the running tool's logs (confusing),
          // and only one scan can run at a time anyway.
          const lockedByRun = running && !isRunning
          return (
            <div key={card.id} className={`${styles.card} ${greyed ? styles.cardGreyed : ''} ${isRunning ? styles.cardRunning : ''} ${lockedByRun ? styles.cardLocked : ''}`}>
              <div className={styles.cardName}>
                <span className={styles.cardNameText}>
                  {card.name}
                  {isRunning && <Loader2 size={15} className={styles.spin} />}
                </span>
                <span className={styles.cardStyle}>{card.style}</span>
              </div>
              <div className={styles.cardPurpose}>{card.purpose}</div>
              <div className={styles.cardMeta}>
                <span className={styles.requires}>
                  Requires: {card.requires}{!hasChat && card.available ? ' (none found)' : ''}
                </span>
              </div>
              <div className={styles.cardFooter}>
                <div className={styles.cardChips}>
                  {card.chips.map((c) => <Chip key={c} chip={c} dim={filters.size > 0 && !filters.has(c)} />)}
                </div>
                <div className={styles.cardActions}>
                  {!card.available && <span className={styles.soon}>coming soon</span>}
                  {card.available && (
                    <button type="button"
                            className={`${styles.launchBtn} ${openTool === card.id ? styles.launchBtnOpen : ''}`}
                            disabled={greyed || lockedByRun}
                            title={lockedByRun ? 'A scan is running - stop it to configure another tool' : undefined}
                            onClick={() => openConfig(card)}>
                      {isRunning
                        ? <><Loader2 size={14} className={styles.spin} /> Running…</>
                        : lockedByRun
                          ? <><Lock size={14} /> Locked</>
                          : openTool === card.id
                            ? <><X size={14} /> Close</>
                            : <><SlidersHorizontal size={14} /> Configure &amp; launch</>}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* garak detail view (four blocks) */}
      {openCard && (
        <div className={styles.detail}>
          <h2 className={styles.detailTitle}>{openCard.name} - configure run</h2>

          {/* 1. Targets */}
          <section className={styles.block}>
            <h3 className={styles.blockTitle}>1. Targets</h3>
            {s.loadingTargets && <p className={styles.muted}>Loading…</p>}
            {!s.loadingTargets && s.targets.length === 0 && (
              <p className={styles.muted}>No llm-chat/completion endpoints in this project. Run AI Surface Recon first.</p>
            )}
            {s.targets.map((t) => {
              const k = targetKey(t)
              return (
                <label key={k} className={styles.row}>
                  <input type="checkbox" checked={selectedTargets.has(k)}
                         onChange={() => toggle(selectedTargets, k, setSelectedTargets)} />
                  <span className={styles.rowMain}>{t.baseUrl}{t.path}</span>
                  <span className={styles.rowCtx}>{t.interfaceType}{t.modelFamily ? ` · ${t.modelFamily}` : ''}</span>
                </label>
              )
            })}

            {/* Custom (off-graph) targets */}
            {customTargets.map((c, i) => (
              <div key={`custom-${i}`} className={styles.row}>
                <span className={styles.customTag}>custom</span>
                <span className={styles.rowMain}>{c.baseUrl}{c.path}</span>
                <span className={styles.rowCtx}>{c.interfaceType}{c.model ? ` · ${c.model}` : ''}</span>
                <button type="button" className={styles.iconBtn}
                        onClick={() => setCustomTargets((p) => p.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}

            <div className={styles.customForm}>
              <span className={styles.customFormLabel}>Attack a URL not in the graph:</span>
              <input type="text" placeholder="https://api.example.com/v1/chat/completions"
                     value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} className={styles.customUrl} />
              <select value={customIface} onChange={(e) => setCustomIface(e.target.value)}>
                <option value="llm-chat">llm-chat</option>
                <option value="llm-completion">llm-completion</option>
              </select>
              <input type="text" placeholder="model (required, e.g. qwen2.5:0.5b)" value={customModel}
                     onChange={(e) => setCustomModel(e.target.value)} className={styles.customModel} />
              <button type="button" className={styles.addBtn} onClick={addCustomTarget}>
                <Plus size={14} /> Add
              </button>
            </div>
            {customErr && <p className={styles.err}>{customErr}</p>}
          </section>

          {/* 2. Probes / strategies (tool-specific) */}
          <section className={styles.block}>
            <h3 className={styles.blockTitle}>2. {openCard.style === 'multi-turn' ? 'Attack strategies' : 'Probes'}</h3>
            {/* Probes needing a capability our black-box HTTP chat target can't
                offer (they would only ever return zero findings) are hidden. */}
            {runnableProbes.length > 6 && (
              <div className={styles.probeToolbar}>
                <span className={styles.probeCount}>{selectedProbes.size} / {runnableProbes.length} selected</span>
                <button type="button" className={styles.probeToolBtn}
                        onClick={() => setSelectedProbes(new Set(runnableProbes.map((p) => p.id)))}>
                  Select all
                </button>
                <button type="button" className={styles.probeToolBtn}
                        onClick={() => setSelectedProbes(new Set(defaultProbeIds(openCard)))}>
                  Reset to defaults
                </button>
                <button type="button" className={styles.probeToolBtn}
                        onClick={() => setSelectedProbes(new Set())}>
                  Clear
                </button>
              </div>
            )}
            <div className={styles.probeGrid}>
              {runnableProbes.map((p) => {
                const on = selectedProbes.has(p.id)
                // Probes needing a capability our black-box HTTP chat target can't
                // offer are disabled (they would only ever return zero findings) but
                // stay visible so the operator sees why they are unavailable.
                const blocked = Boolean(p.requires)
                return (
                  <label key={p.id}
                         className={`${styles.probeCard} ${on ? styles.probeCardOn : ''} ${blocked ? styles.probeCardOff : ''}`}
                         title={blocked ? `Disabled - requires ${p.requires}` : undefined}>
                    <input type="checkbox" checked={on} disabled={blocked}
                           onChange={() => toggle(selectedProbes, p.id, setSelectedProbes)} />
                    <span className={styles.probeBody}>
                      <span className={styles.probeName}>
                        {p.label}
                        {blocked && <span className={styles.probeBadge}>needs {p.requires}</span>}
                        {p.warning && (
                          <span className={styles.probeWarn} title={p.warning}>
                            <AlertTriangle size={13} />
                          </span>
                        )}
                      </span>
                      <span className={styles.probeDesc}>{p.description}</span>
                      <span className={styles.probeChip}><Chip chip={p.chip} /></span>
                    </span>
                  </label>
                )
              })}
            </div>
            <p className={styles.hint}>
              {openCard.style === 'multi-turn'
                ? 'Each strategy runs bounded multi-turn objectives via the local judge.'
                : 'Selecting a family runs all of its sub-probes; whole families can be slow on CPU. '
                  + 'Probes needing a multimodal target or model internals are disabled for black-box HTTP chat targets.'}
            </p>
          </section>

          {/* 3. Run bounds */}
          <section className={styles.block}>
            <h3 className={styles.blockTitle}>3. Run bounds</h3>
            <div className={styles.boundsRow}>
              <label>Generations<input type="number" min={1} value={trials}
                     onChange={(e) => setTrials(parseInt(e.target.value) || 1)} /></label>
              <label>ASR ≥<input type="number" min={0} max={1} step={0.05} value={asrThreshold}
                     onChange={(e) => setAsrThreshold(parseFloat(e.target.value) || 0)} /></label>
              <label>Judge<input type="text" value={judgeModel}
                     onChange={(e) => setJudgeModel(e.target.value)} /></label>
              {openCard.style === 'multi-turn' && (
                <label>Max turns<input type="number" min={1} value={maxTurns}
                       onChange={(e) => setMaxTurns(parseInt(e.target.value) || 1)} /></label>
              )}
              <label title="RNG seed - part of the reproducibility envelope (garak / pyrit)">
                Seed<input type="number" min={0} value={seed}
                     onChange={(e) => setSeed(parseInt(e.target.value) || 0)} /></label>
              <label title="How many requests are fired at the target at once. Keep low (2) for a slow/CPU target so its queue doesn't time out; raise it for a fast/GPU target.">
                Parallel<input type="number" min={1} max={16} value={parallelism}
                     onChange={(e) => setParallelism(Math.max(1, Math.min(16, parseInt(e.target.value) || 1)))} /></label>
              <label title="Hard time budget for the whole run, in minutes. When exceeded the tool is killed (any work done is kept). Default 600 (10h) - big multi-family sweeps and slow probes (atkgen) need room.">
                Timeout (min)<input type="number" min={1} max={1440} value={timeoutMin}
                     onChange={(e) => setTimeoutMin(Math.max(1, Math.min(1440, parseInt(e.target.value) || 1)))} /></label>
            </div>

            {/* promptfoo: payload-mutation strategies (local, zero-egress). */}
            {openCard.id === 'promptfoo' && openCard.strategies && (
              <label className={styles.purposeLabel}>
                <span>Strategies - wrap each payload in an encoding (tests decode-and-comply)</span>
                <span className={styles.strategyRow}>
                  {openCard.strategies.map((st) => (
                    <button key={st.id} type="button"
                            className={`${styles.strategyChip} ${selectedStrategies.has(st.id) ? styles.strategyChipOn : ''}`}
                            onClick={() => toggle(selectedStrategies, st.id, setSelectedStrategies)}>
                      {st.label}
                    </button>
                  ))}
                </span>
              </label>
            )}

            {/* pyrit: optional custom objective (the specific harmful goal). */}
            {openCard.id === 'pyrit' && (
              <label className={styles.purposeLabel}>
                <span>Custom objective <em>(optional)</em> - overrides the attack&apos;s built-in goals</span>
                <input type="text" className={styles.purposeInput}
                       placeholder="e.g. Get the bot to approve a refund without an order number"
                       value={objective} onChange={(e) => setObjective(e.target.value)} />
              </label>
            )}

            {/* Target purpose (shared) - giskard/promptfoo/pyrit generate & grade
                attacks from the app description; a real one sharpens detection. */}
            {['giskard', 'promptfoo', 'pyrit'].includes(openCard.id) && (
              <label className={styles.purposeLabel}>
                <span>Target purpose <em>(optional)</em> - what the app does; sharpens giskard / promptfoo / pyrit</span>
                <textarea
                  rows={2}
                  className={styles.purposeInput}
                  placeholder="e.g. A customer-support assistant for an online bank that can look up orders and issue refunds"
                  value={targetPurpose}
                  onChange={(e) => setTargetPurpose(e.target.value)}
                />
              </label>
            )}

            {/* Target authentication (shared) */}
            <div className={styles.authBlock}>
              <span className={styles.authTitle}><KeyRound size={13} /> Target authentication</span>
              <div className={styles.authModes}>
                {(['none', 'bearer', 'custom'] as AuthMode[]).map((m) => (
                  <label key={m} className={styles.authMode}>
                    <input type="radio" name="authmode" checked={authMode === m}
                           onChange={() => setAuthMode(m)} />
                    {m === 'none' ? 'None' : m === 'bearer' ? 'Bearer token' : 'Custom header'}
                  </label>
                ))}
              </div>
              {authMode === 'bearer' && (
                <input type="password" placeholder="token (sent as Authorization: Bearer …)"
                       value={bearerToken} onChange={(e) => setBearerToken(e.target.value)}
                       className={styles.authInput} autoComplete="off" />
              )}
              {authMode === 'custom' && (
                <div className={styles.authCustom}>
                  <input type="text" placeholder="header name (e.g. x-api-key)"
                         value={customHeaderName} onChange={(e) => setCustomHeaderName(e.target.value)} />
                  <input type="password" placeholder="key value" value={customHeaderValue}
                         onChange={(e) => setCustomHeaderValue(e.target.value)} autoComplete="off" />
                </div>
              )}
            </div>

            <label className={styles.roe}>
              <input type="checkbox" checked={roeConfirmed} onChange={(e) => setRoeConfirmed(e.target.checked)} />
              <AlertTriangle size={14} /> I confirm this is an authorized, in-scope target (RoE).
            </label>
            <div className={styles.launchRow}>
              <button type="button" className={styles.primary} disabled={!canLaunch} onClick={launchTool}>
                {s.launching ? <Loader2 size={14} className={styles.spin} /> : <Play size={14} />} Launch {openCard.name}
              </button>
              {running && (
                <button type="button" className={styles.stop} onClick={s.stop} disabled={s.stopping}>
                  {s.stopping
                    ? <><Loader2 size={14} className={styles.spin} /> Stopping…</>
                    : <><Square size={14} /> Stop</>}
                </button>
              )}
              {s.error && <span className={styles.err}>{s.error}</span>}
            </div>
          </section>

          {/* 4. Output */}
          <section className={styles.block}>
            <h3 className={styles.blockTitle}>
              <Terminal size={14} /> 4. Output
              {running && (
                <span className={styles.scanning}>
                  <Loader2 size={13} className={styles.spin} /> scanning…
                </span>
              )}
            </h3>
            {running && <div className={styles.scanBar} aria-hidden="true" />}
            {s.run && (
              <div className={styles.status}>
                Status: <strong>{s.run.status}</strong>
                {s.phase.name && <> · Phase {s.phase.num}/4: {s.phase.name}</>}
              </div>
            )}
            {s.run?.ingest_error && (
              <div className={styles.err} role="alert">
                {s.run.ingest_terminal_error
                  ? 'Scan completed, but graph ingest rejected its result: '
                  : 'Scan completed, but graph ingest is retrying: '}
                {s.run.ingest_error}
              </div>
            )}
            {s.logs.length > 0 && (
              <pre className={styles.logs} ref={logsRef}>
                {s.logs.map((l, i) => (
                  <div key={i} className={styles[`log_${l.level}`] || styles.log_info}>{l.log}</div>
                ))}
              </pre>
            )}
          </section>
        </div>
      )}

      {/* Findings table */}
      <div className={styles.findings}>
        <h2 className={styles.detailTitle}>Findings ({s.findings.length})</h2>
        {s.findings.length === 0 && <p className={styles.muted}>No AI Gauntlet findings yet.</p>}
        <Link href="/graph?table=aiRisk&sheet=testedVulns" className={`${styles.showFindings} ${styles.findingsCta}`}>
          <Table2 size={14} /> Show findings in Red Zone
        </Link>
        {s.findings.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <NodeIdTh />
                <th>Tool</th><th>OWASP</th><th>Attack</th><th>Target</th>
                <th>ASR</th><th>Trials</th><th>Severity</th><th>Evidence</th><th>Report</th>
                <UpdatedAtTh dir={sortDir} onToggle={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {sortByUpdatedAt(s.findings, sortDir).map((f) => (
                <tr key={f.id}>
                  <td><NodeIdCell value={f.nodeId} /></td>
                  <td>{f.source}</td>
                  <td>{f.owaspLlmId}</td>
                  <td>{f.payloadClass}</td>
                  <td className={styles.tgt}>{f.target}{f.endpointPath || ''}</td>
                  <td><strong>{f.asr != null ? `${Math.round(f.asr * 100)}%` : '-'}</strong></td>
                  <td>{f.trials ?? '-'}</td>
                  <td><span className={styles.sevDot} style={{ background: sevColor(f.severity) }} />{f.severity}</td>
                  <td className={styles.ev}>{f.evidence}</td>
                  <td>{f.transcriptRef && projectId
                    ? <a href={`/api/ai-attack-surface/${projectId}/transcript?ref=${encodeURIComponent(f.transcriptRef)}`}
                         target="_blank" rel="noopener noreferrer">view</a>
                    : '-'}</td>
                  <td><UpdatedAtCell value={(f as { updatedAt?: unknown }).updatedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
