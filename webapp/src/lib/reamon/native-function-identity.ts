/**
 * Give native decompiler observations the same identity when providers spell
 * the same binary virtual address differently (for example, ram:00401000
 * and 0x401000). Restrict space-qualified matches to common virtual-memory
 * spaces so an unrelated address space cannot be merged by numeric offset.
 */
export function nativeFunctionIdentity(artifactId: string, address: string): string | null {
  const value = address.trim().toLowerCase()
  const qualified = /^ram:([0-9a-f]{1,64})$/.exec(value)
  const unqualified = /^(?:0x)?([0-9a-f]{1,64})$/.exec(value)
  const digits = qualified?.[1] ?? unqualified?.[1]
  if (!digits) return null
  const normalizedAddress = BigInt(`0x${digits}`).toString(16)
  return `${artifactId}:native:0x${normalizedAddress}`
}

/** Normalize profiler and Ghidra language IDs so native evidence can be compared safely. */
export function nativeArchitectureGroup(value: unknown): string | null {
  const candidates = typeof value === 'string'
    ? [value]
    : value && typeof value === 'object' && !Array.isArray(value)
      ? [Reflect.get(value, 'instructionArchitecture'), Reflect.get(value, 'architecture')]
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : []
  for (const candidate of candidates) {
    const architecture = candidate.trim().toLowerCase().replace(/[-\s]/g, '_')
    if (/^(?:x86_64|x86_64h|amd64|x64|x86:le:64(?::|$)|x86:be:64(?::|$))/.test(architecture)) return 'x86_64'
    if (/^(?:x86|i[3-6]86|i86pc|x86:le:32(?::|$)|x86:be:32(?::|$))/.test(architecture)) return 'x86'
    if (/^(?:aarch64|arm64|armv8|arm:le:64(?::|$)|aarch64:le:64(?::|$))/.test(architecture)) return 'arm64'
    if (/^(?:arm|armv[5-7]|thumb|arm:le:32(?::|$))/.test(architecture)) return 'arm32'
    if (/^(?:mips64|mips:.*:64(?::|$))/.test(architecture)) return 'mips64'
    if (/^(?:mips|mipsel|mips:.*:32(?::|$))/.test(architecture)) return 'mips32'
    if (/^(?:powerpc64|ppc64|powerpc:.*:64(?::|$))/.test(architecture)) return 'powerpc64'
    if (/^(?:powerpc|ppc|powerpc:.*:32(?::|$))/.test(architecture)) return 'powerpc32'
    if (/^(?:riscv64|riscv:.*:64(?::|$))/.test(architecture)) return 'riscv64'
    if (/^(?:riscv32|riscv:.*:32(?::|$))/.test(architecture)) return 'riscv32'
    if (/^(?:wasm64|wasm:.*:64(?::|$))/.test(architecture)) return 'wasm64'
    if (/^(?:wasm32|wasm|wasm:.*:32(?::|$))/.test(architecture)) return 'wasm32'
  }
  return null
}

/** Raw address spellings that may appear in provider observations. */
export function nativeAddressAliases(address: string): string[] {
  const normalized = address.trim().toLowerCase().replace(/^ram:/, '').replace(/^0x/, '')
  if (!/^[a-f0-9]{1,64}$/.test(normalized)) return []
  const value = BigInt(`0x${normalized}`).toString(16)
  return [...new Set([
    value,
    `0x${value}`,
    ...[4, 6, 8, 12, 16, 32, 64].map((width) => `ram:${value.padStart(width, '0')}`),
  ])]
}
