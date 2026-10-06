/// <reference types="vite/client" />
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { Ghostty, Terminal } from 'ghostty-web'
import counterpartWasm from 'ghostty-web/ghostty-vt.wasm?url'
import { legacyText } from './comparison-legacy-text.js'
import { spotCheck } from './comparison-fixtures.js'

let terminal: Terminal | undefined
let host: HTMLElement | undefined

afterEach(() => {
  terminal?.dispose()
  host?.remove()
  vi.restoreAllMocks()
})

it('observes the clusters drawn by pinned ghostty-web after the ASCII control', async () => {
  const ghostty = await Ghostty.load(counterpartWasm)
  host = document.createElement('section')
  document.body.append(host)
  terminal = new Terminal({ ghostty, cols: 40, rows: 8, cursorBlink: false })
  terminal.open(host)
  const drawing = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText')
  terminal.write('\x1b[?25l' + spotCheck)
  await expect.poll(() => legacyText(terminal!)[0]).toBe('ASCII abc 123')
  for (const cluster of ['é', '👩‍💻', '👨‍👩‍👧‍👦'])
    await expect.poll(() => drawing.mock.calls.map(([text]) => text)).toContain(cluster)
  expect(terminal.buffer.active.getLine(2)?.translateToString(true)).not.toContain('é')
  expect(terminal.buffer.active.getLine(3)?.translateToString(true)).not.toContain('👩‍💻')
  expect(legacyText(terminal)[2]).toBe('wide 日本語 é')
  expect(legacyText(terminal)[3]).toBe('ZWJ 👩‍💻 👨‍👩‍👧‍👦')
  expect(legacyText(terminal)[6]).toBe('overwrite new')
  await page.screenshot({ element: host, path: '../.artifacts/bench-legacy-graphemes.png' })
})

it('reads the active rendered rows after history grows', async () => {
  const ghostty = await Ghostty.load(counterpartWasm)
  host = document.createElement('section')
  document.body.append(host)
  terminal = new Terminal({ ghostty, cols: 40, rows: 8, cursorBlink: false })
  terminal.open(host)
  const drawing = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText')
  terminal.write('\x1b[?25l' + 'history\r\n'.repeat(12) + 'é👩‍💻')
  await expect.poll(() => terminal!.getScrollbackLength()).toBeGreaterThan(0)
  for (const cluster of ['é', '👩‍💻'])
    await expect.poll(() => drawing.mock.calls.map(([text]) => text)).toContain(cluster)
  expect(legacyText(terminal)[7]).toBe('é👩‍💻')
})
