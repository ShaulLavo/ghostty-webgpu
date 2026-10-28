import { dirname, resolve } from 'node:path'

export async function bundleGraph(outputs) {
  const files = new Map(
    await Promise.all(outputs.map(async (output) => [resolve(output.path), await output.text()])),
  )
  const pending = [resolve(outputs[0].path)]
  const seen = new Set()
  while (pending.length) {
    const path = pending.pop()
    if (seen.has(path)) continue
    seen.add(path)
    const text = files.get(path)
    if (text === undefined) throw new Error(`Missing chunk ${path}`)
    for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g))
      pending.push(resolve(dirname(path), match[1]))
  }
  return {
    initial: Array.from(seen, (path) => Buffer.from(files.get(path))),
    deferred: Array.from(files)
      .filter(([path]) => !seen.has(path))
      .map(([, text]) => Buffer.from(text)),
  }
}
