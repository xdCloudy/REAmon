import { stat, readFile } from 'node:fs/promises'
import type { ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const MAX_JSON_BYTES = 512 * 1024
const MAX_KEYS = 128

export const jsonInspectorManifest: ToolPluginManifest = {
  id: 'reamon-json-inspector',
  name: 'REAmon JSON Inspector',
  category: 'static_analysis',
  integration: 'native',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['json'],
  capabilities: ['extract_metadata'],
  produces: ['JsonDocument', 'ConfigEntity'],
  requirements: [{ key: 'artifactPath' }],
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 4000) || 'JSON provider failed'
}

function summarize(value: unknown): { rootType: string; topLevelKeys: string[]; itemCount: number } {
  if (Array.isArray(value)) return { rootType: 'array', topLevelKeys: [], itemCount: value.length }
  if (value && typeof value === 'object') {
    const topLevelKeys = Object.keys(value).slice(0, MAX_KEYS)
    return { rootType: 'object', topLevelKeys, itemCount: Object.keys(value).length }
  }
  return { rootType: value === null ? 'null' : typeof value, topLevelKeys: [], itemCount: 0 }
}

export async function executeJsonInspection(input: ToolExecutionInput): Promise<ToolResult> {
  const baseResult = {
    toolId: jsonInspectorManifest.id,
    capabilities: jsonInspectorManifest.capabilities,
    produced: jsonInspectorManifest.produces,
  }
  if (!input.artifactPath) {
    return { status: 'failed', ...baseResult, data: {}, error: 'Controlled artifact path is required' }
  }

  try {
    const fileStats = await stat(input.artifactPath)
    if (!fileStats.isFile()) return { status: 'failed', ...baseResult, data: {}, error: 'JSON artifact is not a regular file' }
    if (fileStats.size > MAX_JSON_BYTES) return { status: 'failed', ...baseResult, data: {}, error: `JSON artifact exceeds the ${MAX_JSON_BYTES}-byte safety limit` }
    const value = JSON.parse(await readFile(input.artifactPath, 'utf8')) as unknown
    const summary = summarize(value)
    return {
      status: 'completed',
      ...baseResult,
      data: {
        summary,
        observations: [{
          kind: 'entity',
          type: 'json_document',
          key: `artifact:${input.artifactId || 'unknown'}:json-document`,
          label: `${summary.rootType} JSON document`,
          attributes: { rootType: summary.rootType, itemCount: summary.itemCount, topLevelKeys: summary.topLevelKeys.join(',') },
        }],
      },
    }
  } catch (error) {
    return { status: 'failed', ...baseResult, data: {}, error: boundedError(error) }
  }
}

export const jsonInspectorPlugin: ToolPlugin = {
  manifest: jsonInspectorManifest,
  analyze: executeJsonInspection,
}
