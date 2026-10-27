import { expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { Terminal } from '../../../dist/index.js'
import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'
import { CanvasTerminalRenderer } from '../../../dist/render/canvas/renderer.js'
import { DomTerminalRenderer } from '../../../dist/render/dom/renderer.js'
import { WebGlTerminalRenderer } from '../../../dist/render/webgl/renderer.js'
import { WebGpuTerminalRenderer } from '../../../dist/render/webgpu/renderer.js'
import type {
  GhosttyWebGpuRendererFactory,
  GhosttyWebGpuTerminalFromSessionOptions,
} from '../../../dist/dom/types.js'
import { testFontUrl } from '../../tests/fonts.js'

const family = 'SynchronizedOutputMono'
const factories = {
  canvas: CanvasTerminalRenderer.create,
  'canvas-pixels': CanvasTerminalRenderer.create,
  dom: DomTerminalRenderer.create,
  webgl: WebGlTerminalRenderer.create,
  webgpu: WebGpuTerminalRenderer.create,
} satisfies Record<string, GhosttyWebGpuRendererFactory>
const assets = {
  wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
  bridge: new URL('../../../bridge.wasm', import.meta.url).href,
}

type Backend = keyof typeof factories | 'worker-webgl' | 'worker-webgpu'

async function createTerminal(backend: Backend, quietMs = 100) {
  const appearance = {
    grid: { columns: 24, rows: 4 },
    font: { family, size: 16 },
    cursor: { blink: false },
  }
  if (backend === 'worker-webgl' || backend === 'worker-webgpu') {
    return WorkerTerminal.create({
      appearance,
      autoFit: false,
      accessibility: {},
      outputTiming: { quietMs },
      backend: backend === 'worker-webgl' ? 'webgl' : 'webgpu',
      fonts: [{ family, source: { url: testFontUrl } }],
    })
  }
  const options: GhosttyWebGpuTerminalFromSessionOptions = {
    appearance,
    autoFit: false,
    accessibility: {},
    runtime: { kind: 'owned', options: assets },
    outputTiming: { quietMs },
    rendererMode: backend === 'canvas-pixels' ? 'canvas2d-pixels' : undefined,
    rendererFactory: (options) => factories[backend](options),
  }
  return Terminal.create(options)
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120))
}

it.each([
  'canvas',
  'canvas-pixels',
  'dom',
  'webgl',
  'webgpu',
  'worker-webgl',
  'worker-webgpu',
] as const)(
  'holds displayed pixels, observers and accessibility with %s',
  async (backend) => {
    await page.viewport(800, 600)
    const face = await new FontFace(family, `url(${testFontUrl})`).load()
    document.fonts.add(face)
    const host = document.createElement('div')
    host.style.cssText = 'width:480px;height:160px;position:relative'
    document.body.append(host)
    const terminal = await createTerminal(backend).catch((cause: unknown) => {
      host.remove()
      document.fonts.delete(face)
      throw cause
    })
    const texts: string[] = []
    terminal.onText(({ rows }) => {
      texts.push(rows.map((row) => row.text).join('\n'))
    })
    let frames = 0
    terminal.onFrame(() => {
      frames += 1
    })
    try {
      await terminal.open(host)
      await terminal.write('\x1b[?25l\x1b[41m\x1b[2J\x1b[Hbefore')
      await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before')
      await expect.poll(() => host.textContent).toContain('before')
      await settle()
      const screen = host
      const before = await page.screenshot({ element: screen, save: false, scale: 'css' })
      const beforeFrames = frames
      await terminal.write('\x1b[?2026h\x1b[42m\x1b[2J\x1b[Hpartial')
      expect((await terminal.readLines(0, 1))[0]?.text.trimEnd()).toBe('partial')
      await settle()
      expect(terminal.visibleLines()[0]?.trimEnd()).toBe('before')
      expect(frames).toBeGreaterThanOrEqual(beforeFrames)
      expect(texts.some((text) => text.includes('partial'))).toBe(false)
      expect(host.textContent).not.toContain('partial')
      expect(await page.screenshot({ element: screen, save: false, scale: 'css' })).toBe(before)
      await page.screenshot({ element: host, path: `.artifacts/dec2026-${backend}-held.png` })
      const heldFrames = frames
      await terminal.write(' complete\x1b[?2026l')
      await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('partial complete')
      await expect.poll(() => host.textContent).toContain('partial complete')
      await settle()
      expect(frames).toBeGreaterThan(heldFrames)
      expect(await page.screenshot({ element: screen, save: false, scale: 'css' })).not.toBe(before)
      await page.screenshot({ element: host, path: `.artifacts/dec2026-${backend}-released.png` })
      await terminal.write('\x1b[?2026h\r\x1b[2Ktimeout rendered')
      await terminal.clearTextureAtlas()
      await settle()
      expect(terminal.visibleLines()[0]?.trimEnd()).toBe('partial complete')
      await expect
        .poll(() => terminal.visibleLines()[0]?.trimEnd(), { timeout: 2500 })
        .toBe('timeout rendered')
      await expect
        .poll(() => host.querySelector('.ghostty-webgpu-accessibility')?.textContent)
        .toContain('timeout rendered')
      await page.screenshot({ element: host, path: `.artifacts/dec2026-${backend}-timeout.png` })
    } finally {
      await terminal.dispose()
      host.remove()
      document.fonts.delete(face)
    }
  },
  15_000,
)

it.each(['canvas', 'worker-webgl', 'worker-webgpu'] as const)(
  'acknowledges held output timing only after release with %s',
  async (backend) => {
    const face = await new FontFace(family, `url(${testFontUrl})`).load()
    document.fonts.add(face)
    const host = document.createElement('div')
    host.style.cssText = 'width:480px;height:160px;position:relative'
    document.body.append(host)
    const terminal = await createTerminal(backend, 50).catch((cause: unknown) => {
      host.remove()
      document.fonts.delete(face)
      throw cause
    })
    const events: { drawnAt?: number; presentedAt?: number }[] = []
    try {
      await terminal.open(host)
      await terminal.write('\x1b[?25lbefore')
      await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('before')
      await settle()
      terminal.on('outputTiming', (event) => {
        events.push(event)
      })
      const start = performance.now()
      await terminal.write('\x1b[?2026h\rpartial')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(terminal.visibleLines()[0]?.trimEnd()).toBe('before')
      expect(events).toEqual([])
      await terminal.clearTextureAtlas()
      await settle()
      expect(events).toEqual([])
      await expect
        .poll(() => events.find((event) => event.drawnAt !== undefined), { timeout: 2500 })
        .toBeDefined()
      expect(events[0]?.drawnAt).toBeGreaterThanOrEqual(start + 950)
      await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('partial')
      events.length = 0
      await terminal.write('\x1b[?2026h\rupdated')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(events).toEqual([])
      const released = performance.now()
      await terminal.write('\x1b[?2026l')
      await expect.poll(() => events.find((event) => event.drawnAt !== undefined)).toBeDefined()
      expect(
        events
          .filter((event) => event.drawnAt !== undefined)
          .every((event) => event.drawnAt! >= released),
      ).toBe(true)
    } finally {
      await terminal.dispose()
      host.remove()
      document.fonts.delete(face)
    }
  },
  10_000,
)
