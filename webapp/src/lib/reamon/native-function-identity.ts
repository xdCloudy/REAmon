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
