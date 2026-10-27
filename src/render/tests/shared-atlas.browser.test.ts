import { afterEach, expect, it, vi } from 'vitest'
import { attachNativeTestBuilder } from './native-state.js'
import { RenderStateDirty } from '../../core/abi.js'
import type {
  ReadRowsOptions,
  RenderCell,
  RenderCursorSnapshot,
  RenderRow,
} from '../../core/types.js'
import type { TerminalFittedFont, TerminalFontSettings } from '../../term/types.js'
import { type RenderStateSource, type WebGpuTerminalRendererOptions } from '../shared/types.js'
import { WebGpuTerminalRenderer } from '../webgpu/renderer.js'
import type { RenderSchedulerClock } from '../shared/scheduler.js'

const devices = new Set<GPUDevice>()
const renderers = new Set<WebGpuTerminalRenderer>()
const deviceCleanupDelayMs = 50

afterEach(async () => {
  for (const renderer of renderers) await renderer.dispose()
  renderers.clear()
  devices.clear()
  await waitForDeviceCleanup()
})

class FakeClock implements RenderSchedulerClock {
  private nextHandle = 1
  readonly frames = new Map<number, () => void>()
  readonly timers = new Map<number, () => void>()

  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle)
  }

  requestFrame(callback: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.frames.set(handle, callback)
    return handle
  }

  setTimer(callback: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.timers.set(handle, callback)
    return handle
  }

  flushFrame(): void {
    this.take(this.frames, 'frame')()
  }

  flushTimer(): void {
    this.take(this.timers, 'timer')()
  }

  private take(callbacks: Map<number, () => void>, kind: string): () => void {
    const entry = callbacks.entries().next().value
    if (!entry) throw new Error(`No pending ${kind}`)
    callbacks.delete(entry[0])
    return entry[1]
  }
}

class FakeRenderState implements RenderStateSource {
  acknowledgements = 0
  private cursor: RenderCursorSnapshot = {
    blinking: true,
    passwordInput: false,
    style: 'block',
    viewport: { wideTail: false, x: 0, y: 0 },
    visible: true,
  }
  private damage = RenderStateDirty.Full
  private readonly rows: RenderRow[]

  constructor(columns: number, rows: number) {
    this.rows = Array.from({ length: rows }, (_, y) => ({
      cells: Array.from({ length: columns }, (_, x) => fakeCell(x, y)),
      dirty: true,
      y,
    }))
  }

  acknowledge(): number {
    const dirty = this.rows.filter((row) => row.dirty).length
    for (const row of this.rows) row.dirty = false
    this.damage = RenderStateDirty.False
    this.acknowledgements += 1
    return dirty
  }

  readRows(options: ReadRowsOptions = {}): readonly RenderRow[] {
    return this.rows.filter(
      (row) => (!options.dirtyOnly || row.dirty) && (!options.rows || options.rows.has(row.y)),
    )
  }

  readCursor(): RenderCursorSnapshot {
    return {
      ...this.cursor,
      viewport: this.cursor.viewport ? { ...this.cursor.viewport } : undefined,
    }
  }

  update(): RenderStateDirty {
    return this.damage
  }

  dirtyRow(row: number): void {
    const target = this.rows[row]
    if (!target) throw new RangeError(`Unknown row ${row}`)
    target.dirty = true
    this.damage = RenderStateDirty.Partial
  }

  setCursor(cursor: RenderCursorSnapshot): void {
    this.cursor = cursor
  }
}

function fakeCell(x: number, y: number): RenderCell {
  const background = x === 0 && y === 0 ? { b: 30, g: 20, r: 10 } : undefined
  return {
    background,
    continuation: false,
    selected: false,
    text: x === 1 ? 'A' : '',
    x,
  }
}

async function waitForDeviceCleanup(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, deviceCleanupDelayMs))
}


interface Terminal {
  readonly canvas: HTMLCanvasElement
  readonly clock: FakeClock
  readonly renderer: WebGpuTerminalRenderer
  readonly source: FakeRenderState
}

