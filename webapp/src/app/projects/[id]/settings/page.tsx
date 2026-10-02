'use client'

import { useParams, useRouter } from 'next/navigation'
import { ProjectForm } from '@/components/projects'
import { useProjectById, useUpdateProject } from '@/hooks/useProjects'
import { useProject } from '@/providers/ProjectProvider'
import styles from './page.module.css'

export default function ProjectSettingsPage() {
  const params = useParams()
  const router = useRouter()
  const projectId = params.id as string
  const { setCurrentProject } = useProject()

  const { data: project, isLoading, error } = useProjectById(projectId)
  const updateProjectMutation = useUpdateProject()

  const saveProject = async (data: any) => {
    const updated = await updateProjectMutation.mutateAsync({
      projectId,
      data
    })

    setCurrentProject({
      id: updated.id,
      name: updated.name,
      targetDomain: updated.targetDomain,
      subdomainList: updated.subdomainList,
      description: updated.description || undefined,
      createdAt: updated.createdAt.toString(),
      updatedAt: updated.updatedAt.toString()
    })

    return updated
  }

  // A failed save must reach the form, which alerts it and keeps the edits
  // marked unsaved. Swallowing it here made the form read "No unsaved changes"
  // after a refusal (a 409 from a stale form included) that saved nothing.
  const handleSubmit = async (data: any) => {
    const updated = await saveProject(data)
    router.push(`/graph?project=${projectId}`)
    return updated
  }

  const handleSaveAndStay = async (data: any) => {
    return saveProject(data)
  }

  const handleCancel = () => {
    router.back()
  }

  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading project settings...</div>
      </div>
    )
  }

  if (error || !project) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          <p>Failed to load project settings.</p>
          <button className="primaryButton" onClick={() => router.push('/projects')}>
            Go to Projects
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <ProjectForm
        mode="edit"
        initialData={project}
        projectIdFromRoute={projectId}
        onSubmit={handleSubmit}
        onSaveAndStay={handleSaveAndStay}
        onCancel={handleCancel}
        isSubmitting={updateProjectMutation.isPending}
      />
    </div>
  )
}
