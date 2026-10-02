import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { BUILTIN_TOOL_PLUGINS } from './capabilities'
import type { ToolPlugin, ToolPluginManifest } from './types'

/**
 * Keep the executable registry in code while making the manifest visible to
 * durable task records. Provider metadata is descriptive; credentials and
 * storage paths never belong in this table.
 */
export function getBuiltinProvider(pluginId: string): ToolPlugin | null {
  return BUILTIN_TOOL_PLUGINS.find((plugin) => plugin.manifest.id === pluginId) || null
}

export async function ensureProviderRegistered(manifest: ToolPluginManifest) {
  const metadata = {
    name: manifest.name,
    category: manifest.category,
    integration: manifest.integration,
    acceptsTargetTypes: manifest.acceptsTargetTypes,
    acceptsFormats: manifest.acceptsFormats,
    capabilities: manifest.capabilities,
    produces: manifest.produces,
    requirements: manifest.requirements as unknown as Prisma.InputJsonValue,
  }
  return prisma.reamonProvider.upsert({
    where: { pluginId: manifest.id },
    create: { pluginId: manifest.id, ...metadata },
    update: metadata,
    select: { id: true, pluginId: true, name: true, enabled: true },
  })
}