async function openTerminal(font = fittedFont()): Promise<Terminal> {
  const canvas = createCanvas()
  const clock = new FakeClock()
  const source = new FakeRenderState(2, 2)
  await attachNativeTestBuilder(source, 2, 2)
  const options: WebGpuTerminalRendererOptions = {
    canvas,
    columns: 2,
    rows: 2,
    font,
    renderState: source,
    schedulerClock: clock,
  }
  const renderer = await WebGpuTerminalRenderer.create(options)
  renderers.add(renderer)
  clock.flushFrame()
  return { canvas, clock, renderer, source }
}

function texturesOf(renderer: WebGpuTerminalRenderer): unknown {
  return Reflect.get(Reflect.get(renderer, 'atlasTextures') as object, 'textures')
}

function deviceOf(renderer: WebGpuTerminalRenderer): GPUDevice {
  const device = Reflect.get(renderer, 'device') as GPUDevice
  devices.add(device)
  return device
}

async function repaint(terminal: Terminal): Promise<Uint8Array> {
  terminal.renderer.refreshRows(0, 1)
  terminal.clock.flushFrame()
  return terminal.renderer.capturePixels()
}

it('shares one atlas texture set between terminals with equal fonts and keeps their pixels', async () => {
  const alone = await openTerminal()
  const reference = await alone.renderer.capturePixels()
  expect(reference.some((value) => value !== 0)).toBe(true)
  const peer = await openTerminal()
  expect(texturesOf(peer.renderer)).toBe(texturesOf(alone.renderer))
  expect(deviceOf(peer.renderer)).toBe(deviceOf(alone.renderer))
  expect(await peer.renderer.capturePixels()).toEqual(reference)
  expect(await repaint(alone)).toEqual(reference)
  expect(peer.renderer.metrics.atlasCacheMisses).toBe(alone.renderer.metrics.atlasCacheMisses)
})

it('moves only the terminal whose font changes and leaves its peers drawing the shared atlas', async () => {
  const serif = fittedFont(8, 16, 1, { family: 'serif', size: 15 })
  const solo = await openTerminal(serif)
  const serifReference = await solo.renderer.capturePixels()
  await solo.renderer.dispose()
  renderers.delete(solo.renderer)
  const first = await openTerminal()
  const second = await openTerminal()
  const reference = await first.renderer.capturePixels()
  second.renderer.setFont(serif)
  second.clock.flushFrame()
  expect(texturesOf(second.renderer)).not.toBe(texturesOf(first.renderer))
  expect(await second.renderer.capturePixels()).toEqual(serifReference)
  expect(await repaint(first)).toEqual(reference)
  second.renderer.setFont(fittedFont())
  second.clock.flushFrame()
  expect(texturesOf(second.renderer)).toBe(texturesOf(first.renderer))
  expect(await second.renderer.capturePixels()).toEqual(reference)
})

it('schedules every sharing terminal when one terminal clears the shared atlas', async () => {
  const first = await openTerminal()
  const second = await openTerminal()
  const reference = await second.renderer.capturePixels()
  expect(second.clock.frames.size).toBe(0)
  first.renderer.clearTextureAtlas()
  expect(second.clock.frames.size).toBe(1)
  first.clock.flushFrame()
  second.clock.flushFrame()
  expect(await second.renderer.capturePixels()).toEqual(reference)
  expect(await first.renderer.capturePixels()).toEqual(reference)
})

it('restores one terminal on a replacement device while its peer keeps the original device', async () => {
  const first = await openTerminal()
  const second = await openTerminal()
  const reference = await first.renderer.capturePixels()
  const original = deviceOf(first.renderer)
  await first.renderer.simulateDeviceLoss()
  first.clock.flushFrame()
  expect(deviceOf(first.renderer)).not.toBe(original)
  expect(deviceOf(second.renderer)).toBe(original)
  expect(texturesOf(first.renderer)).not.toBe(texturesOf(second.renderer))
  expect(await first.renderer.capturePixels()).toEqual(reference)
  expect(await repaint(second)).toEqual(reference)
  const destroy = vi.spyOn(original, 'destroy')
  await second.renderer.dispose()
  renderers.delete(second.renderer)
  expect(destroy).toHaveBeenCalledOnce()
  expect(await repaint(first)).toEqual(reference)
})
