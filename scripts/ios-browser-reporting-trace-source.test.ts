import { expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseSync } from 'oxc-parser'

const newSources = [
  'scripts/ios-browser-reporting-controller.ts',
  'scripts/ios-browser-reporting-data.ts',
  'scripts/ios-browser-reporting-native.ts',
  'scripts/ios-browser-reporting-owner.ts',
  'scripts/ios-browser-reporting-page.ts',
]

test('all matching source keeps bounded control flow', async () => {
  for (const path of newSources) {
    const parsed = parseSync(path, await readFile(path, 'utf8'))
    expect(parsed.errors, path).toEqual([])
    expect(depth(parsed.program), path).toBeLessThanOrEqual(3)
  }
})

test('matrix, flush, row membership and clocks retain their exact historical source', async () => {
  // Pin the reviewed sources without requiring unmerged PR history in a shallow CI checkout.
  const sources: readonly (readonly [string, string])[] = [
    [
      'scripts/ios-browser-reporting.synthetic.browser.test.ts',
      '4402a03599f5184f464cc3eb495fd9f8a31f6d594b64cb55273af5fe5dc13c1c',
    ],
    [
      'scripts/ios-browser-reporting-flush.synthetic.browser.test.ts',
      '36a338e06dfa3a8934c3a475ddf675d945c9c5b0e057e3f95db6c681808b3f16',
    ],
    [
      'scripts/ios-browser-reporting-cases.ts',
      'e3fc6db3b925fa07f9bc6846e243fa20a4c6847278308d67b49b0850ebf79fa0',
    ],
    [
      'scripts/ios-browser-reporting-manifest.ts',
      '805abdf683f11258141b1c607f7e19c856aa60c0ed8b517092f51b0effaba678',
    ],
    [
      'scripts/ios-browser-reporting-errors.synthetic.browser.test.ts',
      '20612fd0809589d527a8d0295ec51a956e7881283b1fe8adfee38299f21591b5',
    ],
  ]
  for (const [path, expected] of sources) {
    const actual = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    expect(actual, path).toBe(expected)
  }
})

test('actual bridge keeps the cleanup ACK, trace fence and ordinary retirement in order', async () => {
  const source = await readFile('scripts/ios-browser-page.ts', 'utf8')
  const body = source.slice(
    source.indexOf('export async function cleanupResponseReceived'),
    source.indexOf('export async function initialViewport'),
  )
  const ack = body.indexOf('observation.cleanupResponseReceived()')
  const fence = body.indexOf('trace.waitForTesterTrace()')
  const retirement = body.indexOf('observation.waitForRetirement()')
  expect(ack).toBeGreaterThan(-1)
  expect(fence).toBeGreaterThan(ack)
  expect(retirement).toBeGreaterThan(fence)
})

test('matching caller arms capture before run and uses only official host and attached provider', async () => {
  const source = await readFile('scripts/ios-browser-reporting-native.ts', 'utf8')
  expect(source.indexOf('host.captureTesterTrace(')).toBeLessThan(source.indexOf('await host.run('))
  expect(source).toContain('provider: attachedGhosttyProvider(host)')
  expect(source).toContain('owner.ownContext(context,')
  expect(source).toContain('registerClose(() =>')
  expect(source).toContain('return owner.closeContext()')
  expect(source).toContain('25000')
  expect(source).toContain('item.outcome === null')
  expect(source).not.toMatch(
    /playwright|chromium|createFrameworkControl|joinFrameworkExecution|runFrameworkNode|transport\.close\(/,
  )
})

function depth(value: unknown, current = 0): number {
  if (!value || typeof value !== 'object') return current
  const next = 'type' in value && value.type === 'BlockStatement' ? current + 1 : current
  let maximum = next
  for (const child of Object.values(value)) maximum = Math.max(maximum, depth(child, next))
  return maximum
}
