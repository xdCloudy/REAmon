'use client'

import { Calendar, FolderTree, Globe, Trash2 } from 'lucide-react'
import Link from 'next/link'
import styles from './ProjectCard.module.css'

interface ProjectCardProps {
  id: string
  name: string
  projectKind?: string
  targetDomain: string
  artifactCount?: number
  targetCount?: number
  workspaceProfile?: {
    platform?: string | null
    architecture?: string | null
    runtimes?: string[]
  } | null
  description?: string | null
  createdAt: string
  isSelected?: boolean
  onSelect?: () => void
  onDelete?: () => void
}

export function ProjectCard({
  id,
  name,
  projectKind,
  targetDomain,
  artifactCount = 0,
  targetCount = 0,
  workspaceProfile,
  description,
  createdAt,
  isSelected,
  onSelect,
  onDelete
}: ProjectCardProps) {
  const formattedDate = new Date(createdAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })

  return (
    <div
      className={`card cardClickable ${isSelected ? 'cardSelected' : ''} ${styles.projectCard}`}
      onClick={onSelect}
    >
      <div className="cardHeader">
        <div>
          <h3 className="cardTitle">{name}</h3>
          {description && <p className="cardSubtitle">{description}</p>}
        </div>
        <div className={styles.actions}>
          <Link
            href={`/projects/${id}`}
            className="iconButton"
            onClick={(e) => e.stopPropagation()}
            title="Open workspace"
          >
            <FolderTree size={14} />
          </Link>
          {onDelete && (
            <button
              className="iconButton"
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
              title="Delete Project"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="cardBody">
        <div className={styles.meta}>
          {projectKind === 'REVERSE_ENGINEERING' ? (
            <>
              <div className={styles.metaItem}><FolderTree size={12} /><span>Workspace · {artifactCount} artifacts · {targetCount} targets</span></div>
              <div className={styles.metaItem}><Globe size={12} /><span>{[workspaceProfile?.platform, workspaceProfile?.architecture, ...(workspaceProfile?.runtimes || [])].filter(Boolean).join(' · ') || 'Profile pending'}</span></div>
            </>
          ) : (
            <div className={styles.metaItem}>
              <Globe size={12} />
              <span>{targetDomain || 'No target set'}</span>
            </div>
          )}
          <div className={styles.metaItem}>
            <Calendar size={12} />
            <span>{formattedDate}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ProjectCard
