import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createLinkLineSnapshot as reference } from '../../../scripts/link-map-reference.js'
import { createLinkLineSnapshot, type LinkCell } from '../links.js'

function seededRows(): LinkCell[][] {
  let seed = 0x3d46a2ed
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  const alphabet = ['', 'a', '界', '🙂', 'e\u0301', '\ud800', '\udfff', 'אב', '👩‍💻']
  return Array.from({ length: 250 }, () =>
    Array.from({ length: next() % 80 }, () => {
      if (next() % 4 === 0) return { continuation: true, text: '' }
      return { text: alphabet[next() % alphabet.length]! }
    }),
  )
}

describe('link boundary maps', () => {
  const fixed: LinkCell[][] = [
    [],
    [{ text: '' }],
    [{ continuation: true, text: '' }],
    [{ text: 'a' }, { text: '' }, { text: 'b' }],
    [{ text: 'e\u0301' }, { text: '界' }, { continuation: true, text: '' }, { text: '🙂' }],
    [
      { continuation: true, text: '' },
      { text: '🙂' },
      { continuation: true, text: '' },
      { continuation: true, text: '' },
    ],
  ]
  it.each(fixed.concat(seededRows()).map((line, index) => ({ line, index })))(
    'matches the independent scan for UTF-16 row $index',
    ({ line }) => {
      const snapshot = createLinkLineSnapshot(line)
      expect(snapshot).toEqual(reference(line))
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.cells)).toBe(true)
      expect(Object.isFrozen(snapshot.startCellByTextBoundary)).toBe(true)
      expect(Object.isFrozen(snapshot.endCellByTextBoundary)).toBe(true)
    },
  )

  it('bounds mapper work by cells plus UTF-16 text, not their product', () => {
    const output: unknown = JSON.parse(
      execFileSync('bun', ['scripts/link-map-benchmark.ts'], { encoding: 'utf8' }),
    )
    expect(output).toMatchObject({ equalOutput: true })
    if (
      !output ||
      typeof output !== 'object' ||
      !('results' in output) ||
      !Array.isArray(output.results)
    )
      throw new Error('benchmark did not return results')
    for (const result of output.results) {
      expect(result.after).toBeGreaterThanOrEqual(result.columns)
      expect(result.after).toBeLessThanOrEqual(6 * (result.columns + result.textLength + 1))
    }
  })
})
