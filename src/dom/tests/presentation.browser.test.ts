import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { Terminal } from '../terminal.js'
import type { GhosttyWebGpuTerminalOptions } from '../types.js'

const terminals: Terminal[] = []
const hosts: HTMLElement[] = []
let runtime: GhosttyRuntime
beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterEach(async () => {
  for (const terminal of terminals.splice(0).reverse()) await terminal.dispose()
  for (const host of hosts.splice(0)) host.remove()
})
afterAll(() => runtime.dispose())

async function openTerminal(options: GhosttyWebGpuTerminalOptions): Promise<Terminal> {
  const host = document.createElement('div')
  host.style.cssText = 'width:480px;height:160px;position:relative'
  document.body.append(host)
  hosts.push(host)
  const terminal = await Terminal.create({
    ...options,
    appearance: { cursor: { blink: false }, font: { family: 'monospace', size: 16 } },
    runtime: { kind: 'borrowed', runtime },
  })
  terminals.push(terminal)
  await terminal.open(host)
  await expect.poll(() => terminal.hasPendingFrame).toBe(false)
  // The settled paint keeps immediate writes batched until the following frame.
  for (let frame = 0; frame < 2; frame += 1)
    await new Promise((resolve) => requestAnimationFrame(resolve))
  return terminal
}

it.for([undefined, 'canvas2d-fill-text'] as const)(
  'paints an immediate write before the next frame (%s)',
  async (rendererMode) => {
    const terminal = await openTerminal({ presentation: 'immediate', rendererMode })
    const rows: (readonly number[])[] = []
    terminal.onFrame(({ rows: changed }) => rows.push(changed))

    terminal.write('first')
    expect(rows).toHaveLength(1)
    expect(terminal.hasPendingFrame).toBe(false)
    terminal.write(' second')
    expect(rows).toHaveLength(1)
    expect(terminal.hasPendingFrame).toBe(true)

    await expect.poll(() => terminal.visibleLines()[0]?.includes('first second')).toBe(true)
    expect(['canvas2d', 'webgl2']).toContain(terminal.diagnostics.rendererBackend)
    expect(typeof terminal.diagnostics.desynchronized).toBe('boolean')
  },
)

it('waits for the frame by default', async () => {
  const terminal = await openTerminal({})
  const rows: (readonly number[])[] = []
  terminal.onFrame(({ rows: changed }) => rows.push(changed))

  terminal.write('batched')
  expect(rows).toHaveLength(0)
  expect(terminal.hasPendingFrame).toBe(true)
  expect(terminal.diagnostics.desynchronized).toBe(false)
})
