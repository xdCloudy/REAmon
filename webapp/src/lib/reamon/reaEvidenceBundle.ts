import { createHash } from 'node:crypto'

const DIGEST = /^[a-f0-9]{64}$/
const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/
const ARCHITECTURES = ['x86', 'x86_64', 'arm', 'arm64', 'mips', '6502', 'riscv', 'powerpc', 'm68k', 'hexagon'] as const
const RAW_ONLY_ARCHITECTURES = new Set(['6502', 'm68k'])
const FORMATS = ['hopper', 'analysis-database', 'mach-o', 'elf', 'pe', 'dos-mz', 'dos-com', 'raw-binary', 'zip', 'ipa', 'apk', 'msix', 'appx', 'hap', 'hsp', 'app-pack', 'asar', 'dmg', 'pkg', 'plist', 'javascript', 'source-map', 'directory', 'file', 'unknown', 'mach-o-universal', 'javascript-bundle', 'entitlements'] as const
const MAX_RECORDS = 1000
const MAX_JSON_DEPTH = 64
const MAX_JSON_NODES = 250_000

type JsonObject = Record<string, unknown>
type EvidenceRecord = JsonObject & {
  evidence_id: string
  subject: (JsonObject & { digest: { sha256: string }; format: string; architecture: string | null }) | null
  provider: { id: string; name: string; version: string | null }
  analysis_profile: JsonObject | null
  environment: (JsonObject & { id: string; platform: string; architecture: string; isolation: string }) | null
  predicate_type: string
  operation: string
  authority: string
}

export type ValidatedReaEvidenceBundle = {
  records: EvidenceRecord[]
  bundleDigest: string
}

export class ReaEvidenceBundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReaEvidenceBundleError'
  }
}

function fail(message: string): never {
  throw new ReaEvidenceBundleError(message)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strictKeys(value: JsonObject, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`Missing required field: ${key}`)
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`Unexpected field: ${key}`)
}

function string(value: unknown, label: string, nonEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) fail(`${label} must be ${nonEmpty ? 'a non-empty ' : 'a '}string`)
}

function jsonValue(value: unknown, label: string): void {
  const validUnicode = (text: string): boolean => {
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i)
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = text.charCodeAt(i + 1)
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false
        i++
      } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
    }
    return true
  }
  let visited = 0
  const visit = (node: unknown, depth: number): void => {
    if (++visited > MAX_JSON_NODES) fail(`${label} exceeds the JSON value limit`)
    if (depth > MAX_JSON_DEPTH) fail(`${label} exceeds the JSON nesting limit`)
    if (typeof node === 'string') {
      if (!validUnicode(node)) fail(`${label} contains invalid Unicode`)
      return
    }
    if (node === null || typeof node === 'boolean') return
    if (typeof node === 'number' && Number.isFinite(node)) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (isObject(node)) {
      for (const [key, item] of Object.entries(node)) {
        visit(key, depth + 1)
        visit(item, depth + 1)
      }
      return
    }
    fail(`${label} contains a value that is not JSON`)
  }
  visit(value, 0)
}

// RFC 8785 uses ECMAScript number/string serialization and UTF-16 key ordering.
function canonicalJson(value: unknown): string {
  const encoded = (node: unknown): string => {
    if (node === null || typeof node !== 'object') {
      const result = JSON.stringify(node)
      if (result === undefined) fail('Value cannot be represented as canonical JSON')
      return result
    }
    if (Array.isArray(node)) return `[${node.map(encoded).join(',')}]`
    const object = node as JsonObject
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${encoded(object[key])}`).join(',')}}`
  }
  return encoded(value)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!)
  const b = Array.from(right, (char) => char.codePointAt(0)!)
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

function uniqueSorted(values: unknown[]): unknown[] {
  const byJson = new Map<string, unknown>()
  for (const value of values) byJson.set(JSON.stringify(value), value)
  return [...byJson.entries()].sort(([a], [b]) => codePointCompare(a, b)).map(([, value]) => value)
}

