import { expect, it, onTestFinished, vi } from 'vitest'
import { page } from 'vitest/browser'
import { PackedCells } from '../../core/packed-cells.js'
import { WebGpuTextPass } from '../webgpu/text-pass.js'
import { WebGlTextPass } from '../webgl/text-pass.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import { fitTerminalFont } from '../../dom/fit.js'
import { WebGpuTerminalRenderer } from '../webgpu/renderer.js'
import { WebGlTerminalRenderer } from '../webgl/renderer.js'
import { CanvasTerminalRenderer } from '../canvas/renderer.js'
import { DomTerminalRenderer } from '../dom/renderer.js'
import type { RenderSchedulerClock } from '../shared/scheduler.js'

class Clock implements RenderSchedulerClock {
  private next = 0
  readonly frames = new Map<number, () => void>()
  readonly timers = new Map<number, () => void>()
  readonly delays: number[] = []
  requestFrame(callback: () => void): number {
    const id = ++this.next
    this.frames.set(id, callback)
    return id
  }
  cancelFrame(id: number): void {
    this.frames.delete(id)
  }
  setTimer(callback: () => void, delay: number): number {
    const id = ++this.next
    this.timers.set(id, callback)
    this.delays.push(delay)
    return id
  }
  clearTimer(id: number): void {
    this.timers.delete(id)
  }
  flush(): void {
    let count = 0
    while (this.frames.size > 0) {
      if (++count > 10) throw new Error('Frame loop did not settle')
      const callbacks = Array.from(this.frames.values())
      this.frames.clear()
      for (const callback of callbacks) callback()
    }
  }
  tick(): void {
    const callbacks = Array.from(this.timers.values())
    this.timers.clear()
    for (const callback of callbacks) callback()
    this.flush()
  }
}

const backends = ['webgpu', 'webgl2', 'fill-text', 'pixels', 'dom'] as const

