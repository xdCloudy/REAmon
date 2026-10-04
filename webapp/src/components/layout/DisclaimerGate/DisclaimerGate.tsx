'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import {
  ShieldAlert, ExternalLink,
  Rocket, UserPlus, FolderPlus,
  Bot, Play,
} from 'lucide-react'
import {
  DISCLAIMER_VERSION,
  DISCLAIMER_STORAGE_KEY,
  DISCLAIMER_GITHUB_URL,
} from '@/lib/disclaimerVersion'
import styles from './DisclaimerGate.module.css'

interface DisclaimerGateProps {
  children: React.ReactNode
}

interface StoredAcceptance {
  version: string
  acceptedAt: string
}

const CHECKBOXES = [
  {
    id: 'authorization',
    label:
      'I confirm I have the right to inspect and analyze every file, application, device, or dataset I import into this workspace.',
  },
  {
    id: 'liability',
    label:
      'I acknowledge this software is provided "AS IS" with no warranty. Authors and contributors bear no liability for any damages, data loss, or legal consequences.',
  },
  {
    id: 'data-privacy',
    label:
      'I understand that imported data and analysis context may be sent to the LLM providers and external services I configure, with no privacy guarantee from REAmon.',
  },
  {
    id: 'data-persistence',
    label:
      'I understand imported artifacts, evidence, and analysis history are stored in the configured PostgreSQL, Neo4j, and artifact volumes until I remove them.',
  },
  {
    id: 'ai-agent',
    label:
      'I understand AI-assisted analysis can be incomplete or incorrect, and that approval gates do not replace review by a qualified operator.',
  },
  {
    id: 'third-party',
    label:
      'I understand I must comply with the licenses and legal requirements applicable to the software and data I analyze.',
  },
] as const

