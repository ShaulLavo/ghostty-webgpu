import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const bundleIndex = args.indexOf('--bundle')
const root = resolve(import.meta.dirname, '..')
const bundle = resolve(
  bundleIndex >= 0 ? args[bundleIndex + 1]! : join(root, '.artifacts/comparison-bundle'),
)
const build = Bun.spawn([process.execPath, join(root, 'scripts/build-comparison.ts'), bundle], {
  stdout: 'inherit',
  stderr: 'inherit',
})
assert.equal(await build.exited, 0, 'Comparison bundle failed')
if (!args.includes('--build-only')) {
  const forwarded = args.filter(
    (argument, index) => bundleIndex < 0 || (index !== bundleIndex && index !== bundleIndex + 1),
  )
  const run = Bun.spawn(['node', join(bundle, 'comparison-runner.mjs')].concat(forwarded), {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exitCode = await run.exited
}
