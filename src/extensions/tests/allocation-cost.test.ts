import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const runner = fileURLToPath(
  new URL('../../../../scripts/ghostty-extension-allocation-counters.ts', import.meta.url),
)
const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0

it.skipIf(!bunAvailable || !existsSync(runner))(
  'keeps inert attachment factory evaluations at the fresh handle budget (requires Bun and Fregat allocation instrumentation)',
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'extension-allocation-'))
    try {
      const result = spawnSync('bun', [runner, join(scratch, 'proof')], {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 20_000,
      })
      expect(result.error, result.stderr).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(0)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
  30_000,
)
