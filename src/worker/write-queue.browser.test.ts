import { afterEach, expect, it, vi } from 'vitest'
import { testFontUrl } from '../tests/fonts.js'
import { Terminal } from '../../dist/worker/index.js'

const family = 'WriteQueueWorkerTest'
const active: Terminal[] = []
const containers: HTMLElement[] = []

afterEach(async () => {
  for (const terminal of active.splice(0)) await terminal.dispose()
  for (const container of containers.splice(0)) container.remove()
})

async function create(): Promise<Terminal> {
  const terminal = await Terminal.create({
    appearance: { cursor: { blink: false }, font: { family, size: 16 } },
    backend: 'webgl',
    fonts: [{ family, source: { url: testFontUrl } }],
    writeQueue: { maxBytes: 1024 * 1024, timeBudgetMs: 12 },
  })
  active.push(terminal)
  const root = document.createElement('div')
  root.style.cssText = 'width:480px;height:180px;position:relative'
  document.body.append(root)
  containers.push(root)
  await terminal.open(root)
  return terminal
}

it('transfers owned batched buffers and acknowledges native parsing', async () => {
  const terminal = await create()
  const postMessage = vi.spyOn(MessagePort.prototype, 'postMessage')
  try {
    const bytes = new TextEncoder().encode('transferred batched output')
    const result = terminal.writeBatched(bytes)

    await result
    expect(new TextDecoder().decode(bytes)).toBe('transferred batched output')
    expect(
      postMessage.mock.calls.some(
        ([message, transfer]) =>
          message?.command === 'write' && Array.isArray(transfer) && transfer.length === 1,
      ),
    ).toBe(true)
    expect(terminal.pendingWriteBytes).toBe(0)
    expect((await terminal.readLines(0, 1))[0]?.text).toContain('transferred batched output')
  } finally {
    postMessage.mockRestore()
  }
})

it('keeps batched output ahead of later write and appearance controls', async () => {
  const terminal = await create()
  const first = terminal.writeBatched('first')
  const second = terminal.writeBatched(' second')
  const control = terminal.write('\r\nafter')
  const appearance = terminal.setFont({ size: 18 })
  await first
  await second
  await control
  await appearance

  const lines = await terminal.readLines(0, 2)
  expect(lines[0]?.text).toContain('first second')
  expect(lines[1]?.text).toContain('after')
  expect(terminal.appearance.font.size).toBe(18)
})

it('cancels a queued worker write without cancelling its neighbors', async () => {
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

it('rejects queued worker writes before disposal finishes', async () => {
  const terminal = await create()
  const writes = Array.from({ length: 8 }, () => terminal.writeBatched('queued worker output'))
  const rejections = writes.map((write) => write.catch((cause: unknown) => cause))

  const disposal = terminal.dispose()
  for (const rejection of rejections)
    expect(await rejection).toMatchObject({ operation: 'writeQueue.dispose' })
  await disposal
  expect(terminal.pendingWriteBytes).toBe(0)
})
