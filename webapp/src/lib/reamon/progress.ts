import type { FindingStatus, HypothesisStatus, ProgressMetric, ProgressModel, TaskStatus } from './types'

function completionMetric(id: string, label: string, completed: number, total: number): ProgressMetric | null {
  if (!total) return null
  return {
    id,
    label,
    percent: Math.round((completed / total) * 100),
    numerator: completed,
    denominator: total,
  }
}

export interface ProgressInput {
  taskStatuses: TaskStatus[]
  findingStatuses: FindingStatus[]
  hypothesisStatuses: HypothesisStatus[]
}

export function buildProgressModel(input: ProgressInput): ProgressModel {
  const metrics = [
    completionMetric('tasks', 'Recorded tasks completed', input.taskStatuses.filter((status) => status === 'COMPLETED').length, input.taskStatuses.length),
    completionMetric('findings', 'Verified findings', input.findingStatuses.filter((status) => status === 'VERIFIED').length, input.findingStatuses.length),
    completionMetric('hypotheses', 'Verified hypotheses', input.hypothesisStatuses.filter((status) => status === 'VERIFIED').length, input.hypothesisStatuses.length),
  ].filter((metric): metric is ProgressMetric => metric !== null && metric.denominator > 0)

  return { metrics }
}
