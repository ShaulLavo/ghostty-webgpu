import { expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../../dist/core/runtime.js'
import { CanvasTerminalRenderer } from '../../../dist/render/canvas/renderer.js'
import { DomTerminalRenderer } from '../../../dist/render/dom/renderer.js'
import { WebGlTerminalRenderer } from '../../../dist/render/webgl/renderer.js'
import { WebGpuTerminalRenderer } from '../../../dist/render/webgpu/renderer.js'
import type { GhosttyTerminal } from '../../../dist/core/terminal.js'
import type { RenderSchedulerClock } from '../../../dist/render/shared/scheduler.js'
import type { RendererTextFrameSnapshot } from '../../../dist/render/shared/types.js'
import { probeFont } from '../dom/tests/probe.js'

class FrameClock implements RenderSchedulerClock {
  private next = 0
  private readonly frames = new Map<number, () => void>()

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
    const frames = Array.from(this.frames.values())
    this.frames.clear()
    for (const frame of frames) frame()
  }
}

const factories = {
  canvas: CanvasTerminalRenderer.create,
  dom: DomTerminalRenderer.create,
  webgl: WebGlTerminalRenderer.create,
  webgpu: WebGpuTerminalRenderer.create,
}

type Backend = keyof typeof factories

async function createView(runtime: GhosttyRuntime, terminal: GhosttyTerminal, backend: Backend) {
  const host = document.createElement('div')
  host.style.cssText = 'width:160px;height:60px;position:relative'
  const canvas = document.createElement('canvas')
  host.append(canvas)
  document.body.append(host)
  const clock = new FrameClock()
  let text = ''
  try {
    const renderer = await factories[backend]({
      canvas,
      columns: 16,
      rows: 3,
      font: probeFont,
      renderState: runtime.createRenderState(terminal),
      schedulerClock: clock,
      onTextFrame: (frame: RendererTextFrameSnapshot) => {
        text = frame.rows[0]?.text.trimEnd() ?? ''
      },
    })
    clock.flush()
    return { host, renderer, clock, readText: () => text }
  } catch (cause) {
    host.remove()
    throw cause
  }
}

type View = Awaited<ReturnType<typeof createView>>

function write(terminal: GhosttyTerminal, views: readonly View[], data: string, order = [0, 1]) {
  terminal.write(data)
  for (const { renderer } of views) renderer.notifyWrite()
  for (const index of order) views[index]!.clock.flush()
}

async function screenshots(views: readonly View[]) {
  return Promise.all(
    views.map(({ host: element }) => page.screenshot({ element, save: false, scale: 'css' })),
  )
}

it.each(['canvas', 'dom', 'webgl', 'webgpu'] as const)(
  'keeps two independently scheduled %s views of one native terminal current',
  async (backend) => {
    const runtime = await GhosttyRuntime.create({
      wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
      bridge: new URL('../../../bridge.wasm', import.meta.url).href,
    })
    const terminal = runtime.createTerminal({ columns: 16, rows: 3 })
    const views: View[] = []
    try {
      views.push(await createView(runtime, terminal, backend))
      views.push(await createView(runtime, terminal, backend))
      write(terminal, views, '\x1b[?25lold')
      expect(views.map((view) => view.readText())).toEqual(['old', 'old'])
      write(terminal, views, ' before')
      expect(views.map((view) => view.readText())).toEqual(['old before', 'old before'])
      const before = await screenshots(views)
      write(terminal, views, '\x1b[?2026h\r\x1b[2Kpartial', [1, 0])
      expect(views.map((view) => view.readText())).toEqual(['old before', 'old before'])
      expect(await screenshots(views)).toEqual(before)
      write(terminal, views, ' complete\x1b[?2026l', [1, 0])
      expect(views.map((view) => view.readText())).toEqual(['partial complete', 'partial complete'])
      const released = await screenshots(views)
      expect(released[0]).toBe(released[1])
      expect(released[0]).not.toBe(before[0])
      for (const [index, { host: element }] of views.entries()) {
        await page.screenshot({ element, path: `.artifacts/b1-${backend}-${index}.png` })
      }
    } finally {
      for (const { renderer, host } of views) {
        renderer.dispose()
        host.remove()
      }
      runtime.dispose()
    }
  },
)
