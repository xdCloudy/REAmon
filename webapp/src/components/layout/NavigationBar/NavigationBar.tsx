'use client'

import { usePathname } from 'next/navigation'
import { FolderOpen } from 'lucide-react'
import { GuardedLink } from '@/components/GuardedLink'
import styles from './NavigationBar.module.css'

interface NavItem {
  label: string
  href: string
  icon: React.ReactNode
  enabled: boolean
}

const navItems: NavItem[] = [
  {
    label: 'Workspaces',
    href: '/projects',
    icon: <FolderOpen size={16} />,
    enabled: true,
  },
]

export function NavigationBar() {
  const pathname = usePathname()

  return (
    <nav className={styles.nav}>
      <ul className={styles.navList}>
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`)

          if (!item.enabled) {
            return (
              <li key={item.href}>
                <span className={`${styles.navItem} ${styles.navItemDisabled}`}>
                  <span className={styles.navIcon}>{item.icon}</span>
                  <span className={styles.navLabel}>{item.label}</span>
                  <span className={styles.comingSoon}>Soon</span>
                </span>
              </li>
            )
          }

          return (
            <li key={item.href}>
              <GuardedLink
                href={item.href}
                className={`${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
              >
                <span className={styles.navIcon}>{item.icon}</span>
                <span className={styles.navLabel}>{item.label}</span>
              </GuardedLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
