import { testFontUrl } from '../../tests/fonts.js'
import { afterEach, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { createGhosttyWebGpuTerminalFromSession } from '../../dom/terminal.js'
import { TerminalSession } from '../../term/session.js'
import { DomTerminalRenderer } from './renderer.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
  cleanups.length = 0
})
async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}
it('retains cursor appearance rows while publishing frames and observing current geometry', async () => {
  const family = 'DOMAppearanceRetention'
  const url = testFontUrl
  const face = await new FontFace(family, `url(${JSON.stringify(url)})`).load()
  document.fonts.add(face)
  cleanups.push(() => document.fonts.delete(face))
  const runtime = await GhosttyRuntime.create()
  cleanups.push(() => runtime.dispose())
  const session = await TerminalSession.create<Event>({
    runtime: { kind: 'borrowed', runtime },
    appearance: {
      grid: { columns: 40, rows: 12 },
      font: { family, size: 12 },
      cursor: { blink: false },
    },
  })
  const host = document.createElement('div')
  host.style.cssText = 'position:relative;width:480px;height:240px'
  document.body.append(host)
  cleanups.push(() => host.remove())
  let mounted: DomTerminalRenderer | undefined
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: false,
    accessibility: false,
    rendererFactory: async (options) => {
      mounted = await DomTerminalRenderer.create(options)
      return mounted
    },
  })
  cleanups.push(() => terminal.dispose())
  await terminal.open(host)
  terminal.write('\x1b[?25lretained rows\r\nsecond row')
  await settle()
  const renderer = mounted!
  let frames = 0
  let appearances = 0
  terminal.onFrame(() => (frames += 1))
  terminal.on('appearance', () => (appearances += 1))
  const before = renderer.metrics.paintedRows
  terminal.setCursor({ style: 'bar' })
  await settle()
  expect(renderer.metrics.paintedRows - before).toBe(1)
  expect(frames).toBe(1)
  expect(appearances).toBe(1)
  expect(terminal.submittedFrame?.cursor).toMatchObject({ style: 'bar', visible: false })
  expect(terminal.visibleLines()[0]).toContain('retained rows')
  terminal.write('\x1b[?25h\x1b[1;1H')
  await settle()
  const visible = renderer.metrics.paintedRows
  terminal.setCursor({ style: 'underline' })
  await settle()
  expect(renderer.metrics.paintedRows - visible).toBe(1)
  expect(terminal.submittedFrame?.cursor).toMatchObject({ style: 'underline', visible: true })
  expect(host.querySelector('[data-cursor=underline]')).not.toBeNull()
  terminal.write('\x1b[2 q')
  await settle()
  const canvas = terminal.canvas!
  canvas.style.marginLeft = '30px'
  canvas.style.paddingLeft = '11px'
  canvas.parentElement!.style.paddingLeft = '10px'
  const geometry = renderer.metrics.paintedRows
  const priorFrames = frames
  terminal.setCursor({ style: 'bar' })
  await settle()
  expect(renderer.metrics.paintedRows - geometry).toBe(1)
  expect(frames).toBe(priorFrames + 1)
  expect(terminal.submittedFrame?.cursor).toMatchObject({ style: 'block', visible: true })
  expect(getComputedStyle(canvas.nextElementSibling!).left).toBe(
    `${canvas.offsetLeft + parseFloat(getComputedStyle(canvas).paddingLeft)}px`,
  )
  terminal.write('\x1b[?25l\x1b[2J\x1b[H\x1b[31mpalette sample\x1b[0m')
  await settle()
  const originalPalette = getComputedStyle(host.querySelector('span')!).color
  terminal.write('\x1b]4;1;rgb:12/34/56\x07')
  await settle()
  expect(getComputedStyle(host.querySelector('span')!).color).toBe('rgb(18, 52, 86)')
  terminal.write('\x1b]104;1\x07')
  await settle()
  expect(getComputedStyle(host.querySelector('span')!).color).toBe(originalPalette)
  const snapshot = terminal.frameSnapshot()!
  const retained = JSON.stringify(snapshot.rows.map((row) => row.renderCells))
  runtime.exports.memory.grow(1)
  let reentered = false
  const subscription = terminal.onFrame(() => {
    if (reentered) return
    reentered = true
    terminal.setTheme({ ...terminal.appearance.theme, background: { r: 33, g: 44, b: 55 } })
  })
  const reentrantFrames = frames
  terminal.setCursor({ style: 'underline' })
  await settle()
  subscription.dispose()
  expect(frames).toBe(reentrantFrames + 2)
  expect(getComputedStyle(host.querySelector('.ghostty-webgpu-frame')!).backgroundColor).toBe(
    'rgb(33, 44, 55)',
  )
  expect(JSON.stringify(snapshot.rows.map((row) => row.renderCells))).toBe(retained)
})
