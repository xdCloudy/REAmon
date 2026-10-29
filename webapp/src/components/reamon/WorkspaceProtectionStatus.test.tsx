import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceProtectionStatus } from './WorkspaceProtectionStatus'
import type { WorkspaceObservation } from '@/lib/reamon'

const artifact = {
  id: 'artifact-1', name: 'client.exe', originalName: 'client.exe', extension: 'exe', profile: { format: 'pe' },
}

function observation(assessment: string, family: string | null, evidence: string, imports?: string, importTableStatus?: string): WorkspaceObservation {
  return {
    id: 'observation-1', projectId: 'project-1', taskId: 'task-1', targetId: null, artifactId: artifact.id,
    kind: 'fact', type: 'protection_assessment', key: 'artifact:artifact-1:protection-static-v1', source: 'reamon-protection-inspector',
    attributes: { assessment, family, evidence, scope: 'PE headers and bounded section samples; no execution or unpacking', ...(imports ? { imports } : {}), ...(importTableStatus ? { importTableStatus } : {}) },
    createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
  }
}

describe('WorkspaceProtectionStatus', () => {
  afterEach(cleanup)

  it('shows uninspected binaries explicitly', () => {
    render(<WorkspaceProtectionStatus artifacts={[artifact]} observations={[]} />)
    expect(screen.getByText('Not inspected')).toBeTruthy()
    expect(screen.getByText('Static protection inspection has not run for this file.')).toBeTruthy()
  })

  it('labels protection families as suspected and preserves evidence scope', () => {
    render(<WorkspaceProtectionStatus artifacts={[artifact]} observations={[observation('suspected', 'UPX', 'A UPX section marker was found.')]}/>)
    expect(screen.getByText('Suspected indicators · UPX')).toBeTruthy()
    expect(screen.getByText('A UPX section marker was found.')).toBeTruthy()
    expect(screen.getByText(/Scope: PE headers/)).toBeTruthy()
    expect(screen.queryByText('Confirmed')).toBeNull()
  })

  it('shows statically recovered import evidence without implying behavior', () => {
    const imports = JSON.stringify([{ library: 'KERNEL32.dll', symbols: ['CreateFileW', 'CloseHandle'] }])
    render(<WorkspaceProtectionStatus artifacts={[artifact]} observations={[observation('unknown', null, 'Protection remains unknown.', imports)]} />)
    expect(screen.getByText('Imported APIs: KERNEL32.dll: CreateFileW, CloseHandle')).toBeTruthy()
    expect(screen.getByText('Unknown')).toBeTruthy()
  })

  it('distinguishes an unavailable import table from an empty import list', () => {
    render(<WorkspaceProtectionStatus artifacts={[artifact]} observations={[observation('unknown', null, 'Protection remains unknown.', undefined, 'unavailable')]} />)
    expect(screen.getByText('The import directory could not be mapped or parsed from the available file evidence.')).toBeTruthy()
  })

  it('does not present an unknown result as evidence of no protection', () => {
    render(<WorkspaceProtectionStatus artifacts={[artifact]} observations={[observation('unknown', null, 'No recognized marker was observed. Protection may still be present.')]}/>)
    expect(screen.getByText('Unknown')).toBeTruthy()
    expect(screen.getByText(/unknown” does not mean unprotected/)).toBeTruthy()
  })

  it('hides the section when no PE or ELF artifacts exist', () => {
    const nonBinary = { ...artifact, profile: { format: 'apk' } }
    const { container } = render(<WorkspaceProtectionStatus artifacts={[nonBinary]} observations={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('states when the project inventory continues beyond the overview page', () => {
    render(<WorkspaceProtectionStatus artifacts={[artifact]} observations={[]} hasMoreArtifacts />)
    expect(screen.getByText(/additional project files are not included in this page/)).toBeTruthy()
  })
})
