import { open, stat } from 'node:fs/promises'
import type { ToolObservation, ToolPlugin, ToolPluginManifest, ToolResult } from './types'

const HEADER_BYTES = 32
const ENTRY_BYTES = 48
const MAX_ENTRIES = 4096
const MAX_TABLE_BYTES = 1024 * 1024
const SECTOR_BYTES = 512

export const slb2InspectorManifest: ToolPluginManifest = {
  id: 'reamon-slb2-inspector',
  name: 'SLB2 Container Inspector',
  category: 'static_analysis',
  integration: 'native',
  acceptsTargetTypes: ['FILE', 'UNKNOWN'],
  acceptsFormats: ['slb2', 'unknown'],
  acceptsMetadata: { extensionHint: 'pup' },
  capabilities: ['extract_metadata'],
  produces: ['ContainerHeader', 'ContainerEntry'],
  requirements: [{ key: 'artifactPath' }],
}

function uint32le(bytes: Buffer, offset: number): number {
  return bytes.readUInt32LE(offset)
}

function entryName(bytes: Buffer, offset: number): string {
  const end = bytes.indexOf(0, offset)
  const nameBytes = bytes.subarray(offset, end === -1 ? offset + 32 : end)
  if (!nameBytes.length || [...nameBytes].some((byte) => byte < 0x20 || byte > 0x7e)) return ''
  return nameBytes.toString('ascii').slice(0, 32)
}

function observation(artifactId: string, type: string, key: string, label: string, attributes: ToolObservation['attributes']): ToolObservation {
  return { kind: 'fact', type, key: `${slb2InspectorManifest.id}:${artifactId}:${key}`, label, attributes }
}

export async function inspectSlb2Artifact(input: {
  artifactId?: string
  artifactPath?: string
  signal?: AbortSignal
  reportProgress?: (message: string) => Promise<void> | void
}): Promise<ToolResult> {
  const base = {
    toolId: slb2InspectorManifest.id,
    capabilities: slb2InspectorManifest.capabilities,
    produced: slb2InspectorManifest.produces,
  }
  if (!input.artifactPath || !input.artifactId) {
    return { status: 'failed', ...base, data: {}, error: 'A stored artifact path and identity are required' }
  }

  let handle
  try {
    if (input.signal?.aborted) throw new Error('Inspection cancelled')
    await input.reportProgress?.('Reading the bounded SLB2 header and entry table')
    const fileInfo = await stat(input.artifactPath)
    if (!fileInfo.isFile() || fileInfo.size < HEADER_BYTES) throw new Error('SLB2 input is not a complete file')

    handle = await open(input.artifactPath, 'r')
    const header = Buffer.alloc(HEADER_BYTES)
    const { bytesRead: headerRead } = await handle.read(header, 0, HEADER_BYTES, 0)
    if (headerRead !== HEADER_BYTES || header.toString('ascii', 0, 4) !== 'SLB2') throw new Error('SLB2 signature was not present')

    const version = uint32le(header, 4)
    const flags = uint32le(header, 8)
    const entryCount = uint32le(header, 12)
    const declaredBlocks = uint32le(header, 16)
    const declaredSizeBytes = declaredBlocks * SECTOR_BYTES
    if (entryCount === 0 || entryCount > MAX_ENTRIES) throw new Error(`SLB2 entry count is outside the supported inspection range (1–${MAX_ENTRIES})`)
    if (declaredBlocks === 0 || Math.abs(declaredSizeBytes - fileInfo.size) >= SECTOR_BYTES) {
      throw new Error('SLB2 declared container size does not match the stored artifact')
    }

    const tableBytes = entryCount * ENTRY_BYTES
    if (!Number.isSafeInteger(tableBytes) || tableBytes > MAX_TABLE_BYTES || HEADER_BYTES + tableBytes > fileInfo.size) {
      throw new Error('SLB2 entry table is incomplete or too large to inspect safely')
    }
    const table = Buffer.alloc(tableBytes)
    const { bytesRead: tableRead } = await handle.read(table, 0, tableBytes, HEADER_BYTES)
    if (tableRead !== tableBytes) throw new Error('Could not read the complete SLB2 entry table')

    const observations: ToolObservation[] = [observation(input.artifactId, 'container_header', 'header', 'SLB2 container header', {
      format: 'SLB2',
      version,
      flags,
      entryCount,
      declaredSizeBytes,
      actualSizeBytes: fileInfo.size,
    })]
    const entries: Array<{ index: number; name: string; offsetBytes: number; declaredSizeBytes: number | null; nestedFormat: string | null }> = []
    let nestedPupHeaderCount = 0
    for (let index = 0; index < entryCount; index += 1) {
      if (input.signal?.aborted) throw new Error('Inspection cancelled')
      const baseOffset = index * ENTRY_BYTES
      const startSector = uint32le(table, baseOffset)
      const sizeBytes = uint32le(table, baseOffset + 4)
      const offsetBytes = startSector * SECTOR_BYTES
      const name = entryName(table, baseOffset + 16)
      if (!name || !Number.isSafeInteger(offsetBytes) || offsetBytes < HEADER_BYTES + tableBytes || offsetBytes > fileInfo.size
          || (sizeBytes > 0 && (!Number.isSafeInteger(sizeBytes) || sizeBytes > fileInfo.size - offsetBytes))) {
        throw new Error(`SLB2 entry ${index} has an invalid name or byte range`)
      }

      const signature = Buffer.alloc(4)
      const { bytesRead } = await handle.read(signature, 0, signature.length, offsetBytes)
      const nestedFormat = bytesRead === 4 && signature.toString('hex') === '5414f5ee' ? 'playstation-update-fragment' : null
      if (nestedFormat) nestedPupHeaderCount += 1
      entries.push({ index, name, offsetBytes, declaredSizeBytes: sizeBytes > 0 ? sizeBytes : null, nestedFormat })
      observations.push(observation(input.artifactId, 'container_entry', `entry:${index}`, name, {
        index,
        name,
        offsetBytes,
        declaredSizeBytes: sizeBytes > 0 ? sizeBytes : null,
        nestedFormat,
        sizeIsDeclared: sizeBytes > 0,
      }))
    }

    return {
      status: 'completed',
      ...base,
      data: {
        format: 'SLB2',
        version,
        flags,
        entryCount,
        declaredSizeBytes,
        actualSizeBytes: fileInfo.size,
        nestedPupHeaderCount,
        entries,
        observations,
        decryptionPerformed: false,
      },
    }
  } catch (error) {
    return {
      status: 'failed',
      ...base,
      data: {},
      error: (error instanceof Error ? error.message : 'SLB2 inspection failed').slice(0, 1000),
    }
  } finally {
    await handle?.close().catch(() => {})
  }
}

export const slb2InspectorPlugin: ToolPlugin = {
  manifest: slb2InspectorManifest,
  analyze: inspectSlb2Artifact,
}
