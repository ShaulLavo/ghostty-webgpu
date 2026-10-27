import { readFile, writeFile, stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
const out = '/work/tmp/ghw-study-20261027/bench/L7a'
const sizes = []
for (const path of ['ghostty-vt.wasm', 'bridge.wasm', 'canvas-compose.wasm']) {
  const data = await readFile(path)
  sizes.push({
    path,
    bytes: data.length,
    gzipBytes: gzipSync(data).length,
    sha256: createHash('sha256').update(data).digest('hex'),
  })
}
for (const entry of ['src/index.ts', 'src/worker/index.ts', 'src/worker/entry.ts']) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    minify: true,
  })
  if (!result.success) throw new Error(result.logs.join('\n'))
  const data = Buffer.from(await result.outputs[0].arrayBuffer())
  sizes.push({
    path: entry,
    bytes: data.length,
    gzipBytes: gzipSync(data).length,
    sha256: createHash('sha256').update(data).digest('hex'),
    kind: 'Bun 1.4.4 standalone minified ESM, all bundled imports',
  })
}
await writeFile(out + '/sizes.json', JSON.stringify(sizes, null, 2))
