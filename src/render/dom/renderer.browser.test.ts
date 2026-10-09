import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RenderStateDirty } from '../../core/abi.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { RenderRow } from '../../core/types.js'
import type { CursorState } from '../instances/types.js'
import type { RendererFrameSnapshot } from '../renderer.js'
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

async function rendererProbe(
  backend: 'dom' | 'canvas2d',
  input = probeInput,
  font = probeFont,
  onFrame?: (snapshot: RendererFrameSnapshot) => void,
  onRowsPainted?: (rows: readonly RenderRow[]) => void,
) {
  const runtime = await GhosttyRuntime.create()
  cleanups.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
  const state = runtime.createRenderState(terminal)
  terminal.write(input)
  const canvas = mountedCanvas()
  const clock = new ProbeClock()
  const frames: (readonly number[])[] = []
  const options = {
    canvas,
    columns: 12,
    rows: 3,
    font,
    renderState: state,
    schedulerClock: clock,
    onFrame,
    onRowsPainted: (rows: readonly RenderRow[]) => {
      frames.push(rows.map((row) => row.y))
      onRowsPainted?.(rows)
    },
  }
  const renderer =
    backend === 'dom'
      ? await DomTerminalRenderer.create(options)
      : await CanvasTerminalRenderer.create(options)
  cleanups.push(() => renderer.dispose())
  clock.flush()
  return { runtime, terminal, state, canvas, renderer, clock, frames }
}

