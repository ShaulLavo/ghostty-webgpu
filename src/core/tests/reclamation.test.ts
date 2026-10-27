import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('bounds live borrowed memory and reclaims disposed WASM memories', () => {
  const output = execFileSync('bun', [new URL('fixtures/reclaim.ts', import.meta.url).pathname], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  const result = JSON.parse(output) as {
    readonly owned: number
    readonly borrowed: boolean
    readonly borrowedLive: boolean
    readonly borrowedBaselineBytes: number
    readonly borrowedPeakBytes: number
  }
  expect(result).toMatchObject({ owned: 0, borrowed: false, borrowedLive: true })
  expect(result.borrowedBaselineBytes).toBeGreaterThan(0)
  expect(result.borrowedPeakBytes).toBeLessThanOrEqual(result.borrowedBaselineBytes)
})
