/**
 * Target-agnostic domain contracts for REAmon.
 *
 * These types deliberately describe what an investigation contains rather
 * than how a particular reverse-engineering tool works. Platform-specific
 * behavior belongs in ToolPlugin implementations.
 */

import type { WorkspaceImportComparison } from './imports'

export const TARGET_TYPES = [
  'FILE',
  'DIRECTORY',
  'REPOSITORY',
  'PROCESS',
  'DEVICE',
  'SERVICE',
  'REMOTE_HOST',
  'CAPTURE',
  'FILESYSTEM',
  'DEBUG_SESSION',
  'CUSTOM',
  'UNKNOWN',
] as const

export type TargetType = (typeof TARGET_TYPES)[number]

export type ArtifactStatus =
  | 'DISCOVERED'
  | 'IDENTIFIED'
  | 'CLASSIFIED'
  | 'ANALYSED'
  | 'VERIFIED'

export type TargetStatus =
  | 'DISCOVERED'
  | 'IDENTIFIED'
  | 'CLASSIFIED'
  | 'ANALYSED'
  | 'VERIFIED'

export type TaskStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type FindingStatus = 'OPEN' | 'REVIEWING' | 'ACCEPTED' | 'REJECTED' | 'VERIFIED'
export type HypothesisStatus = 'OPEN' | 'INVESTIGATING' | 'SUPPORTED' | 'VERIFIED' | 'REJECTED'

export interface TargetProfile {
  targetType: TargetType
  format: string
  mimeType: string
  extension: string
  architecture: string | null
  platform: string | null
  runtimes: string[]
  embeddedArtifacts: string[]
  entropy: number | null
  metadata: Record<string, string | number | boolean | null>
}

export interface WorkspaceProfile extends TargetProfile {
  targetType: 'DIRECTORY'
  format: 'directory'
  fileCount: number
  directoryCount: number
  totalBytes: number
  detectedPlatforms: string[]
  detectedRuntimes: string[]
  sourceFileCount: number
  configurationFileCount: number
  interestingArtifacts: number
  potentialEntrypoints: string[]
}

export interface Capability {
  id: string
  label: string
  description: string
  category: 'profiling' | 'static_analysis' | 'dynamic_analysis' | 'knowledge' | 'execution'
}

export interface ToolRequirement {
  key: string
  value?: string | number | boolean
  optional?: boolean
}

export type ToolIntegration = 'native' | 'mcp' | 'process'

export interface ToolPluginManifest {
  id: string
  name: string
  category: string
  integration: ToolIntegration
  acceptsTargetTypes: TargetType[]
  acceptsFormats: string[]
  capabilities: string[]
  produces: string[]
  requirements: ToolRequirement[]
}

export interface ToolExecutionInput {
  targetProfile: TargetProfile
  artifactId?: string
  artifactPath?: string
  options?: Record<string, unknown>
}

export interface ToolResult {
  status: 'completed' | 'failed'
  toolId: string
  capabilities: string[]
  produced: string[]
  data: Record<string, unknown>
  error?: string
}

export interface ToolPlugin {
  manifest: ToolPluginManifest
  analyze(input: ToolExecutionInput): Promise<ToolResult>
}

export interface CapabilityMatch {
  pluginId: string
  pluginName: string
  integration: ToolIntegration
  capabilities: string[]
  produces: string[]
  requirements: ToolRequirement[]
}

export interface WorkspaceCapabilitySummary {
  pluginId: string
  pluginName: string
  integration: ToolIntegration
  capabilities: string[]
  compatibleArtifactIds: string[]
}

export interface ProgressMetric {
  id: string
  label: string
  percent: number
  numerator: number
  denominator: number
}

export interface ProgressModel {
  overallPercent: number
  metrics: ProgressMetric[]
}

export interface WorkspaceTarget {
  id: string
  name: string
  targetType: TargetType
  locator: string | null
  parentTargetId: string | null
  status: TargetStatus
  profile: TargetProfile
  createdAt: string
  updatedAt: string
}

export interface WorkspaceArtifact {
  id: string
  name: string
  originalName: string
  targetId: string | null
  importId: string | null
  relativePath: string
  parentPath: string
  sizeBytes: number
  sha256: string
  mimeType: string
  extension: string
  status: ArtifactStatus
  profile: TargetProfile
  capabilities: CapabilityMatch[]
  createdAt: string
  updatedAt: string
}

export interface WorkspaceImportSnapshot {
  id: string
  sourceType: string
  rootName: string
  status: string
  totalFiles: number
  completedFiles: number
  failedFiles: number
  totalBytes: number
  uploadedBytes: number
  errorSummary: string
  completedAt: string | null
  rootTargetId: string | null
  missingPaths: string[]
  profile: WorkspaceProfile | null
  comparison: WorkspaceImportComparison | null
}