async function setup(
  backend: (typeof backends)[number],
  input: string,
  extension: { textBlink?: boolean } = { textBlink: true },
) {
  const runtime = await GhosttyRuntime.create()
  onTestFinished(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
  const state = runtime.createRenderState(terminal)
  const host = document.createElement('div')
  const canvas = document.createElement('canvas')
  host.append(canvas)
  document.body.append(host)
  onTestFinished(() => host.remove())
  const font = fitTerminalFont(
    document,
    {
      family: 'monospace',
      size: 16,
      weight: 400,
      boldWeight: 700,
      letterSpacing: 0,
      lineHeight: 1.2,
    },
    1,
  )
  const clock = new Clock()
  const options = {
    canvas,
    font,
    columns: 12,
    rows: 3,
    renderState: state,
    schedulerClock: clock,
    textBlink: extension.textBlink,
  }
  terminal.write('\x1b[?25l' + input)
  const renderer = await create(backend, options)
  onTestFinished(() => renderer.dispose())
  renderer.setFocused(true)
  clock.flush()
  return { renderer, terminal, clock, canvas, host, font }
}

function create(
  backend: (typeof backends)[number],
  options: Parameters<typeof WebGpuTerminalRenderer.create>[0],
) {
  if (backend === 'webgpu')
    return WebGpuTerminalRenderer.create({ ...options, adapterPolicy: 'any' })
  if (backend === 'webgl2') return WebGlTerminalRenderer.create(options)
  if (backend === 'dom') return DomTerminalRenderer.create(options)
  return CanvasTerminalRenderer.create({
    ...options,
    rendererMode: backend === 'pixels' ? 'canvas2d-pixels' : 'canvas2d-fill-text',
  })
}

async function pixels(fixture: Awaited<ReturnType<typeof setup>>): Promise<number[] | string> {
  if (fixture.renderer instanceof WebGpuTerminalRenderer)
    return page.screenshot({ element: fixture.canvas, save: false, scale: 'css' })
  if (fixture.renderer instanceof DomTerminalRenderer) {
    return Array.from(fixture.host.querySelectorAll('[data-row="0"] span'), (span) =>
      getComputedStyle(span).color === 'rgba(0, 0, 0, 0)' ? 0 : 1,
    )
  }
  if ('capturePixels' in fixture.renderer) return Array.from(await fixture.renderer.capturePixels())
  const copy = document.createElement('canvas')
  copy.width = fixture.canvas.width
  copy.height = fixture.canvas.height
  const context = copy.getContext('2d')!
  context.drawImage(fixture.canvas, 0, 0)
  return Array.from(context.getImageData(0, 0, copy.width, copy.height).data)
}

it.each(backends)(
  '%s renders both text blink phases and restores the original pixels',
  async (backend) => {
    const fixture = await setup(backend, '\x1b[5;4;41mA界e\u0301🙂\x1b[0m Z')
    await page.screenshot({
      element: fixture.host,
      path: `.artifacts/text-blink-${backend}-visible.png`,
    })
    const before = await pixels(fixture)
    const uploads =
      'instanceUploadOperations' in fixture.renderer.metrics
        ? fixture.renderer.metrics.instanceUploadOperations
        : undefined
    expect(fixture.clock.timers.size).toBe(1)
    expect(fixture.clock.delays).toEqual([600])
    fixture.clock.tick()
    await page.screenshot({
      element: fixture.host,
      path: `.artifacts/text-blink-${backend}-hidden.png`,
    })
    const hidden = await pixels(fixture)
    expect(hidden).not.toEqual(before)
    fixture.clock.tick()
    expect(await pixels(fixture)).toEqual(before)
    if (uploads !== undefined && 'instanceUploadOperations' in fixture.renderer.metrics)
      expect(fixture.renderer.metrics.instanceUploadOperations).toBe(uploads)
    fixture.terminal.write('\x1b[H\x1b[0m\x1b[2Jplain')
    fixture.renderer.notifyWrite()
    fixture.clock.flush()
    expect(fixture.clock.timers.size).toBe(0)
    expect(fixture.clock.frames.size).toBe(0)
  },
)

it.each(backends)(
  '%s schedules zero idle frames and timers without blinking text',
  async (backend) => {
    const fixture = await setup(backend, 'plain')
    const submitted = fixture.renderer.metrics.submittedFrames
    for (let index = 0; index < 3; index += 1) fixture.clock.tick()
    expect(fixture.renderer.metrics.submittedFrames).toBe(submitted)
    expect(fixture.clock.frames.size).toBe(0)
    expect(fixture.clock.timers.size).toBe(0)
  },
)

it.each(backends)(
  '%s pauses for focus, visibility and reduced motion and drops offscreen blink rows',
  async (backend) => {
    const fixture = await setup(backend, '\x1b[5mA\x1b[0m')
    const before = await pixels(fixture)
    fixture.clock.tick()
    expect(await pixels(fixture)).not.toEqual(before)
    fixture.renderer.setReducedMotion(true)
    fixture.clock.flush()
    expect(await pixels(fixture)).toEqual(before)
    expect(fixture.clock.timers.size).toBe(0)
    fixture.renderer.setReducedMotion(false)
    expect(fixture.clock.timers.size).toBe(1)
    fixture.renderer.setFocused(false)
    fixture.clock.flush()
    expect(fixture.clock.timers.size).toBe(0)
    fixture.renderer.setFocused(true)
    fixture.clock.flush()
    fixture.renderer.setDocumentVisible(false)
    expect(fixture.clock.timers.size).toBe(0)
    fixture.renderer.setDocumentVisible(true)
    fixture.clock.flush()
    expect(fixture.clock.timers.size).toBe(1)
    fixture.terminal.write('\r\nplain\r\nplain\r\nplain')
    fixture.renderer.notifyWrite()
    fixture.clock.flush()
    expect(fixture.clock.timers.size).toBe(0)
    expect(fixture.clock.frames.size).toBe(0)
  },
)

it.each(
  backends.flatMap((backend) => [
    { backend, textBlink: undefined },
    { backend, textBlink: false },
  ]),
)(
  '$backend keeps SGR 5/6 steady with textBlink=$textBlink and no phase work',
  async ({ backend, textBlink }) => {
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    const packedScan = vi.spyOn(PackedCells.prototype, 'hasBlinkingText')
    const gpuPhase = vi.spyOn(WebGpuTextPass.prototype, 'setTextVisible')
    const glPhase = vi.spyOn(WebGlTextPass.prototype, 'setTextVisible')
    const fixture = await setup(backend, '\x1b[5mA\x1b[0m \x1b[6mB\x1b[0m', { textBlink })
    const before = await pixels(fixture)
    const submitted = fixture.renderer.metrics.submittedFrames
    expect(fixture.clock.timers.size).toBe(0)
    for (let index = 0; index < 3; index += 1) fixture.clock.tick()
    expect(await pixels(fixture)).toEqual(before)
    expect(fixture.renderer.metrics.submittedFrames).toBe(submitted)
    expect(fixture.clock.frames.size).toBe(0)
    expect(packedScan).not.toHaveBeenCalled()
    expect(gpuPhase).not.toHaveBeenCalled()
    expect(glPhase).not.toHaveBeenCalled()
  },
)
