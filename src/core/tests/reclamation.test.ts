import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('reclaims owned and borrowed WASM memories after repeated terminal disposal', () => {
  const output = execFileSync('bun', [new URL('fixtures/reclaim.ts', import.meta.url).pathname], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(JSON.parse(output)).toEqual({ owned: 0, borrowed: false })
})
