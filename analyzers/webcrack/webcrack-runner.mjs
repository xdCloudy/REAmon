import { webcrack } from 'webcrack'

export function analyzeJavaScript(source, options) {
  return webcrack(source, {
    jsx: true,
    unpack: true,
    unminify: true,
    deobfuscate: true,
    mangle: false,
    sandbox: options.sandbox,
  })
}
