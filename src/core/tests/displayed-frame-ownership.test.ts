import { setImmediate } from 'node:timers/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { retainDisplayedFrame } from '../../render/shared/displayed-frame.js'
import { GhosttyRuntime } from '../runtime.js'
import type { RenderTextRow } from '../types.js'

const grid = { columns: 40, rows: 100 }
setFlagsFromString('--expose-gc')
const collect: () => void = runInNewContext('gc')

function observeCopiedBuffers() {
  const references: WeakRef<ArrayBufferLike>[] = []
  const Constructor = Uint32Array
  const slice = Constructor.prototype.slice
  Constructor.prototype.slice = function (start?: number, end?: number) {
    const result = slice.call(this, start, end)
    references.push(new WeakRef(result.buffer))
    return result
  }
  globalThis.Uint32Array = new Proxy(Constructor, {
    construct(target, args, newTarget) {
      const result = Reflect.construct(target, args, newTarget)
      if (typeof args[0] === 'number' && result instanceof Constructor)
        references.push(new WeakRef(result.buffer))
      return result
    },
  })
  return {
    restore() {
      globalThis.Uint32Array = Constructor
      Constructor.prototype.slice = slice
    },
    async bytes() {
      // WeakRef targets survive their current job, so collect on separate event-loop turns.
      for (let turn = 0; turn < 3; turn += 1) {
        await setImmediate()
        collect()
      }
      const buffers = new Set<ArrayBufferLike>()
      for (const reference of references) {
        const buffer = reference.deref()
        if (buffer) buffers.add(buffer)
      }
      let bytes = 0
      for (const buffer of buffers) bytes += buffer.byteLength
      return bytes
    },
  }
}

function rowText(y: number, revision: number): string {
  return `界é👩‍💻 ${y} v${revision}`
}

function retainedTextRows(state: ReturnType<GhosttyRuntime['createRenderState']>) {
  const frame = state[retainDisplayedFrame]()
  frame.accept()
  return frame.readTextRows()
}

function expectOwnedRows(rows: readonly RenderTextRow[]): void {
  for (const row of rows) {
    expect(Object.isFrozen(row)).toBe(true)
    expect(Object.isFrozen(row.cells)).toBe(true)
    expect(Object.isFrozen(row.continuations)).toBe(true)
  }
}

it('retains exactly one grid of copied bytes while displayed rows freeze', async () => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal(grid)
  const state = runtime.createRenderState(terminal)
  let latest: readonly RenderTextRow[] | undefined
  const payload = observeCopiedBuffers()
  try {
    for (let revision = 0; revision < grid.rows; revision += 1) {
      terminal.write(
        '\x1b[?2027h' +
          Array.from(
            { length: grid.rows - revision },
            (_, offset) =>
              `\x1b[${revision + offset + 1};1H\x1b[2K${rowText(revision + offset, revision)}`,
          ).join(''),
      )
      state.update()
      latest = retainedTextRows(state)
      state.acknowledge()
    }
    payload.restore()
    expect(latest!.map(({ y, text }) => ({ y, text: text.trimEnd() }))).toEqual(
      Array.from({ length: grid.rows }, (_, y) => ({ y, text: rowText(y, y) })),
    )
    runtime.dispose()
    expect(await payload.bytes()).toBe(50_000)
    expectOwnedRows(latest!)
    latest = undefined
    expect(await payload.bytes()).toBe(0)
  } finally {
    payload.restore()
    runtime.dispose()
  }
}, 30_000)
