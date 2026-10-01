import type { ArtifactStatus, FindingStatus, HypothesisStatus, ProgressMetric, ProgressModel, TargetStatus, TaskStatus } from './types'

const ARTIFACT_STAGES: ArtifactStatus[] = ['DISCOVERED', 'IDENTIFIED', 'CLASSIFIED', 'ANALYSED', 'VERIFIED']
const TARGET_STAGES: TargetStatus[] = ['DISCOVERED', 'IDENTIFIED', 'CLASSIFIED', 'ANALYSED', 'VERIFIED']

function lifecyclePercent<T extends string>(values: T[], stages: T[]): ProgressMetric {
  if (!values.length) return { id: '', label: '', percent: 0, numerator: 0, denominator: 0 }
  const max = stages.length - 1
  const points = values.map((value) => Math.max(0, stages.indexOf(value)))
  const numerator = points.reduce((sum, point) => sum + point, 0)
  return {
    id: '',
    label: '',
    percent: Math.round((numerator / (values.length * max)) * 100),
    numerator,
    denominator: values.length * max,
  }
}

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
  targetStatuses: TargetStatus[]
  artifactStatuses: ArtifactStatus[]
  taskStatuses: TaskStatus[]
  findingStatuses: FindingStatus[]
  hypothesisStatuses: HypothesisStatus[]
}

export function buildProgressModel(input: ProgressInput): ProgressModel {
  const targetMetric = lifecyclePercent(input.targetStatuses, TARGET_STAGES)
  targetMetric.id = 'target_lifecycle'
  targetMetric.label = 'Target lifecycle'

  const artifactMetric = lifecyclePercent(input.artifactStatuses, ARTIFACT_STAGES)
  artifactMetric.id = 'artifact_lifecycle'
  artifactMetric.label = 'Artifact lifecycle'

  const metrics = [
    targetMetric,
    artifactMetric,
    completionMetric('tasks', 'Task completion', input.taskStatuses.filter((status) => status === 'COMPLETED').length, input.taskStatuses.length),
    completionMetric('findings', 'Finding verification', input.findingStatuses.filter((status) => status === 'VERIFIED').length, input.findingStatuses.length),
    completionMetric('hypotheses', 'Hypothesis verification', input.hypothesisStatuses.filter((status) => status === 'VERIFIED').length, input.hypothesisStatuses.length),
  ].filter((metric): metric is ProgressMetric => metric !== null && metric.denominator > 0)

  const overallPercent = metrics.length
    ? Math.round(metrics.reduce((sum, metric) => sum + metric.percent, 0) / metrics.length)
    : 0

  return { overallPercent, metrics }
}
