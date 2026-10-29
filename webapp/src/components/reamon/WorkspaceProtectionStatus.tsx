'use client'

import type { WorkspaceObservation } from '@/lib/reamon'
import styles from './WorkspaceProtectionStatus.module.css'

interface ProtectionArtifact {
  id: string
  name: string
  originalName: string
  extension: string
  profile: { format: string }
}

function assessmentLabel(observation: WorkspaceObservation | undefined): { label: string; state: 'suspected' | 'unknown' | 'pending'; family: string | null } {
  if (!observation) return { label: 'Not inspected', state: 'pending', family: null }
  const assessment = observation.attributes.assessment
  const family = typeof observation.attributes.family === 'string' ? observation.attributes.family : null
  if (assessment === 'suspected') return { label: 'Suspected indicators', state: 'suspected', family }
  return { label: 'Unknown', state: 'unknown', family: null }
}

function importSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const rows: unknown = JSON.parse(value)
    if (!Array.isArray(rows)) return null
    const summary = rows.slice(0, 8).flatMap((row): string[] => {
      if (!row || typeof row !== 'object' || typeof row.library !== 'string') return []
      const symbols = Array.isArray(row.symbols) ? row.symbols.filter((item: unknown): item is string => typeof item === 'string').slice(0, 8) : []
      return [symbols.length ? `${row.library}: ${symbols.join(', ')}` : row.library]
    })
    return summary.length ? summary.join(' · ') : null
  } catch {
    return null
  }
}

export function WorkspaceProtectionStatus({ artifacts, observations, hasMoreArtifacts = false }: {
  artifacts: ProtectionArtifact[]
  observations: WorkspaceObservation[]
  hasMoreArtifacts?: boolean
}) {
  const binaries = artifacts.filter((artifact) => ['pe', 'elf'].includes(artifact.profile.format.toLowerCase()))
  if (binaries.length === 0) return null

  const assessmentsByArtifact = new Map<string, WorkspaceObservation>()
  for (const observation of observations) {
    if (observation.type !== 'protection_assessment' || !observation.artifactId) continue
    const current = assessmentsByArtifact.get(observation.artifactId)
    if (!current || observation.updatedAt > current.updatedAt) assessmentsByArtifact.set(observation.artifactId, observation)
  }

  return (
    <section className={styles.card} aria-labelledby="protection-status-heading">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Static artifact review</p>
          <h2 id="protection-status-heading">Protection status</h2>
        </div>
        <span className={styles.count}>{binaries.length} PE/ELF file{binaries.length === 1 ? '' : 's'}</span>
      </div>
      <p className={styles.note}>
        This summary covers the {binaries.length} PE/ELF file{binaries.length === 1 ? '' : 's'} currently loaded in the overview{hasMoreArtifacts ? '; additional project files are not included in this page.' : '.'} A suspected family is an evidence-backed hypothesis. No target was executed or unpacked by this inspection; “unknown” does not mean unprotected.
      </p>
      <ul className={styles.list}>
        {binaries.map((artifact) => {
          const observation = assessmentsByArtifact.get(artifact.id)
          const status = assessmentLabel(observation)
          const evidence = observation?.attributes.evidence
          const scope = observation?.attributes.scope
          const imports = importSummary(observation?.attributes.imports)
          const importTableStatus = observation?.attributes.importTableStatus
          return (
            <li className={styles.row} key={artifact.id}>
              <div className={styles.identity}>
                <strong title={artifact.originalName || artifact.name}>{artifact.originalName || artifact.name}</strong>
                <span>{artifact.extension ? `.${artifact.extension.replace(/^\./, '')}` : artifact.profile.format.toUpperCase()}</span>
              </div>
              <div className={styles.result}>
                <span className={`${styles.badge} ${styles[status.state]}`}>{status.label}{status.family ? ` · ${status.family}` : ''}</span>
                {typeof evidence === 'string' && evidence.length > 0 && <small>{evidence}</small>}
                {imports && <small>Imported APIs: {imports}</small>}
                {observation?.attributes.importTableStatus === 'truncated' && <small>Import listing is truncated by the static inspection limits.</small>}
                {importTableStatus === 'unavailable' && <small>The import directory could not be mapped or parsed from the available file evidence.</small>}
                {typeof scope === 'string' && scope.length > 0 && <small>Scope: {scope}</small>}
                {!observation && <small>Static protection inspection has not run for this file.</small>}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
