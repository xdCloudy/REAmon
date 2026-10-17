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
