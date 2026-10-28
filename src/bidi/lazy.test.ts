import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.each(['src/index.ts','src/core/index.ts','src/worker/index.ts','src/worker/entry.ts'])('keeps BiDi implementation outside the initial %s bundle', entry => {
  const result = JSON.parse(execFileSync('bun',[fileURLToPath(new URL('./tests/bundle-probe.mjs',import.meta.url)),entry],{encoding:'utf8'}))
  expect(result.initialContainsBidi).toBe(false)
  expect(result.chunks).toBeGreaterThan(1)
})
