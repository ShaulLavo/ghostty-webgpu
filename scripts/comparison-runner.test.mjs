import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const source = await readFile(new URL('./comparison-runner.mjs', import.meta.url), 'utf8')
const start = source.indexOf('async function measureBody(')
const end = source.indexOf('\ntry {\n  browser =', start)
assert(start >= 0 && end > start, 'Runner measurement boundary must exist')
// Execute the real failure handler without the runner's top-level browser and hardware setup.
const createMeasureBody = new Function(
  'browser',
  'tracing',
  'phases',
  's',
  'output',
  'join',
  'writeFile',
  'origin',
  'smoke',
  'args',
  `return ${source.slice(start, end)}`,
)

async function failureArtifacts(testCase, repetition) {
  const screenshots = []
  const captures = []
  const error = new Error('Injected page navigation failure')
  error.captureData = Buffer.from('captured PNG').toString('base64')
  error.captureMetadata = { timestamp: 1 }
  const page = {
    on() {},
    goto: async () => {
      throw error
    },
    evaluate: async () => ({}),
    screenshot: async ({ path }) => screenshots.push(basename(path)),
  }
  const context = { newPage: async () => page, close: async () => {} }
  const measureBody = createMeasureBody(
    { newContext: async () => context },
    false,
    [],
    { viewport: { width: 1, height: 1 }, dpr: 1 },
    join(tmpdir(), 'comparison-runner-test'),
    join,
    async (path, bytes) => {
      captures.push(basename(path))
      assert.equal(bytes.toString(), 'captured PNG')
    },
    'http://localhost',
    true,
    [],
  )
  const contexts = new Set()
  const run = {}
  await measureBody(testCase, repetition, undefined, run, contexts)
  assert.match(run.error, /Injected page navigation failure/)
  assert.equal(contexts.size, 0)
  return { screenshots, captures }
}

for (const [kind, prefix] of [
  ['screenshots', 'failure'],
  ['captures', 'capture-failure'],
]) {
  test(`${prefix} artifacts distinguish paired frame builders`, async () => {
    const names = []
    for (const frameBuilder of ['js', 'zig']) {
      const artifacts = await failureArtifacts(
        { variant: 'ghostty-webgpu', frameBuilder, path: 'bytes', count: 8 },
        2,
      )
      assert.deepEqual(artifacts[kind], [`${prefix}-ghostty-webgpu-${frameBuilder}-bytes-8-2.png`])
      names.push(...artifacts[kind])
    }
    assert.equal(new Set(names).size, 2)
  })
}

test('failure artifacts retain control variant, write path, count, and repetition', async () => {
  const artifacts = await failureArtifacts({ variant: 'xterm-webgl', path: 'string', count: 17 }, 3)
  assert.deepEqual(artifacts, {
    screenshots: ['failure-xterm-webgl-string-17-3.png'],
    captures: ['capture-failure-xterm-webgl-string-17-3.png'],
  })
})
