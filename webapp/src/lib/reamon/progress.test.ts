import { describe, expect, it } from 'vitest'
import { buildProgressModel } from './progress'

describe('REAmon recorded work status', () => {
  it('counts recorded task and case statuses without estimating artifact analysis coverage', () => {
    const progress = buildProgressModel({
      taskStatuses: ['COMPLETED', 'RUNNING'],
      findingStatuses: ['OPEN', 'VERIFIED'],
      hypothesisStatuses: ['OPEN'],
    })

    expect(progress.metrics.map((metric) => metric.id)).toEqual(['tasks', 'findings', 'hypotheses'])
    expect(progress.metrics[0]).toMatchObject({ label: 'Recorded tasks completed', numerator: 1, denominator: 2 })
    expect(progress.metrics.find((metric) => metric.id === 'tasks')?.percent).toBe(50)
    expect(progress.metrics.find((metric) => metric.id === 'findings')?.percent).toBe(50)
    expect(progress.metrics.some((metric) => metric.id.includes('lifecycle'))).toBe(false)
  })

  it('does not invent progress for an empty workspace', () => {
    expect(buildProgressModel({
      taskStatuses: [], findingStatuses: [], hypothesisStatuses: [],
    })).toEqual({ metrics: [] })
  })
})
