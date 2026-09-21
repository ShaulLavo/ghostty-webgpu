import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { CanvasTerminalRenderer } from '../../render/canvas/renderer.js'
import { Terminal } from '../terminal.js'
import { paintTerminalViewport, TERMINAL_VIEWPORT_MAX_BYTES } from '../viewport.js'

let runtime: GhosttyRuntime
const cleanups: (() => void)[] = []
beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
afterAll(() => runtime.dispose())

function host(padding = 0) {
  const element = document.createElement('div')
  element.style.width = '480px'
  element.style.boxSizing = 'border-box'
  element.style.padding = `${padding}px`
  element.style.height = '160px'
  document.body.append(element)
  cleanups.push(() => element.remove())
  return element
}

async function fixture(padding = 0) {
  const terminal = await Terminal.create({
    runtime: { kind: 'borrowed', runtime },
    appearance: { font: { family: 'monospace', size: 16 }, cursor: { blink: false } },
    rendererFactory: (options) => CanvasTerminalRenderer.create(options),
  })
  cleanups.push(() => terminal.dispose())
  const element = host(padding)
  await terminal.open(element)
  await expect.poll(() => terminal.captureViewport()).toBeDefined()
  return { terminal, element }
}

async function write(terminal: Terminal, text: string) {
  terminal.write(text)
  await expect.poll(() => terminal.captureViewport()).toBeDefined()
}

function requiredSnapshot(terminal: Terminal) {
  const snapshot = terminal.captureViewport()
  expect(snapshot).toBeDefined()
  if (!snapshot) throw new Error('Missing committed viewport')
  return snapshot
}

function pixels(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Missing native canvas')
  return context.getImageData(0, 0, canvas.width, canvas.height).data
}

describe('saved terminal viewport', () => {
  it('repaints native colors, attributes, wide cells and cursor without a terminal', async () => {
    const { terminal } = await fixture()
    await write(terminal, '\u001b[1;31mred\u001b[0m 界\r\n\u001b[44;4;9munderlined\u001b[0m')
    const snapshot = requiredSnapshot(terminal)
    const source = terminal.canvas
    if (!source) throw new Error('Missing native canvas')
    const expected = pixels(source)
    terminal.dispose()
    const previewHost = host()
    const preview = paintTerminalViewport(previewHost, snapshot, {
      font: { family: 'monospace', size: 16 },
    })
    expect(preview?.lines[0]).toContain('red 界')
    expect(previewHost.querySelector('textarea')).toBeNull()
    const canvas = previewHost.querySelector('canvas')
    if (!canvas) throw new Error('Missing preview canvas')
    expect(pixels(canvas)).toEqual(expected)
    preview?.dispose()
    preview?.dispose()
    expect(previewHost.children).toHaveLength(0)
  })

  it('preserves content geometry inside a padded host', async () => {
    const { terminal, element } = await fixture(8)
    await write(terminal, 'padded viewport')
    const source = terminal.canvas
    if (!source) throw new Error('Missing native canvas')
    const expected = pixels(source)
    const offset = source.getBoundingClientRect().left - element.getBoundingClientRect().left
    const previewHost = host(8)
    const preview = paintTerminalViewport(previewHost, requiredSnapshot(terminal))
    expect(preview).toBeDefined()
    const canvas = previewHost.querySelector('canvas')
    if (!canvas) throw new Error('Missing preview canvas')
    expect(canvas.getBoundingClientRect().left - previewHost.getBoundingClientRect().left).toBe(
      offset,
    )
    expect(pixels(canvas)).toEqual(expected)
  })

  it('captures only submitted revisions and reports the frame after writes', async () => {
    const { terminal } = await fixture()
    const captures: (string | undefined)[] = []
    terminal.on('frame', () => captures.push(terminal.captureViewport()))
    terminal.write('next frame')
    expect(terminal.captureViewport()).toBeUndefined()
    await expect.poll(() => captures.length).toBeGreaterThan(0)
    const snapshot = captures.at(-1)
    expect(snapshot).toBeDefined()
    if (!snapshot) throw new Error('Missing captured frame')
    expect(paintTerminalViewport(host(), snapshot)?.lines[0]).toContain('next frame')
  })

  it('preserves the scrolled viewport and its position for live handoff', async () => {
    const { terminal } = await fixture()
    await write(terminal, Array.from({ length: 30 }, (_, i) => `row ${i}\r\n`).join(''))
    terminal.scrollToTop()
    await expect.poll(() => terminal.captureViewport()).toBeDefined()
    const preview = paintTerminalViewport(host(), requiredSnapshot(terminal))
    expect(preview?.lines[0]).toContain('row 0')
    expect(preview?.scrollbar.offset).toBe(0)
    expect(preview!.scrollbar.total).toBeGreaterThan(preview!.scrollbar.length)
  })

  it('rejects stale geometry, DPR, appearance, malformed and oversized data', async () => {
    const { terminal } = await fixture()
    await write(terminal, 'saved')
    const snapshot = requiredSnapshot(terminal)
    const target = host()
    expect(paintTerminalViewport(target, snapshot, { font: { size: 17 } })).toBeUndefined()
    expect(
      paintTerminalViewport(target, snapshot, { theme: { foreground: { r: 1, g: 2, b: 3 } } }),
    ).toBeUndefined()
    target.style.width = '470px'
    expect(paintTerminalViewport(target, snapshot)).toBeUndefined()
    target.style.width = '480px'
    expect(paintTerminalViewport(target, '{')).toBeUndefined()
    expect(paintTerminalViewport(target, ' '.repeat(TERMINAL_VIEWPORT_MAX_BYTES))).toBeUndefined()
    const changed = JSON.parse(snapshot)
    changed.font.pixelRatio += 1
    expect(paintTerminalViewport(target, JSON.stringify(changed))).toBeUndefined()
    changed.cursor.passwordInput = true
    expect(paintTerminalViewport(target, JSON.stringify(changed))).toBeUndefined()
    expect(target.children).toHaveLength(0)
  })
})
