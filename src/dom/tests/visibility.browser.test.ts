import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import { CanvasTerminalRenderer } from '../../render/canvas/renderer.js'
import { DomTerminalRenderer } from '../../render/dom/renderer.js'
import { WebGlTerminalRenderer } from '../../render/webgl/renderer.js'
import { WebGpuTerminalRenderer } from '../../render/webgpu/renderer.js'
import { testFontUrl } from '../../tests/fonts.js'
import { Terminal } from '../terminal.js'
import type { TerminalApi } from '../terminal-api.js'

const cleanups: Array<() => void | Promise<void>> = []
let runtime: GhosttyRuntime
beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterAll(() => runtime.dispose())
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const backends = [
  'webgpu',
  'webgl2',
  'canvas2d',
  'pixels',
  'dom',
  'worker-webgpu',
  'worker-webgl2',
] as const
type Backend = (typeof backends)[number]

async function frames(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

async function intersection(element: Element, visible: boolean): Promise<void> {
  await new Promise<void>((resolve) => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting !== visible) return
      observer.disconnect()
      resolve()
    })
    cleanups.push(() => observer.disconnect())
    observer.observe(element)
  })
  await frames()
}

async function fixture(
  backend: Backend,
  options: { renderWhenOffscreen?: boolean; presentation?: 'immediate' } = {},
) {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;top:0;left:0;width:480px;height:160px'
  document.body.append(host)
  cleanups.push(() => host.remove())
  let requestedFrames = 0
  let terminal: TerminalApi
  if (backend === 'worker-webgpu' || backend === 'worker-webgl2') {
    terminal = await WorkerTerminal.create({
      renderWhenOffscreen: options.renderWhenOffscreen,
      accessibility: {},
      backend: backend === 'worker-webgpu' ? 'webgpu' : 'webgl',
      appearance: { cursor: { blink: false } },
      fonts: [{ family: 'VisibilityTest', source: { url: testFontUrl } }],
      workerUrl: new URL('../../../dist/worker/entry.js', import.meta.url),
      assets: {
        wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
        bridge: new URL('../../../bridge.wasm', import.meta.url).href,
      },
    })
  } else {
    terminal = await Terminal.create({
      ...options,
      accessibility: {},
      appearance: { cursor: { blink: false }, font: { family: 'monospace', size: 16 } },
      runtime: { kind: 'borrowed', runtime },
      rendererFactory: (options) =>
        ({
          webgpu: WebGpuTerminalRenderer,
          webgl2: WebGlTerminalRenderer,
          canvas2d: CanvasTerminalRenderer,
          pixels: CanvasTerminalRenderer,
          dom: DomTerminalRenderer,
        })[backend].create({
          ...options,
          rendererMode: backend === 'pixels' ? 'canvas2d-pixels' : 'auto',
          schedulerClock: {
            requestFrame: (callback) => {
              requestedFrames += 1
              return window.requestAnimationFrame(callback)
            },
            cancelFrame: (handle) => window.cancelAnimationFrame(handle),
            setTimer: (callback, delay) => window.setTimeout(callback, delay),
            clearTimer: (handle) => window.clearTimeout(handle),
          },
        }),
    })
  }
  cleanups.push(() => terminal.dispose())
  await terminal.open(host)
  await intersection(terminal.element!, true)
  await terminal.write('before')
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before')
  await expect
    .poll(() => terminal.element!.querySelector('[role="list"]')?.textContent)
    .toBe('before')
  await frames()
  return { terminal, host, scheduled: () => requestedFrames }
}

it.for(backends)(
  'pauses offscreen %s and submits current layout and text once on return',
  { timeout: 20_000 },
  async (backend) => {
    const { terminal, host, scheduled } = await fixture(backend)
    const before = terminal.visibleLines()
    const mirror = terminal.element!.querySelector('[role="list"]')
    expect(mirror).not.toBeNull()
    const accessibleBefore = mirror?.textContent
    host.style.top = '200vh'
    await intersection(terminal.element!, false)
    const scheduledBefore = scheduled()
    let painted = 0
    terminal.onFrame(() => painted++)
    await terminal.write('\x1b[H\x1b[2Jhidden 界 é 🧑‍💻')
    await frames()
    expect(painted).toBe(0)
    expect((await terminal.readLines(0, 1))[0]?.text).toContain('hidden 界 é')
    expect(terminal.visibleLines()).toEqual(before)
    await terminal.setFont({ size: 19 })
    await terminal.setTheme({
      ...terminal.appearance.theme,
      background: { r: 18, g: 52, b: 86 },
      foreground: { r: 255, g: 0, b: 0 },
    })
    host.style.width = '560px'
    await frames(5)
    await terminal.write('\r\nlatest')
    await frames()
    expect(painted).toBe(0)
    expect(terminal.visibleLines()).toEqual(before)
    expect(mirror?.textContent).toBe(accessibleBefore)
    expect(terminal.hasPendingFrame).toBe(false)
    expect(scheduled()).toBe(scheduledBefore)
    host.style.top = '0'
    await intersection(terminal.element!, true)
    await expect.poll(() => terminal.visibleLines()[1]?.trimEnd()).toBe('latest')
    expect(terminal.visibleLines()[0]).toContain('hidden 界 é')
    await frames()
    expect(painted).toBe(1)
    await expect.poll(() => mirror?.textContent).toContain('latest')
    await page.screenshot({
      element: terminal.element!,
      path: `../../../.artifacts/visibility-${backend}.png`,
    })
  },
)

