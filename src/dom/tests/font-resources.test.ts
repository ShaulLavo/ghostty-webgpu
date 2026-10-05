import { expect, it } from 'vitest'
import { fontResourcesMatch } from '../font-resources.js'

it.each([
  ['Bench Mono, monospace', 'Bench Mono'],
  ['Missing, "Bench Mono", monospace', 'Bench Mono'],
  ['"Bench, Mono", serif', '"Bench, Mono"'],
  ["'Bench Mono', monospace", '"bench mono"'],
  ['Bench\\20 Mono, monospace', 'Bench Mono'],
  ['"Bench \\"Mono\\"", serif', 'Bench "Mono"'],
])('matches completed resources in requested or fallback family %s', (family, loaded) => {
  expect(fontResourcesMatch(family, [{ family: loaded }])).toBe(true)
  expect(fontResourcesMatch(family, [{ family: 'Unrelated' }])).toBe(false)
})

it('ignores completions without a requested font resource', () => {
  expect(fontResourcesMatch('Bench Mono, monospace', [])).toBe(false)
  expect(fontResourcesMatch('Bench Mono, monospace', [{ family: 'Other Mono' }])).toBe(false)
})
