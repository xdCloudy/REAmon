'use client'

import Image from 'next/image'
// Guarded drop-in for next/link: consults the unsaved-changes guard before
// navigating, so header links prompt when a dirty form would lose edits.
import { GuardedLink as Link } from '@/components/GuardedLink'
import { usePathname } from 'next/navigation'
import { FolderOpen, ExternalLink, Settings, Users } from 'lucide-react'
import { ThemeToggle } from '@/components/ThemeToggle'
import { ProjectSelector } from './ProjectSelector'
import { UserSelector } from './UserSelector'
import { useAuth } from '@/providers/AuthProvider'
import styles from './GlobalHeader.module.css'

export function GlobalHeader() {
  const pathname = usePathname()
  const { isAdmin } = useAuth()

  return (
    <header className={styles.header}>
      <Link href="/projects" className={styles.logo}>
        <Image src="/logo.png" alt="REAmon" width={28} height={28} className={styles.logoImg} />
        <span className={styles.logoText}>
          <span className={styles.logoAccent}>RE</span>Amon
        </span>
      </Link>

      <div className={styles.spacer} />

      <div className={styles.actions}>
        <Link
          href="/projects"
          className={`${styles.navItem} ${pathname === '/projects' || pathname.startsWith('/projects/') ? styles.navItemActive : ''}`}
        >
          <FolderOpen size={14} />
          <span>Projects</span>
        </Link>

        {isAdmin && (
          <Link
            href="/settings/users"
            className={`${styles.navItem} ${pathname === '/settings/users' ? styles.navItemActive : ''}`}
          >
            <Users size={14} />
            <span>Users</span>
          </Link>
        )}

        <div className={styles.divider} />

        <ProjectSelector />

        <div className={styles.divider} />

        <ThemeToggle />

        <div className={styles.divider} />

        <a
          href="https://github.com/xdCloudy/REAmon/tree/reamon/bootstrap/docs"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.helpLink}
          title="REAmon documentation"
        >
          <ExternalLink size={17} />
        </a>

        <div className={styles.divider} />

        <UserSelector />

        <div className={styles.divider} />

        <Link
          href="/settings"
          className={`${styles.helpLink} ${pathname === '/settings' ? styles.navItemActive : ''}`}
          title="Global Settings"
        >
          <Settings size={17} />
        </Link>
      </div>
    </header>
  )
}