it.for(['canvas2d', 'worker-webgl2'] as const)(
  'can keep painting offscreen %s',
  async (backend) => {
    const { terminal, host } = await fixture(backend, { renderWhenOffscreen: true })
    host.style.top = '200vh'
    await intersection(terminal.element!, false)
    await terminal.write(' offscreen')
    await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before offscreen')
  },
)

it('pauses immediate writes and cursor timers when clipped by a scrolling parent', async () => {
  const { terminal, host } = await fixture('canvas2d', { presentation: 'immediate' })
  const clip = document.createElement('div')
  clip.style.cssText = 'position:fixed;top:0;left:0;width:500px;height:180px;overflow:auto'
  document.body.append(clip)
  cleanups.push(() => clip.remove())
  host.style.position = 'relative'
  clip.append(host)
  await terminal.setCursor({ blink: true })
  terminal.focus()
  host.style.marginTop = '1000px'
  await intersection(terminal.element!, false)
  let painted = 0
  terminal.onFrame(() => painted++)
  terminal.write(' clipped')
  await frames()
  expect(terminal.hasPendingTimer).toBe(false)
  expect(terminal.hasPendingFrame).toBe(false)
  expect(painted).toBe(0)
  await terminal.setCursor({ blink: false })
  clip.scrollTop = 1000
  await intersection(terminal.element!, true)
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before clipped')
  expect(painted).toBe(1)
})

it.for(['canvas2d', 'worker-webgl2'] as const)(
  'keeps document visibility authoritative when %s reenters the viewport',
  async (backend) => {
    const { terminal, host } = await fixture(backend)
    host.style.top = '200vh'
    await intersection(terminal.element!, false)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    cleanups.push(() => {
      visibility.mockRestore()
      document.dispatchEvent(new Event('visibilitychange'))
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await terminal.write(' pending')
    host.style.top = '0'
    await intersection(terminal.element!, true)
    expect(terminal.visibleLines()[0]?.trimEnd()).toBe('before')
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before pending')
  },
)

it.for(['canvas2d', 'worker-webgl2'] as const)(
  'waits for the returning %s paint before publishing output timing',
  async (backend) => {
    const { terminal, host } = await fixture(backend)
    host.style.top = '200vh'
    await intersection(terminal.element!, false)
    let delivered = 0
    terminal.on('outputTiming', () => delivered++)
    await terminal.write(' timed')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(delivered).toBe(0)
    host.style.top = '0'
    await intersection(terminal.element!, true)
    await expect.poll(() => delivered).toBe(1)
    expect(terminal.visibleLines()[0]?.trimEnd()).toBe('before timed')
  },
)

const areaCases = [
  { name: 'zero size', width: '0px', height: '0px', top: '0' },
  { name: 'zero width', width: '0px', height: '160px', top: '0' },
  { name: 'zero height', width: '480px', height: '0px', top: '0' },
  { name: 'viewport edge', width: '480px', height: '160px', top: '-160px' },
]
const areaBackends = backends.flatMap((backend) => areaCases.map((area) => ({ backend, area })))

it.for(areaBackends)(
  'pauses $backend with $area.name and repaints once when it has visible area',
  { timeout: 20_000 },
  async ({ backend, area }) => {
    const { terminal, host, scheduled } = await fixture(backend)
    const displayed = terminal.visibleLines()
    Object.assign(host.style, { width: area.width, height: area.height, top: area.top })
    await frames(5)
    const bounds = terminal.element!.getBoundingClientRect()
    expect(bounds.width).toBe(Number.parseFloat(area.width))
    expect(bounds.height).toBe(Number.parseFloat(area.height))
    if (area.name === 'viewport edge') expect(bounds.bottom).toBe(0)
    let painted = 0
    let published = 0
    terminal.onFrame(() => painted++)
    terminal.onText(() => published++)
    published = 0
    const requestedBefore = scheduled()
    await terminal.write('\r\x1b[2Kpending area 界 é')
    await frames(5)
    expect(painted).toBe(0)
    expect(published).toBe(0)
    expect(scheduled()).toBe(requestedBefore)
    expect(terminal.visibleLines()).toEqual(displayed)
    expect((await terminal.readLines(0, 1))[0]?.text).toContain('pending area 界 é')
    Object.assign(host.style, {
      width: '480px',
      height: '160px',
      top: area.name === 'viewport edge' ? '-159px' : '0',
    })
    await frames(5)
    await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('pending area 界 é')
    expect(painted).toBe(1)
    expect(published).toBe(1)
  },
)

const areaOptOuts = (['canvas2d', 'worker-webgl2'] as const).flatMap((backend) =>
  areaCases
    .filter((area) => area.name === 'zero size' || area.name === 'viewport edge')
    .map((area) => ({ backend, area })),
)

it.for(areaOptOuts)(
  'keeps painting $backend with $area.name when opted out',
  async ({ backend, area }) => {
    const { terminal, host } = await fixture(backend, { renderWhenOffscreen: true })
    Object.assign(host.style, { width: area.width, height: area.height, top: area.top })
    await frames(5)
    await terminal.write(' opted out')
    await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before opted out')
  },
)
