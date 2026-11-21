import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  BROWSER_ENGINES,
  discoverBrowserTestFiles,
  engineInvocation,
  parseShardSpec,
  selectShardFiles,
  splitShardHalves,
} from './browser-shard.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('parseShardSpec accepts valid shard arguments and rejects malformed values', () => {
  expect(parseShardSpec(['--shard=2/4'])).toEqual({ index: 2, total: 4 })
  expect(parseShardSpec(['--shard', '4/4'])).toEqual({ index: 4, total: 4 })
  expect(() => parseShardSpec([])).toThrow(/Usage:/)
  expect(() => parseShardSpec(['--shard=0/4'])).toThrow(/Invalid shard/)
  expect(() => parseShardSpec(['--shard=5/4'])).toThrow(/Invalid shard/)
  expect(() => parseShardSpec(['--shard=abc'])).toThrow(/Usage:/)
})

test('four shards and their disjoint halves partition every discovered browser test file once', async () => {
  const all = await discoverBrowserTestFiles(root)
  expect(all.length).toBeGreaterThan(0)
  const assigned: string[] = []
  for (let shard = 1; shard <= 4; shard++) {
    const chunk = selectShardFiles(all, shard, 4)
    expect(chunk.length).toBeGreaterThan(0)
    const [halfA, halfB] = splitShardHalves(chunk)
    expect(halfA.length).toBeGreaterThan(0)
    expect(halfB.length).toBeGreaterThan(0)
    expect(halfA.concat(halfB).toSorted()).toEqual(chunk)
    expect(new Set(halfA.concat(halfB)).size).toBe(chunk.length)
    assigned.push(...chunk)
  }
  expect(assigned.length).toBe(all.length)
  expect(new Set(assigned).size).toBe(all.length)
  expect(assigned.toSorted()).toEqual(all)
})

test('engineInvocation wraps only Firefox in xvfb-run and isolates engine cache directories', () => {
  const files = ['src/a.browser.test.ts', 'src/b.browser.test.ts']
  for (const engine of BROWSER_ENGINES) {
    const cacheDir = `/tmp/vite-${engine}`
    const invocation = engineInvocation(engine, files, cacheDir)
    expect(invocation.engine).toBe(engine)
    expect(invocation.env).toEqual({
      GHOSTTY_BROWSER_ENGINE: engine,
      GHOSTTY_BROWSER_CACHE_DIR: cacheDir,
    })
    const expectedPrefix =
      engine === 'firefox'
        ? ['xvfb-run', '-a', 'bun', 'run', 'test:browser']
        : ['bun', 'run', 'test:browser']
    expect(invocation.command).toEqual(expectedPrefix.concat(files))
  }
})