function provider(value: unknown, label: string): asserts value is { id: string; name: string; version: string | null } {
  if (!isObject(value)) fail(`${label} must be an object`)
  strictKeys(value, ['id', 'name', 'version'])
  string(value.id, `${label}.id`, true)
  string(value.name, `${label}.name`, true)
  if (value.version !== null) string(value.version, `${label}.version`)
}

function environment(value: unknown, label: string): asserts value is JsonObject {
  if (!isObject(value)) fail(`${label} must be an object`)
  strictKeys(value, ['id', 'platform', 'architecture', 'isolation'])
  for (const key of ['id', 'platform', 'architecture']) string(value[key], `${label}.${key}`, true)
  if (!['none', 'process', 'container', 'virtual-machine'].includes(String(value.isolation))) fail(`${label}.isolation is invalid`)
}

function validateSubject(value: unknown, label: string): asserts value is EvidenceRecord['subject'] {
  if (value === null) return
  if (!isObject(value)) fail(`${label} must be an object or null`)
  strictKeys(value, ['name', 'digest', 'local_path', 'format', 'architecture'])
  string(value.name, `${label}.name`, true)
  string(value.local_path, `${label}.local_path`)
  if (value.local_path.includes('\0')) fail(`${label}.local_path contains a NUL character`)
  if (!FORMATS.includes(value.format as typeof FORMATS[number])) fail(`${label}.format is unsupported`)
  if (!isObject(value.digest)) fail(`${label}.digest must be an object`)
  strictKeys(value.digest, ['sha256'])
  string(value.digest.sha256, `${label}.digest.sha256`)
  if (!DIGEST.test(value.digest.sha256)) fail(`${label}.digest.sha256 must be lowercase SHA-256`)
  if (value.architecture !== null && !ARCHITECTURES.includes(value.architecture as typeof ARCHITECTURES[number])) fail(`${label}.architecture is invalid`)
  if (value.format === 'raw-binary') {
    // Raw binary may use any declared architecture.
  } else if (value.architecture !== null && RAW_ONLY_ARCHITECTURES.has(value.architecture as string)) {
    fail(`${label}.architecture is only supported for raw-binary subjects`)
  }
}

function validateProfile(value: unknown, recordProvider: EvidenceRecord['provider'], label: string): void {
  if (value === null) return
  if (!isObject(value)) fail(`${label} must be an object or null`)
  strictKeys(value, ['provider', 'parameters', 'digest'])
  provider(value.provider, `${label}.provider`)
  if (value.provider.version === null || value.provider.version.length === 0) fail(`${label}.provider.version must be a non-empty string`)
  if (!isObject(value.parameters)) fail(`${label}.parameters must be an object`)
  jsonValue(value.parameters, `${label}.parameters`)
  string(value.digest, `${label}.digest`)
  if (!DIGEST.test(value.digest)) fail(`${label}.digest must be lowercase SHA-256`)
  const { digest, ...unsigned } = value
  if (sha256(unsigned) !== digest) fail(`${label}.digest does not match its contents`)
  if (value.provider.id !== recordProvider.id || value.provider.name !== recordProvider.name || value.provider.version !== recordProvider.version) fail(`${label}.provider does not match the Evidence provider`)
}

function validateCoverage(value: unknown, label: string): void {
  if (value === null) return
  if (!isObject(value)) fail(`${label} must be an object or null`)
  if (value.status === 'complete') {
    strictKeys(value, ['status', 'diagnostics'])
    if (!Array.isArray(value.diagnostics) || value.diagnostics.length === 0 || value.diagnostics.some((entry) => typeof entry !== 'string' || entry.length === 0)) fail(`${label}.diagnostics must contain non-empty strings`)
  } else if (value.status === 'partial') {
    strictKeys(value, ['status', 'limitations', 'diagnostics'], ['limited_directions'])
    if (!Array.isArray(value.limitations) || value.limitations.length === 0 || value.limitations.some((entry) => typeof entry !== 'string' || entry.length === 0)) fail(`${label}.limitations must contain non-empty strings`)
    if (!Array.isArray(value.diagnostics) || value.diagnostics.length === 0 || value.diagnostics.some((entry) => typeof entry !== 'string' || entry.length === 0)) fail(`${label}.diagnostics must contain non-empty strings`)
    validateDirections(value.limited_directions, label)
  } else if (value.status === 'unknown') {
    strictKeys(value, ['status', 'reason', 'diagnostics'], ['limited_directions'])
    string(value.reason, `${label}.reason`, true)
    if (!Array.isArray(value.diagnostics) || value.diagnostics.length === 0 || value.diagnostics.some((entry) => typeof entry !== 'string' || entry.length === 0)) fail(`${label}.diagnostics must contain non-empty strings`)
    validateDirections(value.limited_directions, label)
  } else fail(`${label}.status is invalid`)
}

