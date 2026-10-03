export type CompatibilityStatus = 'AVAILABLE' | 'PRESERVED' | 'BRIDGED'

export interface LegacyCompatibilityReport {
  projectKind: string
  mode: 'native' | 'bridge'
  dataPolicy: 'additive'
  surfaces: Array<{ id: string; label: string; status: CompatibilityStatus; note: string }>
}

/**
 * Keep the inherited RedAmon surface explicit while REAmon records are added.
 * This is intentionally a report, not an implicit migration: operators can see
 * which routes remain canonical before choosing a future destructive cutover.
 */
export function buildLegacyCompatibilityReport(projectKind: string): LegacyCompatibilityReport {
  const isReamon = projectKind === 'REVERSE_ENGINEERING'
  return {
    projectKind,
    mode: isReamon ? 'native' : 'bridge',
    dataPolicy: 'additive',
    surfaces: [
      { id: 'project-root', label: 'Project ownership and settings', status: 'PRESERVED', note: 'The existing Project record remains the access and settings boundary.' },
      { id: 'legacy-routes', label: 'Inherited RedAmon routes', status: 'BRIDGED', note: 'Legacy routes remain available for legacy projects during migration.' },
      { id: 'workspace-routes', label: 'REAmon workspace routes', status: isReamon ? 'AVAILABLE' : 'BRIDGED', note: 'Workspace imports, tasks, findings, approvals, and evidence are project-scoped.' },
      { id: 'data-retention', label: 'Data preservation and rollback', status: 'PRESERVED', note: 'New records are additive; backup and restore procedures are release-gated.' },
    ],
  }
}
