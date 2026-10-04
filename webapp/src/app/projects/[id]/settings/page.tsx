import { redirect } from 'next/navigation'

export default async function ProjectSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // The inherited target-domain/recon form is intentionally no longer part of
  // the REAmon product surface. Workspace configuration lives with the
  // imported workspace and its approval-controlled analysis plan.
  redirect(`/projects/${encodeURIComponent(id)}`)
}
