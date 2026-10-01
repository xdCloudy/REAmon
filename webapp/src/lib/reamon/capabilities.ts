import type {
  Capability,
  CapabilityMatch,
  TargetProfile,
  ToolExecutionInput,
  ToolPlugin,
  ToolPluginManifest,
  ToolResult,
} from './types'

export const CAPABILITIES: Capability[] = [
  { id: 'identify', label: 'Identify', description: 'Classify a target or artifact using observable metadata.', category: 'profiling' },
  { id: 'hash', label: 'Hash', description: 'Produce stable content identity for correlation and deduplication.', category: 'profiling' },
  { id: 'extract_metadata', label: 'Extract metadata', description: 'Read format, architecture, platform, and runtime metadata.', category: 'profiling' },
  { id: 'extract_strings', label: 'Extract strings', description: 'Recover printable strings for triage and correlation.', category: 'static_analysis' },
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

const sourceInspectorManifest: ToolPluginManifest = {
  id: 'reamon-source-inspector',
  name: 'REAmon Source Inspector',
  category: 'static_analysis',
  integration: 'native',
  acceptsTargetTypes: ['FILE'],
  acceptsFormats: ['source'],
  capabilities: ['extract_strings'],
  produces: ['String', 'CodeEntity'],
  requirements: [],
}

const resultFor = (manifest: ToolPluginManifest, input: ToolExecutionInput): ToolResult => ({
  status: 'completed',
  toolId: manifest.id,
  capabilities: manifest.capabilities,
  produced: manifest.produces,
  data: { targetProfile: input.targetProfile },
})

export const BUILTIN_TOOL_PLUGINS: ToolPlugin[] = [
  {
    manifest: profilerManifest,
    async analyze(input) {
      return resultFor(profilerManifest, input)
    },
  },
  {
    manifest: sourceInspectorManifest,
    async analyze(input) {
      return resultFor(sourceInspectorManifest, input)
    },
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
      integration: plugin.manifest.integration,
      capabilities: plugin.manifest.capabilities,
      produces: plugin.manifest.produces,
      requirements: plugin.manifest.requirements,
    }))
}
