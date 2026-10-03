import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await Bun.build({
  entrypoints: [resolve(root, 'src/worker/entry.ts')],
  outdir: resolve(root, 'dist/worker'),
  target: 'browser',
  format: 'esm',
  sourcemap: 'external',
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exitCode = 1
}
