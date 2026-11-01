import { afterEach, expect, it } from 'vitest'
import { Terminal } from '../../index.js'
import { readline } from '../../../packages/line-editor/dist/index.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function settled(terminal: Terminal, before: number): Promise<void> {
  await expect.poll(() => terminal.geometry().revision).toBeGreaterThan(before)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await expect
    .poll(() => terminal.submittedFrame?.nativeRevision)
    .toBe(terminal.geometry().revision)
  await expect.poll(() => terminal.hasPendingFrame).toBe(false)
  const geometry = terminal.geometry()
  expect(terminal.submittedFrame?.grid).toMatchObject({
    columns: geometry.columns,
    rows: geometry.rows,
  })
  expect(terminal.submittedFrame?.cursor.viewport).toMatchObject({
    x: geometry.cursor.x,
    y: geometry.cursor.y,
  })
}

async function fixture(columns: number) {
  const host = document.createElement('div')
  host.style.cssText = 'width:320px;height:160px'
  document.body.append(host)
  cleanups.push(() => host.remove())
  const options: Parameters<typeof Terminal.create>[0] & { readonly autoFit: false } = {
    rendererMode: 'canvas2d-fill-text',
    autoFit: false,
    appearance: { grid: { columns, rows: 6 }, cursor: { blink: false } },
  }
  const terminal = await Terminal.create(options)
  cleanups.push(() => terminal.dispose())
  const errors: unknown[] = []
  terminal.on('error', (cause) => errors.push(cause))
  await terminal.open(host)
  terminal.write('\x1b[?7h\x1b[20lKEEP\r\n')
  const handle = terminal.use(readline({ onError: (cause) => errors.push(cause) }))
  cleanups.push(() => handle.dispose())
  const before = terminal.geometry().revision
  const pending = handle.api.read({ prompt: '$ ', secondaryPrompt: '> ' })
  void pending.catch(() => {})
  await settled(terminal, before)
  expect(terminal.geometry().cursor).toMatchObject({ x: 2, y: 1, pendingWrap: false })
  async function paste(text: string): Promise<void> {
    const revision = terminal.geometry().revision
    terminal.paste(text)
    await settled(terminal, revision)
    expect(errors).toEqual([])
  }
  return { terminal, handle, pending, paste, errors }
}

function expectRows(terminal: Terminal, expected: readonly string[]) {
  expect(terminal.readLines(0, expected.length).map((line) => line.text)).toEqual(expected)
  expect(
    terminal
      .visibleLines()
      .slice(0, expected.length)
      .map((line) => line.trimEnd()),
  ).toEqual(expected)
}

it('renders and submits logical LF and prints above an active multiline edit through the built addon', async () => {
  const { terminal, handle, pending, paste, errors } = await fixture(12)
  await paste('ab\ncd')
  expectRows(terminal, ['KEEP', '$ ab', '> cd'])
  expect(terminal.geometry().cursor).toMatchObject({ x: 4, y: 2, pendingWrap: false })

  const beforePrint = terminal.geometry().revision
  handle.api.print('output')
  await settled(terminal, beforePrint)
  expectRows(terminal, ['KEEP', 'output', '$ ab', '> cd'])
  expect(terminal.geometry().cursor).toMatchObject({ x: 4, y: 3, pendingWrap: false })

  const beforeSubmit = terminal.geometry().revision
  terminal.key({ action: 'press', code: 'Enter', text: '\r', composing: false })
  await expect(pending).resolves.toEqual({ kind: 'submit', text: 'ab\ncd' })
  await settled(terminal, beforeSubmit)
  expectRows(terminal, ['KEEP', 'output', '$ ab', '> cd', ''])
  expect(terminal.geometry().cursor).toMatchObject({ x: 0, y: 4, pendingWrap: false })
  expect(handle.api.active).toBe(false)
  expect(errors).toEqual([])
})

it('preserves earlier output and pending wrap across exact-width edits through the built addon', async () => {
  const { terminal, paste } = await fixture(6)
  await paste('abcd')
  expectRows(terminal, ['KEEP', '$ abcd'])
  expect.soft(terminal.geometry().cursor).toMatchObject({ x: 5, y: 1, pendingWrap: true })

  await paste('e')
  expectRows(terminal, ['KEEP', '$ abcd', 'e'])
  expect(terminal.geometry().cursor).toMatchObject({ x: 1, y: 2, pendingWrap: false })
})