async function expectWideGlyphCursorPaint(font = probeFont) {
  // Hidden ink isolates cursor/background paint from font-specific DOM and Canvas baselines.
  const input = probeInput.replace('界', '\x1b[8m界\x1b[28m')
  const dom = await rendererProbe('dom', input, font)
  const canvas = await rendererProbe('canvas2d', input, font)
  const frame = dom.canvas.parentElement!.querySelector('.ghostty-webgpu-frame')!
  for (const style of ['block', 'bar', 'underline', 'outline'] as const) {
    for (const probe of [dom, canvas]) {
      probe.terminal.setDefaultCursorStyle(style)
      probe.terminal.write('\x1b[1;3H')
      probe.renderer.notifyWrite()
      probe.clock.flush()
    }
    const cursor = frame.querySelector('[data-cursor]')!
    expect(cursor.textContent).toBe('界')
    expect(cursor.getBoundingClientRect().width).toBe(font.cssCellWidth * 2)
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
      const background: number[] =
        expected[3] === 0 ? [17, 17, 17] : Array.from(expected.subarray(0, 3))
      expect(
        [...pixels.getImageData(x!, y!, 1, 1).data].slice(0, 3),
        `${style} cursor pixel (${x}, ${y})`,
      ).toEqual(background)
    }
  }
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
    await expectWideGlyphCursorPaint()
  })

  it('confines wide-glyph cursor paint with Liberation Mono and WenQuanYi Zen Hei', async ({
    skip,
  }) => {
    const latin = new FontFace('GhosttyCursorLatin', 'local("Liberation Mono")')
    const wide = new FontFace('GhosttyCursorWide', 'local("WenQuanYi Zen Hei")')
    try {
      await Promise.all([latin.load(), wide.load()])
    } catch {
      skip('Liberation Mono and WenQuanYi Zen Hei are required for this font-layout regression')
    }
    document.fonts.add(latin)
    document.fonts.add(wide)
    cleanups.push(() => {
      document.fonts.delete(latin)
      document.fonts.delete(wide)
    })
    const font = {
      ...probeFont,
      settings: { ...probeFont.settings, family: 'GhosttyCursorLatin, GhosttyCursorWide' },
    }
    await expectWideGlyphCursorPaint(font)
  })

  it('matches serialized styles through run splits, removals, selection, theme, and font changes', async () => {
    const probe = await rendererProbe('dom')
    const theme = {
      background: { r: 20, g: 25, b: 30 },
      foreground: { r: 100, g: 105, b: 110 },
      minimumContrast: 4.5,
    }
    const font = { ...probeFont, settings: { ...probeFont.settings, boldWeight: 600 } }
    probe.renderer.setTheme(theme)
    probe.renderer.setFont(font)
    const expectSerializedFrame = () => {
      const expected = document.createElement('div')
      expected.innerHTML = renderFrameToHtml(snapshotRenderState(probe.state), {
        columns: 12,
        rows: 3,
        font,
        theme,
      })
      const live = probe.canvas.parentElement!.querySelector('.ghostty-webgpu-frame')!
      const saved = expected.firstElementChild!
      const runs = (frame: Element) =>
        Array.from(frame.querySelectorAll('span'), (span) => ({
          cursor: span.getAttribute('data-cursor'),
          style: span.getAttribute('style'),
          text: span.textContent,
        }))
      expect(live.getAttribute('style')).toBe(saved.getAttribute('style'))
      expect(runs(live)).toEqual(runs(saved))
    }
    for (const input of [
      '\x1b[?25l\x1b[2J\x1b[H\x1b[1;3;4;9;53mA\x1b[0m界é',
      '\r\x1b[2;7mB\x1b[8mC\x1b[0mD',
      '\r\x1b[4:3;38;2;90;100;110mE\x1b[0mF',
      '\x1b[2J\x1b[Hplain',
      '\x1b[?25h\x1b[1;2H',
    ]) {
      probe.terminal.write(input)
      probe.renderer.notifyWrite()
      probe.clock.flush()
      expectSerializedFrame()
      probe.terminal.selectAll()
      probe.renderer.notifySelectionChange()
      probe.clock.flush()
      expectSerializedFrame()
    }
  })

  it('reports actual mutations while identical repaints still settle damage and callbacks', async () => {
    const snapshots: RendererFrameSnapshot[] = []
    const probe = await rendererProbe('dom', probeInput, probeFont, (snapshot) =>
      snapshots.push(snapshot),
    )
    const initial = '\x1b[?25l\x1b[2J\x1b[Hfirst'
    probe.terminal.write(initial)
    probe.renderer.notifyWrite()
    probe.clock.flush()
    const surface = Reflect.get(probe.renderer, 'surface') as {
      paint(row: RenderRow, cursor: CursorState | undefined): boolean
    }
    const paint = vi.spyOn(surface, 'paint')
    const frame = probe.canvas.parentElement!.querySelector('.ghostty-webgpu-frame')!
    const observer = new MutationObserver(() => {})
    observer.observe(frame, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
    cleanups.push(() => observer.disconnect())
    const beforeFrames = probe.frames.length
    const beforeSnapshots = snapshots.length
    const beforeSubmitted = probe.renderer.metrics.submittedFrames
    probe.terminal.write(initial)
    probe.renderer.notifyWrite()
    probe.clock.flush()
    expect(paint).toHaveBeenCalled()
    expect(paint.mock.results.every((result) => result.value === false)).toBe(true)
    expect(observer.takeRecords()).toHaveLength(0)
    expect(probe.frames).toHaveLength(beforeFrames + 1)
    expect(snapshots).toHaveLength(beforeSnapshots + 1)
    expect(probe.renderer.metrics.submittedFrames).toBe(beforeSubmitted + 1)
    expect(probe.state.update()).toBe(RenderStateDirty.False)
    expect(surface.paint({ ...probe.state.readRows()[0]!, y: 99 }, undefined)).toBe(false)
    expect(observer.takeRecords()).toHaveLength(0)
    for (const input of [
      '\rsecond',
      '\r\x1b[31mS\x1b[0m',
      '\x1b[?25h\x1b[1;1H',
      '\x1b[?25l\x1b[2J\x1b[Hplain',
    ]) {
      paint.mockClear()
      probe.terminal.write(input)
      probe.renderer.notifyWrite()
      probe.clock.flush()
      const firstRow = paint.mock.calls.findIndex(([row]) => row.y === 0)
      expect(firstRow).toBeGreaterThanOrEqual(0)
      expect(paint.mock.results[firstRow]!.value).toBe(true)
      expect(observer.takeRecords().length).toBeGreaterThan(0)
    }
  })

  it('omits default empty tails while preserving full snapshots and visible cell paint', async () => {
    const snapshots: RendererFrameSnapshot[] = []
    const probe = await rendererProbe('dom', '\x1b[?25lshort', probeFont, (frame) =>
      snapshots.push(frame),
    )
    const row = probe.canvas.parentElement!.querySelector<HTMLElement>('[data-row="0"]')!
    const empty = probe.canvas.parentElement!.querySelector('[data-row="2"]')!
    expect(row.textContent).toBe('short')
    expect(empty.children).toHaveLength(0)
    expect(row.getBoundingClientRect().height).toBe(probeFont.cssCellHeight)
    expect(snapshots[0]!.rows[0]!.renderCells).toHaveLength(12)
    const span = row.firstElementChild!
    const style = span.getAttribute('style')
    expect(span.getBoundingClientRect().width).toBe(12 * probeFont.cssCellWidth)
    probe.terminal.write('\rshorter')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    expect(row.firstElementChild).toBe(span)
    expect(span.getAttribute('style')).toBe(style)
    expect(row.textContent).toBe('shorter')
    probe.terminal.write('\rshort\x1b[K')
    probe.renderer.notifyWrite()
    probe.clock.flush()

    probe.terminal.write('\x1b[?25h\x1b[1;12H')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    expect(row.textContent).toBe('short       ')
    const cursor = row.querySelector<HTMLElement>('[data-cursor]')!
    expect(cursor.getBoundingClientRect().left - row.getBoundingClientRect().left).toBe(
      11 * probeFont.cssCellWidth,
    )

    probe.terminal.write('\x1b[?25l\x1b[2J\x1b[H界')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    expect(row.textContent).toBe('界          ')
    expect(row.firstElementChild!.getBoundingClientRect().width).toBe(2 * probeFont.cssCellWidth)

    probe.terminal.write('\x1b[48;2;40;50;60m\x1b[K\x1b[0m')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    expect(row.textContent).toBe('界          ')
    expect(getComputedStyle(row.lastElementChild!).backgroundColor).toBe('rgb(40, 50, 60)')

    probe.terminal.write('\x1b[2J\x1b[Hshort\r\nnext')
    probe.terminal.selectAll()
    probe.renderer.notifySelectionChange()
    probe.clock.flush()
    expect(row.textContent).toBe('short       ')
    expect(getComputedStyle(row.lastElementChild!).backgroundColor).toBe('rgb(51, 68, 85)')
  })

  it('retains damaged row, span, and text identities while text changes', async () => {
    const probe = await rendererProbe('dom')
    probe.terminal.write('\x1b[?25l\x1b[2J\x1b[Hfirst')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    const host = probe.canvas.parentElement!
    const row = host.querySelector('[data-row="0"]')!
    const span = row.firstElementChild!
    const text = span.firstChild!
    probe.terminal.write('\rother')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    expect(host.querySelector('[data-row="0"]')).toBe(row)
    expect(row.firstElementChild).toBe(span)
    expect(span.firstChild).toBe(text)
    expect(text.textContent).toContain('other')
  })

  it('rebuilds the retained grid on resize and releases its rows on disposal', async () => {
    const probe = await rendererProbe('dom')
    const host = probe.canvas.parentElement!
    const original = host.querySelector('[data-row="0"]')!
    probe.terminal.resize({ columns: 8, rows: 2 })
    probe.renderer.resize({ columns: 8, rows: 2 })
    expect(host.querySelectorAll('[data-row]')).toHaveLength(2)
    expect(host.querySelector('[data-row="0"]')).not.toBe(original)
    expect(probe.canvas.width).toBe(80)
    expect(probe.canvas.height).toBe(40)
    probe.terminal.write('\x1b[?25l\x1b[2J\x1b[Hsmall')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    const row = host.querySelector('[data-row="0"]')!
    const span = row.firstElementChild!
    probe.terminal.write('\rshort')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    expect(host.querySelector('[data-row="0"]')).toBe(row)
    expect(row.firstElementChild).toBe(span)
    expect(span.textContent).toBe('short')
    const font = { ...probeFont, cssCellWidth: 12, deviceCellWidth: 12 }
    probe.renderer.setFont(font)
    probe.clock.flush()
    const frame = host.querySelector('.ghostty-webgpu-frame')!
    expect(frame.parentElement!.innerHTML).toBe(
      renderFrameToHtml(snapshotRenderState(probe.state), { columns: 8, rows: 2, font }),
    )
    expect(frame.getBoundingClientRect().width).toBe(96)
    const surface = Reflect.get(probe.renderer, 'surface') as {
      paint(row: RenderRow, cursor: CursorState | undefined): boolean
    }
    const lastRow = probe.state.readRows()[0]!
    probe.renderer.dispose()
    expect(surface.paint(lastRow, undefined)).toBe(false)
    expect(host.querySelector('.ghostty-webgpu-frame')).toBeNull()
    expect(probe.canvas.style.opacity).toBe('')
  })

  it('retains undamaged rows, repaints selection, and tears down the owned surface', async () => {
    const probe = await rendererProbe('dom')
    const host = probe.canvas.parentElement!
    const previous = host.querySelector('[data-row="0"]')
    probe.terminal.write('\x1b[2;1Hchanged')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    const third = host.querySelector('[data-row="2"]')
    probe.terminal.write('!')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    expect(host.querySelector('[data-row="2"]')).toBe(third)
    expect(host.querySelector('[data-row="0"]')).toBe(previous)
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

  it('preserves accessible rows and keyboard link activation through retained repaints', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const host = document.createElement('div')
    host.style.width = '300px'
    host.style.height = '100px'
    document.body.append(host)
    cleanups.push(() => host.remove())
    const activations: string[] = []
    const terminal = await Terminal.create({
      appearance: {
        grid: { columns: 12, rows: 3 },
        font: { family: 'monospace', size: 16 },
        cursor: { blink: false },
      },
      accessibility: {},
      links: { activateUri: (uri) => void activations.push(uri) },
    })
    cleanups.push(() => terminal.dispose())
    await terminal.open(host)
    const uri = 'https://dom-link.test'
    for (const text of ['first', 'second']) {
      terminal.write(`\r\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`)
      await vi.waitFor(() =>
        expect(host.querySelector('.ghostty-webgpu-accessibility')?.textContent).toContain(text),
      )
      const frame = host.querySelector('.ghostty-webgpu-frame')!
      expect(frame.getAttribute('aria-hidden')).toBe('true')
      expect(frame.textContent).toContain(text)
      expect(terminal.textarea!.getAttribute('aria-controls')).toContain(
        host.querySelector('.ghostty-webgpu-accessibility')!.id,
      )
      expect(await terminal.focusNextLink()).toBe(true)
      const link = host.querySelector('[role="link"]')!
      expect(document.activeElement).toBe(link)
      const before = activations.length
      await userEvent.keyboard('{Enter}')
      await vi.waitFor(() => expect(activations).toHaveLength(before + 1))
    }
    expect(activations).toEqual([uri, uri])
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

it('observes peer canvas CSS changes between participating native callbacks', async () => {
  const runtime = await GhosttyRuntime.create()
  cleanups.push(() => runtime.dispose())
  const events: string[] = []
  const make = async (name: string) => {
    const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write(probeInput)
    const canvas = mountedCanvas()
    const renderer = await DomTerminalRenderer.create({
      canvas,
      columns: 12,
      rows: 3,
      font: probeFont,
      renderState: state,
      onRowsPainted: () => events.push(`paint-${name}`),
    })
    cleanups.push(() => renderer.dispose())
    return { canvas, renderer }
  }
  await make('a')
  let peer: HTMLCanvasElement | undefined
  requestAnimationFrame(() => {
    events.push('peer-css-change')
    peer!.style.marginLeft = '30px'
    peer!.style.paddingLeft = '11px'
    peer!.parentElement!.style.paddingLeft = '10px'
  })
  const b = await make('b')
  peer = b.canvas
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  expect(events).toEqual(['paint-a', 'peer-css-change', 'paint-b'])
  const expected = `${b.canvas.offsetLeft + parseFloat(getComputedStyle(b.canvas).paddingLeft)}px`
  expect(b.canvas.nextElementSibling!.getAttribute('style')).toContain(`left: ${expected}`)
})

it('packed DOM rows keep styled callbacks and lazy snapshots owned across writes and memory growth', async () => {
  const snapshots: RendererFrameSnapshot[] = []
  const retained: (readonly RenderRow[])[] = []
  const probe = await rendererProbe(
    'dom',
    probeInput,
    probeFont,
    (snapshot) => snapshots.push(snapshot),
    (rows) => retained.push(rows),
  )
  const original = retained[0]!
  const expected = probe.state.readRows().map((row) => row.cells)
  const frame = snapshots[0]!
  expect(original.every((row) => row.packed !== undefined)).toBe(true)
  expect(probe.renderer.metrics.paintedRows).toBe(3)
  expect(probe.renderer.metrics.paintedCells).toBe(36)
  probe.runtime.exports.memory.grow(1)
  probe.terminal.write('\x1b[2J\x1b[H\x1b[31mdifferent 日本語')
  probe.renderer.notifyWrite()
  probe.clock.flush()
  expect(original.map((row) => row.cells)).toEqual(expected)
  expect(frame.rows.map((row) => row.renderCells)).toEqual(expected)
  expect(frame.rows.every((row) => Object.isFrozen(row.renderCells))).toBe(true)
  expect(frame.rows[0]!.renderCells).not.toBe(original[0]!.cells)
  const count = retained.reduce((sum, rows) => sum + rows.length, 0)
  const cells = retained.reduce(
    (sum, rows) => sum + rows.reduce((total, row) => total + row.cells.length, 0),
    0,
  )
  expect(probe.renderer.metrics.paintedRows).toBe(count)
  expect(probe.renderer.metrics.paintedCells).toBe(cells)
})

it('keeps live flow offsets through fractional CSS, sibling flow and stylesheet rules', async () => {
  const probe = await rendererProbe('dom')
  const canvas = probe.canvas
  const host = canvas.parentElement!
  const container = canvas.nextElementSibling as HTMLElement
  const oracle = document.createElement('div')
  oracle.style.position = 'absolute'
  host.append(oracle)
  const expectFlowOffsets = () => {
    probe.terminal.write('\rnext')
    probe.renderer.notifyWrite()
    probe.clock.flush()
    const style = getComputedStyle(canvas)
    oracle.style.left = `${canvas.offsetLeft + parseFloat(style.paddingLeft)}px`
    oracle.style.top = `${canvas.offsetTop + parseFloat(style.paddingTop)}px`
    const expected = oracle.getBoundingClientRect()
    const actual = container.getBoundingClientRect()
    expect(actual.left).toBeCloseTo(expected.left, 5)
    expect(actual.top).toBeCloseTo(expected.top, 5)
  }
  expectFlowOffsets()
  host.style.border = '2.25px solid transparent'
  host.style.padding = '3.25px 4.5px'
  canvas.style.margin = '2.5px 5.5px'
  expectFlowOffsets()
  const sibling = document.createElement('div')
  sibling.style.height = '17.25px'
  host.prepend(sibling)
  expectFlowOffsets()
  canvas.setAttribute('data-dom-position-probe', '')
  const sheet = document.createElement('style')
  document.head.append(sheet)
  cleanups.push(() => sheet.remove())
  sheet.sheet!.insertRule(
    'canvas[data-dom-position-probe] { anchor-name: --embedder !important; margin-top: 23.25px !important; padding-left: 19px !important }',
  )
  expectFlowOffsets()
  sheet.remove()
  canvas.style.padding = '5% 7%'
  host.style.width = '400px'
  expectFlowOffsets()
  host.style.width = '350px'
  expectFlowOffsets()
})

it('isolates fixed-grid layout through theme and font changes', async () => {
  const probe = await rendererProbe('dom')
  const frame = () =>
    probe.canvas.parentElement!.querySelector<HTMLElement>('.ghostty-webgpu-frame')!
  expect(frame().style.contain).toBe('layout paint')
  probe.renderer.setTheme({ background: { r: 1, g: 2, b: 3 } })
  probe.clock.flush()
  expect(frame().style.contain).toBe('layout paint')
  probe.renderer.setFont({ ...probeFont, cssCellWidth: 12, deviceCellWidth: 12 })
  probe.clock.flush()
  expect(frame().style.contain).toBe('layout paint')
  expect(frame().getBoundingClientRect().width).toBe(144)
})

it('preserves row-derived frame height when the host overrides height to auto', async () => {
  const probe = await rendererProbe('dom')
  const frame = probe.canvas.parentElement!.querySelector<HTMLElement>('.ghostty-webgpu-frame')!
  const height = 3 * probeFont.cssCellHeight
  expect(frame.getBoundingClientRect().height).toBe(height)
  frame.style.height = 'auto'
  expect(frame.getBoundingClientRect().height).toBe(height)
})

it('restores priority-only changes to owned overlay positions', async () => {
  const probe = await rendererProbe('dom')
  const container = probe.canvas.nextElementSibling as HTMLElement
  for (const property of ['left', 'top']) {
    container.style.setProperty(property, container.style.getPropertyValue(property), 'important')
  }
  probe.terminal.write('\rnext')
  probe.renderer.notifyWrite()
  probe.clock.flush()
  expect(container.style.getPropertyPriority('left')).toBe('')
  expect(container.style.getPropertyPriority('top')).toBe('')
})

it('restores overlay declarations after exposed inline styles change', async () => {
  const probe = await rendererProbe('dom')
  const container = probe.canvas.nextElementSibling as HTMLElement
  const left = container.style.left
  const top = container.style.top
  expect(left).not.toBe('')
  container.style.removeProperty('left')
  container.style.top = '0px'
  probe.terminal.write('\rnext')
  probe.renderer.notifyWrite()
  probe.clock.flush()
  expect(container.style.left).toBe(left)
  expect(container.style.top).toBe(top)
})

it('reads live canvas geometry without repeating unchanged overlay declarations', async () => {
  const probe = await rendererProbe('dom')
  const container = probe.canvas.nextElementSibling as HTMLElement
  const styles = new MutationObserver(() => {})
  styles.observe(container, { attributes: true, attributeFilter: ['style'] })
  cleanups.push(() => styles.disconnect())
  probe.terminal.write('\rnext')
  probe.renderer.notifyWrite()
  probe.clock.flush()
  expect(styles.takeRecords()).toEqual([])
  probe.canvas.style.marginLeft = '23px'
  probe.canvas.style.paddingTop = '11px'
  probe.terminal.write('\ranother')
  probe.renderer.notifyWrite()
  probe.clock.flush()
  expect(container.style.left).toBe('30px')
  expect(container.style.top).toBe('11px')
})
