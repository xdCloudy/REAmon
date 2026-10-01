import { describe, expect, it } from 'vitest'
import { buildProgressModel } from './progress'

describe('REAmon deterministic progress', () => {
  it('derives progress from lifecycle state instead of generated estimates', () => {
    const progress = buildProgressModel({
      targetStatuses: ['IDENTIFIED'],
      artifactStatuses: ['IDENTIFIED', 'VERIFIED'],
      taskStatuses: ['COMPLETED', 'RUNNING'],
      findingStatuses: ['OPEN', 'VERIFIED'],
      hypothesisStatuses: ['OPEN'],
    })

    expect(progress.metrics.map((metric) => metric.id)).toEqual([
      'target_lifecycle',
      'artifact_lifecycle',
      'tasks',
      'findings',
      'hypotheses',
    ])
    expect(progress.metrics.find((metric) => metric.id === 'tasks')?.percent).toBe(50)
    expect(progress.metrics.find((metric) => metric.id === 'findings')?.percent).toBe(50)
    expect(progress.overallPercent).toBeGreaterThan(0)
  })

  it('does not invent progress for an empty workspace', () => {
    expect(buildProgressModel({
      targetStatuses: [], artifactStatuses: [], taskStatuses: [], findingStatuses: [], hypothesisStatuses: [],
    })).toEqual({ overallPercent: 0, metrics: [] })
  })
})
