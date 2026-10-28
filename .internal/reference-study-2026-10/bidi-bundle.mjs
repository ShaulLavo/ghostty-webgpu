import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { bundleGraph } from '../../scripts/bundle-graph.mjs'
import { gzipSync } from 'node:zlib'

function command(name, args, input) {
  const result = spawnSync(name, args, { input, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.toString())
  return result.stdout
}

async function bundle(root, entry) {
  const result = await Bun.build({
    entrypoints: [join(root, 'src', entry)],
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: true,
    write: false,
  })
  if (!result.success) throw new AggregateError(result.logs, 'Bundle failed')
  const graph = await bundleGraph(result.outputs)
  const initial = sizes(graph.initial)
  return {
    ...initial,
    deferred: sizes(graph.deferred),
    initialContainsBidi: graph.initial.some((bytes) => bytes.includes('getEmbeddingLevels')),
  }
}

function sizes(files) {
  return {
    bytes: files.reduce((sum, bytes) => sum + bytes.length, 0),
    gzipBytes: files.reduce((sum, bytes) => sum + gzipSync(bytes, { level: 9 }).length, 0),
  }
}

const baseline = process.argv[2]
if (!baseline)
  throw new Error('Usage: bun .internal/reference-study-2026-10/bidi-bundle.mjs BASE_REF')
const root = resolve('.')
const scratch = await mkdtemp('/work/tmp/ghostty-c3-bundle-')
try {
  command('tar', ['-x', '-C', scratch], command('git', ['archive', baseline, 'src']))
  await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const entries = {}
  for (const entry of ['index.ts', 'worker/index.ts', 'worker/entry.ts']) {
    const before = await bundle(scratch, entry)
    const after = await bundle(root, entry)
    entries[entry] = {
      before,
      after,
      delta: { bytes: after.bytes - before.bytes, gzipBytes: after.gzipBytes - before.gzipBytes },
    }
  }
  console.log(
    JSON.stringify(
      {
        bun: Bun.version,
        baseline: command('git', ['rev-parse', baseline]).toString().trim(),
        entries,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(scratch, { recursive: true, force: true })
}
