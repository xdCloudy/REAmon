'use client'

import { useRef, useState } from 'react'
import { Database, Upload } from 'lucide-react'
import styles from './ReaEvidenceImportPanel.module.css'

type ImportResult = { records: number; bound: number; unbound: number; ambiguous: number }

export function ReaEvidenceImportPanel({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  const importBundle = async () => {
    if (!file || busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch(`/api/projects/${projectId}/evidence/import`, { method: 'POST', body: form })
      const payload = await response.json() as ImportResult & { error?: string }
      if (!response.ok) throw new Error(payload.error || 'REA Evidence import failed')
      setResult(payload)
      onImported()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'REA Evidence import failed')
    } finally {
      setBusy(false)
    }
  }

  return <section className={styles.panel} aria-labelledby="rea-evidence-import-heading">
    <div className={styles.header}><h2 id="rea-evidence-import-heading">Import REA Evidence</h2><Database size={18} aria-hidden="true" /></div>
    <p className={styles.muted}>Add a canonical Evidence bundle to project memory. Records stay labeled as external evidence; artifacts link only when their SHA-256 matches exactly.</p>
    <div className={styles.actions}>
      <label className="secondaryButton">
        <Upload size={16} /> <span className={styles.fileName}>{file ? file.name : 'Choose bundle JSON'}</span>
        <input ref={inputRef} type="file" accept="application/json,.json" disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setResult(null); setError(null) }} className={styles.hiddenInput} />
      </label>
      <button type="button" className="primaryButton" disabled={!file || busy} onClick={() => void importBundle()}>{busy ? 'Validating and importing…' : 'Import evidence'}</button>
      {file && <button type="button" className="secondaryButton" disabled={busy} onClick={() => { setFile(null); setResult(null); setError(null); if (inputRef.current) inputRef.current.value = '' }}>Clear</button>}
    </div>
    <p className={styles.muted}>Supports bundles up to 8 MiB and 1,000 records. Residual-unknown history is not supported yet.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {result && <p role="status" className={styles.result}>Imported {result.records.toLocaleString()} records: {result.bound.toLocaleString()} exact-hash links, {result.unbound.toLocaleString()} unbound, {result.ambiguous.toLocaleString()} ambiguous.</p>}
  </section>
}
