import { afterEach, expect, it } from 'vitest'
import { TerminalSession } from '../../term/session.js'
import { Terminal, createGhosttyWebGpuTerminalFromSession } from '../terminal.js'
import type { GhosttyWebGpuTerminalOptions } from '../types.js'

const active: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of active.splice(0)) await cleanup()
})

function host(): HTMLDivElement {
  const element = document.createElement('div')
  element.style.cssText = 'width:480px;height:180px;position:relative'
  document.body.append(element)
  active.push(() => element.remove())
  return element
}

async function create(options: GhosttyWebGpuTerminalOptions = {}): Promise<Terminal> {
  const terminal = await Terminal.create({
    ...options,
    appearance: {
      ...options.appearance,
      cursor: { blink: false },
      grid: { columns: 30, rows: 5 },
    },
    rendererMode: 'canvas2d-fill-text',
  })
  active.push(() => terminal.dispose())
  await terminal.open(host())
  return terminal
}

async function eventually(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Terminal operation did not settle')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('flushes older batched writes before a synchronous write and preserves read-after-write', async () => {
  const terminal = await create()
  const queued = terminal.writeBatched('before')
  terminal.write('\r\nafter')
  await queued

  const lines = await terminal.readLines(0, 2)
  expect(lines[0]?.text).toContain('before')
  expect(lines[1]?.text).toContain('after')
  expect(terminal.pendingWriteBytes).toBe(0)

  terminal.write(' synchronous')
  expect((await terminal.readLines(1, 2))[0]?.text).toContain('after synchronous')
})

it('parses queued output before a subsequent fitted resize', async () => {
  const session = await TerminalSession.create<Event>({
    appearance: { cursor: { blink: false }, grid: { columns: 30, rows: 5 } },
  })
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    rendererMode: 'canvas2d-fill-text',
  })
  active.push(() => terminal.dispose())
  const root = host()
  await terminal.open(root)
  const operations: string[] = []
  session.on('renderRequest', () => operations.push('write'))
  session.on('resize', () => operations.push('resize'))

  const queued = terminal.writeBatched('before resize')
  root.style.width = '240px'
  await queued
  await eventually(() => operations.includes('resize'))
  expect(operations.indexOf('write')).toBeLessThan(operations.indexOf('resize'))
})

it('cancels queued output without parsing it', async () => {
  const terminal = await create()
  const controller = new AbortController()
  const first = terminal.writeBatched('first\r\n')
  const cancelled = terminal.writeBatched('cancelled\r\n', { signal: controller.signal })
  const last = terminal.writeBatched('last')
  const rejection = cancelled.catch((cause: unknown) => cause)

  controller.abort()
  await first
  await last
  expect(await rejection).toMatchObject({ name: 'AbortError' })
  const text = (await terminal.readLines(0, 3)).map((line) => line.text).join('\n')
  expect(text).toContain('first')
  expect(text).toContain('last')
  expect(text).not.toContain('cancelled')
})

it('serializes a data-callback write behind older batched output', async () => {
  const terminal = await create()
  let nested = false
  terminal.onData(() => {
    if (nested) return
    nested = true
    terminal.write('C')
  })

  const first = terminal.writeBatched('\x1b[c')
  const second = terminal.writeBatched('B')
  await first
  await second
  expect(nested).toBe(true)
  expect((await terminal.readLines(0, 1))[0]?.text.trimEnd()).toBe('BC')
})

it('rejects every unparsed batched write on disposal', async () => {
  const terminal = await create()
  const writes = Array.from({ length: 8 }, () => terminal.writeBatched('queued output'))
  const rejections = writes.map((write) => write.catch((cause: unknown) => cause))

  terminal.dispose()
  for (const rejection of rejections)
    expect(await rejection).toMatchObject({ operation: 'writeQueue.dispose' })
  expect(terminal.pendingWriteBytes).toBe(0)
})
