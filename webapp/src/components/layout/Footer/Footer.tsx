'use client'

import { ExternalLink, Scale } from 'lucide-react'
import { DISCLAIMER_GITHUB_URL } from '@/lib/disclaimerVersion'
import { REAMON_REPOSITORY_URL, REAMON_VERSION } from '@/lib/reamon/version'
import { SystemMeter } from '@/components/system/SystemMeter'
import styles from './Footer.module.css'

export function Footer() {
  const currentYear = new Date().getFullYear()

  return (
    <footer className={styles.footer}>
      <div className={styles.content}>
        <div className={styles.left}>
          <span className={styles.copyright}>
            © {currentYear} REAmon. Reverse-engineering workspace and analysis tooling.
          </span>
          <a
            href={DISCLAIMER_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.legalLink}
          >
            <Scale size={12} />
            Legal & Terms of Use
          </a>
        </div>
        <div className={styles.right}>
          <SystemMeter />
          <div className={styles.versionWrapper}>
            <span className={styles.version}>REAmon v{REAMON_VERSION}</span>
            <a href={REAMON_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className={styles.releaseLink} title="REAmon source repository">
              <ExternalLink size={11} />
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}