function validateDirections(value: unknown, label: string): void {
  if (value === undefined) return
  if (!Array.isArray(value) || (JSON.stringify(value) !== '["callers"]' && JSON.stringify(value) !== '["callees"]' && JSON.stringify(value) !== '["callers","callees"]')) fail(`${label}.limited_directions is invalid`)
}

function validateRecord(value: unknown, index: number): asserts value is EvidenceRecord {
  const label = `records[${index}]`
  if (!isObject(value)) fail(`${label} must be an object`)
  strictKeys(value, ['evidence_id', 'subject', 'provider', 'analysis_profile', 'predicate_type', 'operation', 'parameters', 'raw_result', 'normalized_result', 'confidence', 'authority', 'environment', 'limitations', 'relationship_coverage', 'locations', 'evidence_links'])
  string(value.evidence_id, `${label}.evidence_id`)
  if (!EVIDENCE_ID.test(value.evidence_id)) fail(`${label}.evidence_id is invalid`)
  validateSubject(value.subject, `${label}.subject`)
  provider(value.provider, `${label}.provider`)
  validateProfile(value.analysis_profile, value.provider, `${label}.analysis_profile`)
  string(value.predicate_type, `${label}.predicate_type`, true)
  string(value.operation, `${label}.operation`, true)
  if (!isObject(value.parameters)) fail(`${label}.parameters must be an object`)
  jsonValue(value.parameters, `${label}.parameters`)
  if (value.raw_result !== null) jsonValue(value.raw_result, `${label}.raw_result`)
  jsonValue(value.normalized_result, `${label}.normalized_result`)
  if (!['observed', 'derived', 'inferred'].includes(String(value.confidence))) fail(`${label}.confidence is invalid`)
  if (!['shipped-artifact', 'controlled-replay', 'historical-reference', 'external-service', 'analyst-inference'].includes(String(value.authority))) fail(`${label}.authority is invalid`)
  if (value.environment !== null) environment(value.environment, `${label}.environment`)
  if (!Array.isArray(value.limitations) || value.limitations.some((item) => typeof item !== 'string')) fail(`${label}.limitations must be strings`)
  validateCoverage(value.relationship_coverage, `${label}.relationship_coverage`)
  if (!Array.isArray(value.locations)) fail(`${label}.locations must be an array`)
  for (const [locationIndex, location] of value.locations.entries()) {
    const path = `${label}.locations[${locationIndex}]`
    if (!isObject(location)) fail(`${path} must be an object`)
    if (location.kind === 'address') { strictKeys(location, ['kind', 'address']); string(location.address, `${path}.address`, true) }
    else if (location.kind === 'address-range') { strictKeys(location, ['kind', 'start', 'end']); string(location.start, `${path}.start`, true); string(location.end, `${path}.end`, true) }
    else if (location.kind === 'artifact-path') { strictKeys(location, ['kind', 'path']); string(location.path, `${path}.path`, true) }
    else if (location.kind === 'file-offset') { strictKeys(location, ['kind', 'offset']); if (!Number.isInteger(location.offset) || Number(location.offset) < 0) fail(`${path}.offset must be a non-negative integer`) }
    else if (location.kind === 'file-offset-range') { strictKeys(location, ['kind', 'start', 'end']); if (!Number.isInteger(location.start) || Number(location.start) < 0 || !Number.isInteger(location.end) || Number(location.end) < 0) fail(`${path} offsets must be non-negative integers`) }
    else fail(`${path}.kind is invalid`)
  }
  if (!Array.isArray(value.evidence_links) || value.evidence_links.some((item) => typeof item !== 'string' || !EVIDENCE_ID.test(item))) fail(`${label}.evidence_links must contain Evidence IDs`)
  const { evidence_id, subject, ...semantic } = value
  const semanticProjection = {
    subject: subject === null ? null : { digest: subject.digest, format: subject.format, architecture: subject.architecture },
    provider: value.provider,
    analysis_profile: value.analysis_profile,
    predicate_type: value.predicate_type,
    operation: value.operation,
    parameters: value.parameters,
    raw_result: value.raw_result,
    normalized_result: value.normalized_result,
    confidence: value.confidence,
    authority: value.authority,
    environment: value.environment,
    limitations: value.limitations,
    relationship_coverage: value.relationship_coverage,
    locations: value.locations,
    evidence_links: value.evidence_links,
  }
  void semantic
  if (`ev_${sha256(semanticProjection)}` !== evidence_id) fail(`${label}.evidence_id does not match its semantic contents`)
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function validateManifest(bundle: JsonObject, records: EvidenceRecord[]): void {
  const recordSubjects = records.flatMap((record) => record.subject === null ? [] : [{ digest: record.subject.digest, format: record.subject.format, architecture: record.subject.architecture }])
  const providers = records.map((record) => ({ id: record.provider.id, name: record.provider.name, version: record.provider.version }))
  const environments = records.flatMap((record) => record.environment === null ? [] : [{ id: record.environment.id, platform: record.environment.platform, architecture: record.environment.architecture, isolation: record.environment.isolation }])
  const scenarios = records.filter((record) => record.authority === 'controlled-replay').map((record) => ({ evidence_id: record.evidence_id, operation: record.operation, authority: record.authority }))
  const captures = records.filter((record) => record.predicate_type === 'rea.process-capture').map((record) => ({ evidence_id: record.evidence_id, predicate_type: record.predicate_type }))
  const expected = {
    artifacts: uniqueSorted(recordSubjects),
    providers: uniqueSorted(providers),
    environments: uniqueSorted(environments),
    scenarios,
    captures,
    unknowns: [],
    records,
  }
  for (const field of ['artifacts', 'providers', 'environments', 'scenarios', 'captures', 'unknowns', 'records']) {
    if (!sameJson(bundle[field], expected[field as keyof typeof expected])) fail(`Bundle ${field} manifest does not match its records or canonical ordering`)
  }
}

export function parseReaEvidenceBundle(input: unknown): ValidatedReaEvidenceBundle {
  if (!isObject(input)) fail('Expected a REA Evidence bundle object')
  strictKeys(input, ['artifacts', 'providers', 'environments', 'scenarios', 'captures', 'unknowns', 'records'])
  for (const key of ['artifacts', 'providers', 'environments', 'scenarios', 'captures', 'unknowns', 'records']) {
    if (!Array.isArray(input[key])) fail(`Bundle ${key} must be an array`)
  }
  const unknowns = input.unknowns as unknown[]
  const rawRecords = input.records as unknown[]
  if (unknowns.length > 0) fail('This REAmon importer currently supports bundles without residual-unknown history. Re-export after resolving or omitting that history.')
  if (rawRecords.length === 0) fail('Bundle contains no Evidence records')
  if (rawRecords.length > MAX_RECORDS) fail(`Bundle exceeds the ${MAX_RECORDS} record limit`)
  jsonValue(input, 'bundle')
  rawRecords.forEach(validateRecord)
  const records = rawRecords as EvidenceRecord[]
  const ids = new Set<string>()
  for (const record of records) {
    if (ids.has(record.evidence_id)) fail('Bundle contains duplicate Evidence record IDs')
    ids.add(record.evidence_id)
  }
  if ([...records].sort((a, b) => codePointCompare(a.evidence_id, b.evidence_id)).some((record, index) => record !== records[index])) fail('Bundle records are not in canonical Evidence ID order')
  validateManifest(input, records)
  return { records, bundleDigest: createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex') }
}
