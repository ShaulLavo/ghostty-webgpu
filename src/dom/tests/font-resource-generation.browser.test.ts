import { expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { CanvasTerminalRenderer } from '../../render/canvas/renderer.js'
import { WebGpuTerminalRenderer } from '../../render/renderer.js'
import { WebGlTerminalRenderer } from '../../render/webgl/renderer.js'
import type { WebGpuTerminalRendererOptions } from '../../render/renderer.js'
import { TerminalSession } from '../../term/session.js'
import type { TerminalFontSettings } from '../../term/types.js'
import { fitTerminalFont } from '../fit.js'
import { createGhosttyWebGpuTerminalFromSession } from '../terminal.js'
import type { Terminal } from '../terminal.js'

const resources = {
  before: new URL('./fixtures/font-resource/before.woff2', import.meta.url).href,
  replacement: new URL('./fixtures/font-resource/replacement.woff2', import.meta.url).href,
  changed: new URL('./fixtures/font-resource/changed-metrics.woff2', import.meta.url).href,
}
type Backend = 'webgl' | 'webgpu' | 'pixels' | 'fill-text'
type Renderer = WebGlTerminalRenderer | WebGpuTerminalRenderer | CanvasTerminalRenderer

async function load(family: string, url: string): Promise<FontFace> {
  const face = new FontFace(family, `url(${url})`)
  document.fonts.add(face)
  await document.fonts.load(`20px "${family}"`, 'MAg')
  await document.fonts.ready
  expect(face.status).toBe('loaded')
  return face
}

async function settle(): Promise<void> {
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
}

async function createRenderer(
  backend: Backend,
  options: WebGpuTerminalRendererOptions,
): Promise<Renderer> {
  if (backend === 'webgl') return WebGlTerminalRenderer.create(options)
  if (backend === 'webgpu') return WebGpuTerminalRenderer.create(options)
  return CanvasTerminalRenderer.create({
    ...options,
    rendererMode: backend === 'pixels' ? 'canvas2d-pixels' : 'canvas2d-fill-text',
  })
}

async function pixels(renderer: Renderer, terminal: Terminal): Promise<Uint8Array> {
  if (renderer instanceof WebGpuTerminalRenderer) {
    return new Promise((resolve, reject) => {
      const subscription = terminal.on('frame', () => {
        subscription.dispose()
        void renderer.capturePixels().then(resolve, reject)
      })
      terminal.refresh(0, terminal.appearance.grid.rows - 1)
    })
  }
  if (renderer instanceof WebGlTerminalRenderer) return renderer.capturePixels()
  const canvas = terminal.canvas!
  return new Uint8Array(
    canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data,
  )
}

const cases = (['webgl', 'webgpu', 'pixels', 'fill-text'] as const).flatMap((backend) =>
  [true, false].map((autoFit) => ({ backend, autoFit, fallback: false })),
)

cases.push({ backend: 'webgl', autoFit: false, fallback: true })

it.each(cases)(
  'refreshes $backend glyph resources after same-metric font replacement, autoFit $autoFit, fallback $fallback',
  async ({ backend, autoFit, fallback }) => {
    const runtime = await GhosttyRuntime.create()
    const family = `FontResource-${backend}-${autoFit}`
    const font: TerminalFontSettings = {
      family: fallback ? `MissingResource812, "${family}"` : family,
      size: 20,
      weight: 400,
      boldWeight: 700,
      lineHeight: 1,
      letterSpacing: 0,
    }
    const faces: FontFace[] = []
    const terminals: Terminal[] = []
    const hosts: HTMLElement[] = []
    const renderers: Renderer[] = []
    const open = async () => {
      const host = document.createElement('div')
      host.style.width = '360px'
      host.style.height = '160px'
      document.body.append(host)
      hosts.push(host)
      const session = await TerminalSession.create({
        runtime: { kind: 'borrowed', runtime },
        appearance: { font, grid: { columns: 20, rows: 6 }, cursor: { blink: false } },
      })
      const terminal = createGhosttyWebGpuTerminalFromSession(session, {
        autoFit,
        accessibility: false,
        rendererFactory: async (options) => {
          const renderer = await createRenderer(backend, options)
          renderers.push(renderer)
          return renderer
        },
      })
      terminals.push(terminal)
      await terminal.open(host)
      terminal.write('\x1b[?25lAAAA')
      await settle()
      return terminal
    }
    try {
      faces.push(await load(family, resources.before))
      const terminal = await open()
      const resourceClears = vi.spyOn(renderers[0]!, 'clearTextureAtlas')
      terminal.refresh(0, terminal.appearance.grid.rows - 1)
      terminal.setCursor({ style: 'bar' })
      await settle()
      expect(resourceClears).not.toHaveBeenCalled()
      faces.push(await load(`${family}-Unrelated`, resources.before))
      await settle()
      expect(resourceClears).not.toHaveBeenCalled()
      const beforeFit = fitTerminalFont(document, font, devicePixelRatio)
      const before = await pixels(renderers[0]!, terminal)
      document.fonts.delete(faces[0]!)
      let fontEvents = 0
      const onLoaded = () => {
        fontEvents += 1
      }
      document.fonts.addEventListener('loadingdone', onLoaded)
      faces.push(await load(family, resources.replacement))
      await settle()
      document.fonts.removeEventListener('loadingdone', onLoaded)
      expect(fontEvents).toBeGreaterThan(0)
      expect(resourceClears).toHaveBeenCalled()
      expect(fitTerminalFont(document, font, devicePixelRatio)).toEqual(beforeFit)
      const after = await pixels(renderers[0]!, terminal)
      const freshTerminal = await open()
      const fresh = await pixels(renderers[1]!, freshTerminal)
      expect(fresh).not.toEqual(before)
      expect(after).toEqual(fresh)
      faces.filter((face) => face.family === family).forEach((face) => document.fonts.delete(face))
      faces.push(await load(family, resources.changed))
      await settle()
      const resourceFit = fitTerminalFont(document, terminal.appearance.font, devicePixelRatio)
      expect(resourceFit.deviceCellWidth).not.toBe(beforeFit.deviceCellWidth)
      expect(terminal.submittedFrame!.font.deviceCellWidth).toBe(resourceFit.deviceCellWidth)
      expect(terminal.appearance.grid.cellWidth).toBe(resourceFit.cssCellWidth)
      expect(terminal.canvas!.width).toBe(
        terminal.appearance.grid.columns * resourceFit.deviceCellWidth,
      )

      const changedFamily = `${family}-ChangedMetric`
      faces.push(await load(changedFamily, resources.changed))
      terminal.setFont({ family: changedFamily })
      await settle()
      const changedFit = fitTerminalFont(document, terminal.appearance.font, devicePixelRatio)
      expect(changedFit.deviceCellWidth).not.toBe(beforeFit.deviceCellWidth)
      expect(terminal.appearance.grid.cellWidth).toBe(changedFit.cssCellWidth)
      expect(terminal.canvas!.width).toBe(
        terminal.appearance.grid.columns * changedFit.deviceCellWidth,
      )
      terminal.dispose()
      const clearedBeforeDisposeEvent = resourceClears.mock.calls.length
      faces.push(await load(`${family}-AfterDispose`, resources.before))
      await settle()
      expect(terminal.lifecycle).toBe('disposed')
      expect(resourceClears.mock.calls.length).toBe(clearedBeforeDisposeEvent)
      resourceClears.mockRestore()
    } finally {
      for (const terminal of terminals) terminal.dispose()
      for (const face of faces) document.fonts.delete(face)
      for (const host of hosts) host.remove()
      runtime.dispose()
    }
  },
  20000,
)
