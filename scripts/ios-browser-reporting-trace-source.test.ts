import { expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { parseSync } from 'oxc-parser'

const baseline = '0d69040be1d27f8086adf9b9ce04be5b25eaf283'
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
  const paths = [
    'scripts/ios-browser-reporting.synthetic.browser.test.ts',
    'scripts/ios-browser-reporting-flush.synthetic.browser.test.ts',
    'scripts/ios-browser-reporting-cases.ts',
    'scripts/ios-browser-reporting-manifest.ts',
  ]
  for (const path of paths)
    expect(await readFile(path, 'utf8')).toBe(
      execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' }),
    )
  const path = 'scripts/ios-browser-reporting-errors.synthetic.browser.test.ts'
  const historical = execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' })
  const recorded = historical
    .replace(
      "import { until } from './ios-browser-reporting-realm.ts'",
      "import { until } from './ios-browser-reporting-realm.ts'\nimport { reportingArray } from './ios-browser-reporting-page.ts'",
    )
    .replace('const trace: ErrorTrace[] = []', 'const trace = reportingArray<ErrorTrace>()')
  expect(await readFile(path, 'utf8')).toBe(recorded)
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
