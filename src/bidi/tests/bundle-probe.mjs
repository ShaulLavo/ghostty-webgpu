import { dirname, resolve } from 'node:path'

const result = await Bun.build({
  entrypoints: [resolve(process.argv[2])],
  outdir: resolve('.artifacts/bidi-probe'),
  target: 'browser',
  format: 'esm',
  minify: true,
  splitting: true,
  write: false,
})
if (!result.success) throw new AggregateError(result.logs, 'Bundle failed')
const files = new Map(
  await Promise.all(
    result.outputs.map(async (output) => [resolve(output.path), await output.text()]),
  ),
)
const pending = [resolve(result.outputs[0].path)]
const seen = new Set()
let initial = ''
while (pending.length) {
  const path = pending.pop()
  if (seen.has(path)) continue
  seen.add(path)
  const text = files.get(path)
  if (text === undefined) throw new Error(`Missing chunk ${path}`)
  initial += text
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g))
    pending.push(resolve(dirname(path), match[1]))
}
console.log(
  JSON.stringify({
    initialContainsBidi: initial.includes('getEmbeddingLevels'),
    initialBytes: initial.length,
    totalBytes: Array.from(files.values()).reduce((sum, text) => sum + text.length, 0),
    chunks: files.size,
  }),
)
