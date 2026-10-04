import type {
  Capability,
  CapabilityMatch,
  TargetProfile,
  ToolExecutionInput,
  ToolPlugin,
  ToolPluginManifest,
  ToolResult,
  WorkspaceCapabilitySummary,
} from './types'
import { sourceInspectorPlugin } from './source-inspector'
import { elfInspectorPlugin } from './elf-inspector'
import { elfDependenciesPlugin } from './elf-dependencies'
import { fileInspectorPlugin } from './file-inspector'
import { jsonInspectorPlugin } from './json-inspector'
import { jadxPlugin } from './jadx'
import { ilspyPlugin } from './ilspy'
import { ghidraPlugin } from './ghidra'
import { wasmPlugin } from './wasm'

export const CAPABILITIES: Capability[] = [
  { id: 'identify', label: 'Identify', description: 'Classify a target or artifact using observable metadata.', category: 'profiling' },
  { id: 'hash', label: 'Hash', description: 'Produce stable content identity for correlation and deduplication.', category: 'profiling' },
  { id: 'extract_metadata', label: 'Extract metadata', description: 'Read format, architecture, platform, and runtime metadata.', category: 'profiling' },
  { id: 'extract_strings', label: 'Extract strings', description: 'Recover printable strings for triage and correlation.', category: 'static_analysis' },
  { id: 'inspect_binary_header', label: 'Inspect binary header', description: 'Read executable format, architecture, entrypoint, and ABI metadata.', category: 'static_analysis' },
  { id: 'extract_dependencies', label: 'Extract dependencies', description: 'Recover dynamic libraries and imported or exported symbols from native executables.', category: 'static_analysis' },
  { id: 'disassemble', label: 'Disassemble', description: 'Translate machine code into instructions.', category: 'static_analysis' },
  { id: 'decompile', label: 'Decompile', description: 'Produce higher-level code representations.', category: 'static_analysis' },
  { id: 'runtime_observation', label: 'Runtime observation', description: 'Collect observations from a live process or device.', category: 'dynamic_analysis' },
  { id: 'knowledge_graph', label: 'Knowledge graph', description: 'Write typed entities and relationships to the investigation graph.', category: 'knowledge' },
]

const profilerManifest: ToolPluginManifest = {
  id: 'reamon-artifact-profiler',
  name: 'REAmon Artifact Profiler',
  category: 'profiling',
  integration: 'native',
  acceptsTargetTypes: ['FILE', 'CAPTURE', 'UNKNOWN'],
  acceptsFormats: ['*'],
  capabilities: ['identify', 'hash', 'extract_metadata'],
  produces: ['TargetProfile', 'ArtifactProfile'],
  requirements: [],
}

const resultFor = (manifest: ToolPluginManifest, input: ToolExecutionInput): ToolResult => ({
  status: 'completed',
  toolId: manifest.id,
  capabilities: manifest.capabilities,
  produced: manifest.produces,
  data: {
    targetProfile: input.targetProfile,
    observations: [{
      kind: 'entity',
      type: 'artifact',
      key: input.artifactId ? `artifact:${input.artifactId}` : `profile:${input.targetProfile.targetType}:${input.targetProfile.format}`,
      label: input.artifactId || input.targetProfile.format,
      attributes: {
        targetType: input.targetProfile.targetType,
        format: input.targetProfile.format,
        mimeType: input.targetProfile.mimeType,
        extension: input.targetProfile.extension,
      },
    }],
  },
})

export const BUILTIN_TOOL_PLUGINS: ToolPlugin[] = [
  {
    manifest: profilerManifest,
    async analyze(input) {
      return resultFor(profilerManifest, input)
    },
  },
  {
    ...sourceInspectorPlugin,
  },
  {
    ...elfInspectorPlugin,
  },
  {
    ...elfDependenciesPlugin,
  },
  {
    ...fileInspectorPlugin,
  },
  {
    ...jsonInspectorPlugin,
  },
  {
    ...jadxPlugin,
  },
  {
    ...ilspyPlugin,
  },
  {
    ...ghidraPlugin,
  },
  {
    ...wasmPlugin,
  },
]

export function resolveCapabilities(
  profile: TargetProfile,
  plugins: ToolPlugin[] = BUILTIN_TOOL_PLUGINS,
): CapabilityMatch[] {
  return plugins
    .filter((plugin) => {
      const acceptsType = plugin.manifest.acceptsTargetTypes.includes(profile.targetType)
      const acceptsFormat = plugin.manifest.acceptsFormats.includes('*') || plugin.manifest.acceptsFormats.includes(profile.format)
      return acceptsType && acceptsFormat
    })
    .map((plugin) => ({
      pluginId: plugin.manifest.id,
      pluginName: plugin.manifest.name,
      category: plugin.manifest.category,
      integration: plugin.manifest.integration,
      acceptsTargetTypes: plugin.manifest.acceptsTargetTypes,
      acceptsFormats: plugin.manifest.acceptsFormats,
      capabilities: plugin.manifest.capabilities,
      produces: plugin.manifest.produces,
      requirements: plugin.manifest.requirements,
    }))
}

export function resolveWorkspaceCapabilities(
  artifacts: Array<{ id: string; profile: TargetProfile }>,
  plugins: ToolPlugin[] = BUILTIN_TOOL_PLUGINS,
): WorkspaceCapabilitySummary[] {
  const summaries = new Map<string, WorkspaceCapabilitySummary>(plugins.map((plugin) => [plugin.manifest.id, {
    pluginId: plugin.manifest.id,
    pluginName: plugin.manifest.name,
    category: plugin.manifest.category,
    integration: plugin.manifest.integration,
    acceptsTargetTypes: plugin.manifest.acceptsTargetTypes,
    acceptsFormats: plugin.manifest.acceptsFormats,
    capabilities: plugin.manifest.capabilities,
    produces: plugin.manifest.produces,
    requirements: plugin.manifest.requirements,
    compatibleArtifactIds: [],
  }]))
  for (const artifact of artifacts) {
    for (const match of resolveCapabilities(artifact.profile, plugins)) {
      const existing = summaries.get(match.pluginId)
      if (existing && !existing.compatibleArtifactIds.includes(artifact.id)) existing.compatibleArtifactIds.push(artifact.id)
    }
  }
  return [...summaries.values()]
}
