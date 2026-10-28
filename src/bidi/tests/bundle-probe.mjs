import { resolve } from 'node:path'
import { bundleGraph } from '../../../scripts/bundle-graph.mjs'

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
const graph = await bundleGraph(result.outputs)
console.log(
  JSON.stringify({
    initialContainsBidi: graph.initial.some((text) => text.includes('getEmbeddingLevels')),
    initialBytes: graph.initial.reduce((sum, bytes) => sum + bytes.length, 0),
    totalBytes: graph.initial.concat(graph.deferred).reduce((sum, bytes) => sum + bytes.length, 0),
    chunks: result.outputs.length,
  }),
)
