import { deepStrictEqual } from 'node:assert'
import { readFileSync } from 'node:fs'
import type { LinkCell, LinkLineSnapshot } from '../src/term/links.js'

interface MeasuredMapper {
  createLinkLineSnapshot(line: readonly LinkCell[]): LinkLineSnapshot
  readWork(): number
}

async function measure(source: string, name: string): Promise<MeasuredMapper> {
  const instrumented = source.replaceAll(/((?:for|while) \([^\n]+\) \{)/gu, '$1 work += 1;')
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `export const measurementName = ${JSON.stringify(name)}; let work = 0; export function readWork() { return work }; ${instrumented}`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

const before = await measure(
  readFileSync(new URL('./link-map-reference.ts', import.meta.url), 'utf8'),
  'before',
)
const after = await measure(
  readFileSync(new URL('../src/term/links.ts', import.meta.url), 'utf8'),
  'after',
)
const results = []
for (const columns of [80, 200, 1000, 4000]) {
  const cells = Array.from({ length: columns }, () => ({ text: 'a' }))
  const beforeStart = before.readWork()
  const afterStart = after.readWork()
  const expected = before.createLinkLineSnapshot(cells)
  const actual = after.createLinkLineSnapshot(cells)
  deepStrictEqual(actual, expected)
  results.push({
    columns,
    textLength: actual.text.length,
    before: before.readWork() - beforeStart,
    after: after.readWork() - afterStart,
  })
}
console.log(
  JSON.stringify({
    baseline: 'independent scan reference',
    metric: 'mapper loop iterations',
    equalOutput: true,
    results,
  }),
)
