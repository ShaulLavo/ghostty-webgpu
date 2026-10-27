import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
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

async function fixture(backend: Backend) {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;top:0;left:0;width:480px;height:160px'
  document.body.append(host)
  cleanups.push(() => host.remove())
  let terminal: TerminalApi
  if (backend === 'worker-webgpu' || backend === 'worker-webgl2') {
    terminal = await WorkerTerminal.create({
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
        }),
    })
  }
  cleanups.push(() => terminal.dispose())
  await terminal.open(host)
  await intersection(terminal.element!, true)
  await terminal.write('before')
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before')
  await frames()
  return { terminal, host }
}

it.for(backends)(
  'pauses offscreen %s and submits current layout and text once on return',
  { timeout: 20_000 },
  async (backend) => {
    const { terminal, host } = await fixture(backend)
    const before = terminal.visibleLines()
    const mirror = terminal.element!.querySelector('[role="list"]')
    const accessibleBefore = mirror?.textContent
    host.style.top = '200vh'
    await intersection(terminal.element!, false)
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
    host.style.top = '0'
    await intersection(terminal.element!, true)
    await expect.poll(() => terminal.visibleLines()[1]?.trimEnd()).toBe('latest')
    expect(terminal.visibleLines()[0]).toContain('hidden 界 é')
    await frames()
    expect(painted).toBe(1)
    await page.screenshot({
      element: terminal.element!,
      path: `../../../.artifacts/visibility-${backend}.png`,
    })
  },
)
