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
  taskStatuses: Array<{ status: TaskStatus; category: string }>
  findingStatuses: FindingStatus[]
  hypothesisStatuses: HypothesisStatus[]
}

export function buildProgressModel(input: ProgressInput): ProgressModel {
  const analysisTasks = input.taskStatuses.filter((task) => task.category !== 'profiling')
  const metrics = [
    completionMetric('tasks', 'Analysis tasks completed', analysisTasks.filter((task) => task.status === 'COMPLETED').length, analysisTasks.length),
    completionMetric('findings', 'Verified findings', input.findingStatuses.filter((status) => status === 'VERIFIED').length, input.findingStatuses.length),
    completionMetric('hypotheses', 'Verified hypotheses', input.hypothesisStatuses.filter((status) => status === 'VERIFIED').length, input.hypothesisStatuses.length),
  ].filter((metric): metric is ProgressMetric => metric !== null && metric.denominator > 0)

  return { metrics }
}