export function DisclaimerGate({ children }: DisclaimerGateProps) {
  const [isLoading, setIsLoading] = useState(true)
  const [isAccepted, setIsAccepted] = useState(false)
  const [step, setStep] = useState<'welcome' | 'disclaimer' | 'guide'>('welcome')
  const [checked, setChecked] = useState<boolean[]>(
    () => new Array(CHECKBOXES.length).fill(false)
  )

  useEffect(() => {
    try {
      const stored = localStorage.getItem(DISCLAIMER_STORAGE_KEY)
      if (stored) {
        const parsed: StoredAcceptance = JSON.parse(stored)
        if (parsed.version === DISCLAIMER_VERSION) {
          setIsAccepted(true)
        }
      }
    } catch {
      // localStorage unavailable or corrupted - show the gate
    }
    setIsLoading(false)
  }, [])

  const handleToggle = useCallback((index: number) => {
    setChecked((prev) => {
      const next = [...prev]
      next[index] = !next[index]
      return next
    })
  }, [])

  const handleAccept = useCallback(() => {
    try {
      const value: StoredAcceptance = {
        version: DISCLAIMER_VERSION,
        acceptedAt: new Date().toISOString(),
      }
      localStorage.setItem(DISCLAIMER_STORAGE_KEY, JSON.stringify(value))
    } catch {
      // localStorage unavailable - acceptance lasts this session only
    }
    setIsAccepted(true)
  }, [])

  const allChecked = checked.every(Boolean)

  if (isLoading) {
    return null
  }

  if (isAccepted) {
    return <>{children}</>
  }

  if (step === 'welcome') {
    return (
      <div className={styles.overlay}>
        <div className={styles.card}>
          <Image src="/logo.png" alt="" aria-hidden width={520} height={520} className={styles.eyeBg} />
          <div className={styles.welcomeHeader}>
            <Image src="/logo.png" alt="REAmon" width={36} height={36} style={{ objectFit: 'contain' }} />
            <h1 className={styles.welcomeTitle}>
              Welcome to <span className={styles.logoAccent}>RE</span>Amon
            </h1>
          </div>

          <div className={styles.body}>
            <p className={styles.welcomeThank}>
              Thank you for installing <strong>REAmon</strong>!
            </p>

            <p className={styles.welcomeDesc}>
              <strong>REAmon</strong> is an open-source, AI-assisted
              reverse-engineering workspace and orchestration platform. It
              profiles arbitrary targets, connects evidence in a knowledge graph,
              and coordinates analysis capabilities under human control.
            </p>

            <div className={styles.missionBox}>
              <p className={styles.missionText}>
                REAmon is a focused reverse-engineering workspace for importing
                software, preserving evidence, and coordinating bounded analysis
                under operator control.
              </p>
              <p className={styles.missionText}>
                Contributions, bug reports, and provider integrations are welcome
                in the REAmon repository.
              </p>
              <p className={styles.footerSignature}>
                Understand the system. Preserve the evidence.
              </p>
            </div>
          </div>

          <div className={styles.footer}>
            <p className={styles.footerQuote}>
              &ldquo;Open source is humanity&apos;s greatest collaborative experiment.&rdquo;
            </p>
            <button
              className={styles.acceptButton}
              onClick={() => setStep('disclaimer')}
            >
              OK, continue
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (step === 'guide') {
    return (
      <div className={styles.overlay}>
        <div className={styles.card}>
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <Rocket size={20} className={styles.headerIcon} />
              <h1 className={styles.title}>Getting Started - Your First Steps</h1>
            </div>
          </div>

          <div className={styles.body}>
            <div className={styles.guideGroups}>
              {/* Setup group */}
              <div className={styles.guideGroup}>
                <p className={styles.guideGroupLabel}>Setup</p>
                <div className={styles.guideSteps}>
                  <div className={styles.guideStep}>
                    <div className={styles.guideStepLeft}>
                      <span className={styles.guideStepNum}>1</span>
                      <UserPlus size={18} className={styles.guideStepIcon} />
                    </div>
                    <div>
                      <p className={styles.guideStepTitle}>Create a User</p>
                      <p className={styles.guideStepDesc}>Go to the Users panel and create your profile. Each user can manage multiple independent projects.</p>
                    </div>
                  </div>
                  <div className={styles.guideStep}>
                    <div className={styles.guideStepLeft}>
                      <span className={styles.guideStepNum}>2</span>
                      <FolderPlus size={18} className={styles.guideStepIcon} />
                    </div>
                    <div>
                      <p className={styles.guideStepTitle}>Create a Project</p>
                      <p className={styles.guideStepDesc}>Set up a workspace to group targets, artifacts, settings, and agent sessions for an investigation.</p>
                    </div>
                  </div>

                </div>
              </div>

              {/* Run group */}
              <div className={styles.guideGroup}>
                <p className={styles.guideGroupLabel}>Run</p>
                <div className={styles.guideSteps}>
                  <div className={styles.guideStep}>
                    <div className={styles.guideStepLeft}>
                      <span className={styles.guideStepNum}>3</span>
                      <Play size={18} className={styles.guideStepIcon} />
                    </div>
                    <div>
                      <p className={styles.guideStepTitle}>Launch an Analysis</p>
                      <p className={styles.guideStepDesc}>From the workspace, start an analysis workflow for the available targets and capabilities before starting an AI agent.</p>
                    </div>
                  </div>
                  <div className={styles.guideStep}>
                    <div className={styles.guideStepLeft}>
                      <span className={styles.guideStepNum}>4</span>
                      <Bot size={18} className={styles.guideStepIcon} />
                    </div>
                    <div>
                      <p className={styles.guideStepTitle}>Start the AI Agent</p>
                      <p className={styles.guideStepDesc}>Once analysis is underway, switch to <strong>Agent AI</strong> to interrogate evidence, evaluate hypotheses, and generate reports.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className={styles.footer}>
            <a href="https://github.com/xdCloudy/REAmon/tree/reamon/bootstrap/docs" target="_blank" rel="noopener noreferrer" className={styles.fullDisclaimerLink}>
              Read the REAmon documentation
              <ExternalLink size={12} />
            </a>
            <button className={styles.acceptButton} onClick={handleAccept}>
              Let&apos;s Go →
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <ShieldAlert size={22} className={styles.headerIcon} />
            <h1 className={styles.title}>Legal Disclaimer & Terms of Use</h1>
          </div>
        </div>

        <div className={styles.body}>
          <p className={styles.intro}>
            <strong>REAmon</strong> is an AI-assisted reverse-engineering
            workspace intended for authorized software analysis, education, and
            research. Before using this tool, you must read and accept the
            following terms.
          </p>

          <div className={styles.linkWrapper}>
            <a
              href={DISCLAIMER_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.fullDisclaimerLink}
            >
              Read the full legal disclaimer
              <ExternalLink size={13} />
            </a>
          </div>

          <div className={styles.checkboxList}>
            {CHECKBOXES.map((item, index) => (
              <label key={item.id} className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={checked[index]}
                  onChange={() => handleToggle(index)}
                  className={styles.checkbox}
                />
                <span className={styles.checkboxLabel}>{item.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className={styles.footer}>
          <button
            className={styles.acceptButton}
            disabled={!allChecked}
            onClick={() => setStep('guide')}
          >
            I Accept All Terms
          </button>
        </div>
      </div>
    </div>
  )
}
