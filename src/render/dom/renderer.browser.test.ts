import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { Terminal } from '../../dom/terminal.js'
import { CanvasTerminalRenderer } from '../canvas/renderer.js'
import { snapshotRenderState } from '../frame.js'
import { WebGpuUnavailableError } from '../renderer.js'
import { createCompatibleTerminalRenderer } from '../selector.js'
import type { RenderSchedulerClock } from '../scheduler.js'
import { DomTerminalRenderer, renderFrameToHtml } from './renderer.js'
import { probeFont, probeInput } from './tests/probe.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

class ProbeClock implements RenderSchedulerClock {
  private next = 0
  private frames = new Map<number, () => void>()
  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }
  clearTimer(): void {}
  requestFrame(callback: () => void): number {
    this.frames.set(++this.next, callback)
    return this.next
  }
  setTimer(): number {
    return ++this.next
  }
  flush(): void {
    const frames = [...this.frames.values()]
    this.frames.clear()
    for (const frame of frames) frame()
  }
}

function mountedCanvas(): HTMLCanvasElement {
  const host = document.createElement('div')
  host.style.position = 'relative'
  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  canvas.style.padding = '7px'
  host.append(canvas)
  document.body.append(host)
  cleanups.push(() => host.remove())
  return canvas
}

async function rendererProbe(backend: 'dom' | 'canvas2d') {
  const runtime = await GhosttyRuntime.create()
  cleanups.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
  const state = runtime.createRenderState(terminal)
  terminal.write(probeInput)
  const canvas = mountedCanvas()
  const clock = new ProbeClock()
  const frames: (readonly number[])[] = []
  const options = {
    canvas,
    columns: 12,
    rows: 3,
    font: probeFont,
    renderState: state,
    schedulerClock: clock,
    onRowsPainted: (rows: readonly { y: number }[]) => frames.push(rows.map((row) => row.y)),
  }
  const renderer =
    backend === 'dom'
      ? await DomTerminalRenderer.create(options)
      : await CanvasTerminalRenderer.create(options)
  cleanups.push(() => renderer.dispose())
  clock.flush()
  return { runtime, terminal, state, canvas, renderer, clock, frames }
}

