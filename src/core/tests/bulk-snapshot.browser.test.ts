import { it } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
import { expectSnapshotTransitions } from './bulk-parity.js'

it('keeps packed/per-cell parity across default styles, palette changes, and screen switches', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    expectSnapshotTransitions(runtime)
  } finally {
    runtime.dispose()
  }
})
