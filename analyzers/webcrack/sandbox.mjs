import { Isolate } from 'isolated-vm-6'

export async function createIsolate(code) {
  const isolate = new Isolate({ memoryLimit: 64 })
  let context
  try {
    context = await isolate.createContext()
    return await context.eval(code, {
      timeout: 8_000,
      copy: true,
      filename: 'file:///untrusted-obfuscated-snippet.js',
    })
  } finally {
    context?.release()
    isolate.dispose()
  }
}