describe('DOM terminal renderer', () => {
  it('matches Node-safe serialized markup and Canvas2D SGR and cursor colors on the same real core input', async () => {
    const dom = await rendererProbe('dom')
    const canvas = await rendererProbe('canvas2d')
    const frame = dom.canvas.parentElement!.querySelector('.ghostty-webgpu-frame')!
    const html = renderFrameToHtml(snapshotRenderState(dom.state), {
      columns: 12,
      rows: 3,
      font: probeFont,
    })
    expect(frame.parentElement!.innerHTML).toBe(html)
    expect(frame.textContent).toContain('AB界é<&"')
    const colored = frame.querySelector('span')!
    expect(getComputedStyle(colored).color).toBe('rgb(10, 20, 30)')
    expect(getComputedStyle(colored).backgroundColor).toBe('rgb(40, 50, 60)')
    const context = canvas.canvas.getContext('2d')!
    expect([...context.getImageData(1, 1, 1, 1).data].slice(0, 3)).toEqual([40, 50, 60])
    const cursor = frame.querySelector('[data-cursor="block"]')!
    expect(getComputedStyle(cursor).backgroundColor).toBe('rgb(238, 238, 238)')
    expect([...context.getImageData(11, 1, 1, 1).data].slice(0, 3)).toEqual([238, 238, 238])
    expect(cursor.getBoundingClientRect().left - frame.getBoundingClientRect().left).toBe(10)
    await page.screenshot({
      element: frame,
      path: '../../../.artifacts/p285-dom-real-core-frame.png',
      scale: 'css',
    })
    expect(frame.getBoundingClientRect().left - dom.canvas.getBoundingClientRect().left).toBe(7)
  })

  it('keeps wide-glyph cursor paint confined to the leading cell like Canvas2D', async () => {
    const dom = await rendererProbe('dom')
    const canvas = await rendererProbe('canvas2d')
    const frame = dom.canvas.parentElement!.querySelector('.ghostty-webgpu-frame')!
    for (const style of ['block', 'bar', 'underline', 'outline'] as const) {
      for (const probe of [dom, canvas]) {
        probe.terminal.setDefaultCursorStyle(style)
        probe.terminal.write('\x1b[1;3H')
        probe.renderer.notifyWrite()
        probe.clock.flush()
      }
      const screenshot = await page.screenshot({ element: frame, save: false, scale: 'css' })
      const image = new Image()
      image.src = `data:image/png;base64,${screenshot}`
      await image.decode()
      const decoded = document.createElement('canvas')
      decoded.width = image.naturalWidth
      decoded.height = image.naturalHeight
      const pixels = decoded.getContext('2d')!
      pixels.drawImage(image, 0, 0)
      const reference = canvas.canvas.getContext('2d')!
      for (const [x, y] of [
        [20, 0],
        [21, 1],
        [21, 19],
        [31, 1],
        [31, 19],
      ]) {
        const expected = reference.getImageData(x!, y!, 1, 1).data
        const background = expected[3] === 0 ? [17, 17, 17] : [...expected].slice(0, 3)
        expect([...pixels.getImageData(x!, y!, 1, 1).data].slice(0, 3)).toEqual(background)
      }
    }
  })

  it('retains undamaged rows, repaints selection, and tears down the owned surface', async () => {
    const probe = await rendererProbe('dom')
    const host = probe.canvas.parentElement!
    const previous = host.querySelector('[data-row="0"]')
    probe.terminal.write('\x1b[2;1Hchanged')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    // Moving the cursor rebuilds its previous and next rows; the untouched third row stays mounted.
    const third = host.querySelector('[data-row="2"]')
    probe.terminal.write('!')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    expect(host.querySelector('[data-row="2"]')).toBe(third)
    expect(host.querySelector('[data-row="0"]')).not.toBe(previous)
    probe.terminal.selectAll()
    probe.renderer.notifySelectionChange()
    probe.clock.flush()
    expect(getComputedStyle(host.querySelector('span')!).backgroundColor).toBe('rgb(51, 68, 85)')
    probe.renderer.dispose()
    expect(host.querySelector('.ghostty-webgpu-frame')).toBeNull()
    expect(probe.canvas.style.opacity).toBe('')
  })

  it('continues through DOM when a lost WebGL context cannot acquire Canvas2D', async () => {
    const runtime = await GhosttyRuntime.create()
    cleanups.push(() => runtime.dispose())
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('before')
    const canvas = mountedCanvas()
    const host = canvas.parentElement!
    const clock = new ProbeClock()
    const renderer = await createCompatibleTerminalRenderer({
      canvas,
      columns: 12,
      rows: 3,
      font: probeFont,
      renderState: state,
      schedulerClock: clock,
      deviceFactory: () =>
        Promise.reject(new WebGpuUnavailableError('api', 'WebGPU unavailable in the probe')),
      replaceCanvas: () => {
        const replacement = document.createElement('canvas')
        replacement.style.cssText = canvas.style.cssText
        vi.spyOn(replacement, 'getContext').mockReturnValue(null)
        canvas.replaceWith(replacement)
        return replacement
      },
    })
    cleanups.push(() => renderer.dispose())
    clock.flush()
    expect(renderer.backend).toBe('webgl2')
    const extension = canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context')!
    const lost = new Promise<void>((resolve) =>
      canvas.addEventListener('webglcontextlost', () => resolve(), { once: true }),
    )
    terminal.write('\r\nafter')
    renderer.notifyWrite()
    extension.loseContext()
    await lost
    await vi.waitFor(() => expect(renderer.backend).toBe('dom'))
    clock.flush()
    expect(host.querySelector('.ghostty-webgpu-frame')?.textContent).toContain('after')
  })

  it('preserves logical RTL cell coordinates in live, serialized, and compacted frames', async () => {
    const probe = await rendererProbe('dom')
    probe.canvas.parentElement!.style.direction = 'rtl'
    probe.terminal.write('\x1b[?25l\x1b[2J\x1b[HאבגABC')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    const live = probe.canvas.parentElement!.querySelector('.ghostty-webgpu-frame')!
    await page.screenshot({
      element: live,
      path: '../../../.artifacts/p285-dom-rtl-frame.png',
      scale: 'css',
    })
    const serialized = document.createElement('div')
    serialized.style.direction = 'rtl'
    serialized.innerHTML = renderFrameToHtml(snapshotRenderState(probe.state), {
      columns: 12,
      rows: 3,
      font: probeFont,
    })
    document.body.append(serialized)
    cleanups.push(() => serialized.remove())
    const saved = serialized.firstElementChild!
    const compact = saved.cloneNode(false) as HTMLElement
    compact.textContent = 'אבגABC'
    serialized.append(compact)
    for (const frame of [live, saved, compact]) {
      const text = frame.querySelector('span')?.firstChild ?? frame.firstChild!
      const lefts = Array.from({ length: 6 }, (_, index) => {
        const range = document.createRange()
        range.setStart(text, index)
        range.setEnd(text, index + 1)
        return range.getBoundingClientRect().left
      })
      for (let index = 1; index < lefts.length; index += 1)
        expect(lefts[index]!).toBeGreaterThan(lefts[index - 1]!)
    }
  })

  it('keeps real focus, drag selection, wheel, and mouse reporting under forced DOM fallback', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const host = document.createElement('div')
    host.style.width = '300px'
    host.style.height = '100px'
    document.body.append(host)
    cleanups.push(() => host.remove())
    const terminal = await Terminal.create({
      appearance: {
        grid: { columns: 12, rows: 3 },
        font: { family: 'monospace', size: 16 },
        cursor: { blink: false },
      },
    })
    cleanups.push(() => terminal.dispose())
    await terminal.open(host)
    terminal.write('first\r\nsecond\r\nthird\r\nfourth\r\nfifth')
    await vi.waitFor(() => expect(terminal.visibleLines().join('')).toContain('fifth'))
    const firstVisible = terminal.visibleLines()[0]!.trim()
    const canvas = host.querySelector('canvas')!
    const box = canvas.getBoundingClientRect()
    expect(document.elementFromPoint(box.left + 2, box.top + 2)).toBe(canvas)
    const locator = page.elementLocator(canvas)
    await locator.click({ position: { x: 2, y: 2 } })
    expect(document.activeElement).toBe(terminal.textarea)
    await locator.dropTo(locator, {
      sourcePosition: { x: 2, y: 2 },
      targetPosition: { x: box.width - 2, y: 2 },
    })
    expect(terminal.getSelection()).toContain(firstVisible)
    await locator.wheel({ delta: { y: -100 } })
    await vi.waitFor(() => expect(terminal.visibleLines().join('')).toContain('first'))
    const data: string[] = []
    terminal.onData((value) => data.push(new TextDecoder().decode(value)))
    terminal.write('\x1b[?1000h\x1b[?1006h')
    await locator.click({ position: { x: 2, y: 2 } })
    expect(data.join('')).toContain('\x1b[<0;1;1M')
  })

  it('opens the public Terminal with every canvas context disabled and publishes damaged rows', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const host = document.createElement('div')
    host.style.width = '300px'
    host.style.height = '100px'
    document.body.append(host)
    cleanups.push(() => host.remove())
    const terminal = await Terminal.create({
      appearance: {
        grid: { columns: 12, rows: 3 },
        font: { family: 'monospace', size: 16 },
        cursor: { blink: false },
      },
    })
    cleanups.push(() => terminal.dispose())
    const frames: (readonly number[])[] = []
    const subscription = terminal.onFrame((frame) => frames.push(frame.rows))
    await terminal.open(host)
    terminal.write('DOM fallback')
    await vi.waitFor(() =>
      expect(host.querySelector('.ghostty-webgpu-frame')?.textContent).toContain('DOM fallback'),
    )
    expect(terminal.diagnostics.rendererBackend).toBe('dom')
    expect(frames.length).toBeGreaterThan(0)
    expect(frames[0]).toEqual(Array.from({ length: frames[0]!.length }, (_, y) => y))
    subscription.dispose()
    const count = frames.length
    terminal.write('!')
    await vi.waitFor(() =>
      expect(host.querySelector('.ghostty-webgpu-frame')?.textContent).toContain('!'),
    )
    expect(frames).toHaveLength(count)
  })
})
