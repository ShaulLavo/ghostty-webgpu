import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Terminal } from '../src/dom/terminal.js'
import { ExtensionManager } from '../src/extensions/manager.js'

const output = process.argv[2]!
const owned = globalThis as typeof globalThis & { __extensionOwned: Record<string, number> }
const terminal = await Terminal.create({
  runtime: {
    kind: 'owned',
    options: {
      wasm: pathToFileURL(join(output, 'ghostty-vt.wasm')),
      bridge: pathToFileURL(join(output, 'bridge.wasm')),
    },
  },
})
const empty = Object.freeze({})
const target = { name: 'target', setup: () => empty }
const input = { type: 'text' as const, data: 'a' }
const rows = []
try {
  for (const inert of [0, 100, 1_000]) {
    const manager = new ExtensionManager({
      terminal,
      reservedOsc: new Set(),
      onError: (cause) => {
        throw cause
      },
    })
    manager.install(
      Array.from({ length: inert }, (_, index) => ({
        name: `inert-${index}`,
        setup: target.setup,
      })),
    )
    manager.use(target).dispose()
    owned.__extensionOwned = Object.create(null) as Record<string, number>
    for (let index = 0; index < 1_000; index += 1) manager.use(target).dispose()
    const lifecycle = { ...owned.__extensionOwned }
    owned.__extensionOwned = Object.create(null) as Record<string, number>
    let payloads = 0
    for (let index = 0; index < 1_000; index += 1) {
      assert.equal(manager.dispatchInput(input), false)
      manager.emit('frame', () => {
        payloads += 1
        return { rows: [0] }
      })
    }
    assert.equal(payloads, 0)
    assert.deepEqual(Object.keys(owned.__extensionOwned), [])
    let calls = 0
    let frames = 0
    const positive = manager.use({
      name: 'positive',
      setup: () => ({
        input: () => {
          calls += 1
          return 'pass'
        },
        events: {
          frame: () => {
            frames += 1
          },
        },
      }),
    })
    const positiveAllocation = { ...owned.__extensionOwned }
    assert(
      Object.keys(positiveAllocation).length > 0,
      'Allocation instrumentation must observe attachment setup',
    )
    owned.__extensionOwned = Object.create(null) as Record<string, number>
    for (let index = 0; index < 1_000; index += 1) {
      manager.dispatchInput(input)
      manager.emit('frame', () => {
        payloads += 1
        return { rows: [0] }
      })
    }
    assert.equal(calls, 1_000)
    assert.equal(frames, 1_000)
    assert.equal(payloads, 1_000)
    assert.deepEqual(Object.keys(owned.__extensionOwned), [])
    positive.dispose()
    manager.dispose()
    rows.push({ inert, operations: 1_000, lifecycle, positiveAllocation, calls, frames, payloads })
  }
  await writeFile(
    join(output, 'counters.json'),
    JSON.stringify(
      {
        qualification:
          'Exact source allocation-site evaluations and Object.entries factory calls in manager only. JIT elimination, implicit iterators, VM/native heap allocations and public paths remain separate.',
        rows,
      },
      null,
      2,
    ),
  )
} finally {
  terminal.dispose()
}
