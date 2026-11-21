import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  BROWSER_ENGINES,
  discoverBrowserTestFiles,
  engineInvocation,
  parseShardSpec,
  partitionSlices,
  runBrowserShard,
  selectShardFiles,
} from './browser-shard.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('parseShardSpec accepts valid shard, slice, and worker arguments and rejects malformed values', () => {
  expect(parseShardSpec(['--shard=1/1'])).toEqual({ index: 1, total: 1, slices: 6, workers: 3 })
  expect(parseShardSpec(['--shard=2/4'])).toEqual({ index: 2, total: 4, slices: 2, workers: 2 })
  expect(parseShardSpec(['--shard', '1/1', '--slices=4', '--workers', '2'])).toEqual({
    index: 1,
    total: 1,
    slices: 4,
    workers: 2,
  })
  expect(() => parseShardSpec([])).toThrow(/Usage:/)
  expect(() => parseShardSpec(['--shard=0/4'])).toThrow(/Invalid shard/)
  expect(() => parseShardSpec(['--shard=5/4'])).toThrow(/Invalid shard/)
  expect(() => parseShardSpec(['--shard=abc'])).toThrow(/Usage:/)
  expect(() => parseShardSpec(['--shard=1/1', '--slices=0'])).toThrow(/Invalid --slices/)
  expect(() => parseShardSpec(['--shard=1/1', '--workers=abc'])).toThrow(/Invalid --workers/)
})

test('discovered browser test files match Vitest browser discovery exactly', async () => {
  const discovered = await discoverBrowserTestFiles(root)
  const listed = execFileSync(
    'bunx',
    ['vitest', 'list', '--config', 'vitest.browser.config.ts', '--filesOnly'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]+\]\s+/, '').trim())
    .filter(Boolean)
    .toSorted()
  expect(discovered).toEqual(listed)
})

test('slices and shards partition every discovered browser test file without gaps or duplicates', async () => {
  const all = await discoverBrowserTestFiles(root)
  expect(all.length).toBeGreaterThan(0)
  let assigned: string[] = []
  for (let shard = 1; shard <= 4; shard++) {
    const chunk = selectShardFiles(all, shard, 4)
    expect(chunk.length).toBeGreaterThan(0)
    const slices = partitionSlices(chunk, 2)
    const combined = slices.reduce<string[]>((acc, slice) => acc.concat(slice), [])
    expect(combined.toSorted()).toEqual(chunk)
    expect(new Set(combined).size).toBe(chunk.length)
    assigned = assigned.concat(chunk)
  }
  expect(assigned.length).toBe(all.length)
  expect(new Set(assigned).size).toBe(all.length)
  expect(assigned.toSorted()).toEqual(all)
})

test('engineInvocation wraps only Firefox in xvfb-run and isolates cache directories and API ports', () => {
  const files = ['src/a.browser.test.ts', 'src/b.browser.test.ts']
  for (const engine of BROWSER_ENGINES) {
    const cacheDir = `/tmp/vite-${engine}`
    const invocation = engineInvocation(engine, files, { cacheDir, apiPort: 63335 })
    expect(invocation.engine).toBe(engine)
    expect(invocation.env).toEqual({
      GHOSTTY_BROWSER_ENGINE: engine,
      GHOSTTY_BROWSER_CACHE_DIR: cacheDir,
      GHOSTTY_BROWSER_API_PORT: '63335',
    })
    const expectedPrefix =
      engine === 'firefox'
        ? ['xvfb-run', '-a', 'bun', 'run', 'test:browser']
        : ['bun', 'run', 'test:browser']
    expect(invocation.command).toEqual(expectedPrefix.concat(files))
  }
})

test('runBrowserShard keeps slices disjoint in flight, runs all engines on failure, and propagates exit code', async () => {
  const files = Array.from({ length: 12 }, (_, index) => `src/case-${index}.browser.test.ts`)
  const activeSlices = new Set<number>()
  const seen = new Map<string, string[]>()
  let overlapDetected = false

  const outcome = await runBrowserShard({
    cwd: root,
    index: 1,
    total: 1,
    slices: 6,
    workers: 3,
    files,
    cacheRoot: '/tmp/test-browser-shard',
    log: () => {},
    runner: async (invocation, meta) => {
      if (activeSlices.has(meta.sliceIndex)) overlapDetected = true
      activeSlices.add(meta.sliceIndex)
      await new Promise((resolve) => setTimeout(resolve, 10))
      activeSlices.delete(meta.sliceIndex)
      const runFiles = invocation.command.slice(invocation.command.indexOf('test:browser') + 1)
      seen.set(invocation.engine, (seen.get(invocation.engine) ?? []).concat(runFiles))
      const failFirefoxSlice2 = invocation.engine === 'firefox' && meta.sliceIndex === 1
      return { exitCode: failFirefoxSlice2 ? 7 : 0, output: `${invocation.engine}/${meta.phase}` }
    },
  })

  expect(overlapDetected).toBe(false)
  expect(outcome.exitCode).toBe(7)
  expect(outcome.results.length).toBe(18)
  for (const engine of BROWSER_ENGINES) {
    expect((seen.get(engine) ?? []).toSorted()).toEqual(files.toSorted())
  }
})
