import { expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { Terminal as Xterm } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { HeldRenderClock } from '../../../bench/held-render-clock.js'
import { createGhosttyError } from '../../core/error.js'
import { Terminal } from '../../dom/terminal.js'
import type { GhosttyWebGpuTerminalFromSessionOptions } from '../../dom/types.js'
import { browserRenderClock } from '../config.js'
import { WebGlTerminalRenderer } from '../webgl/renderer.js'
import { displayedPixels } from '../webgl/tests/fixture.js'
import type { HoldCommand, HoldReply, HoldSnapshot } from './fixtures/held-output.worker.js'

const font = {
  family: 'HeldOutputMono',
  size: 20,
  lineHeight: 1.2,
  weight: 400,
  boldWeight: 700,
  letterSpacing: 0,
}
const fontUrl = new URL(
  '../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2',
  import.meta.url,
).href
const wasmUrl = new URL('../../../ghostty-vt.wasm', import.meta.url).href
const bridgeUrl = new URL('../../../bridge.wasm', import.meta.url).href
const oldColor = [41, 91, 151, 255]
const heldColor = [181, 71, 31, 255]
const canceledColor = [61, 171, 101, 255]

interface HoldActor {
  write(color: readonly number[], held?: boolean): Promise<void>
  queue(): Promise<void>
  stimulate(): Promise<void>
  release(): Promise<void>
  read(): Promise<HoldSnapshot>
  dispose(): Promise<void>
  frames(): Promise<number>
}

function output(color: readonly number[]): string {
  return `\x1b[2;3H\x1b[48;2;${color[0]};${color[1]};${color[2]}m \x1b[0m`
}

async function outsideFrames(): Promise<void> {
  for (let frame = 0; frame < 3; frame++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

async function mainActor(host: HTMLDivElement): Promise<HoldActor> {
  const clock = new HeldRenderClock(browserRenderClock())
  let renderer: WebGlTerminalRenderer
  let canvas: HTMLCanvasElement
  let centre: { x: number; y: number }
  const options: GhosttyWebGpuTerminalFromSessionOptions = {
    runtime: { kind: 'owned', options: { wasm: wasmUrl, bridge: bridgeUrl } },
    appearance: { grid: { columns: 24, rows: 4 }, font, cursor: { blink: false } },
    autoFit: false,
    accessibility: false,
    rendererFactory: async (options) => {
      canvas = options.canvas as HTMLCanvasElement
      centre = {
        x: Math.floor(2.5 * options.font.deviceCellWidth),
        y: Math.floor(1.5 * options.font.deviceCellHeight),
      }
      renderer = await WebGlTerminalRenderer.create({ ...options, schedulerClock: clock })
      return renderer
    },
  }
  const terminal = await Terminal.create(options)
  try {
    await terminal.open(host)
  } catch (cause) {
    terminal.dispose()
    clock.dispose()
    throw cause
  }
  terminal.write('\x1b[?25l\x1b[2J\x1b[H')
  return {
    async write(color, held = false) {
      if (held) clock.hold()
      terminal.write(output(color))
    },
    async queue() {
      renderer.schedule()
    },
    async stimulate() {
      renderer.notifyWrite()
      renderer.schedule()
    },
    async release() {
      clock.release()
      renderer.notifyWrite()
    },
    async read() {
      const pixels = await renderer.capturePixels()
      const offset = (centre.y * canvas.width + centre.x) * 4
      return {
        color: Array.from(pixels.subarray(offset, offset + 4)),
        frames: renderer.metrics.submittedFrames,
      }
    },
    async dispose() {
      terminal.dispose()
      clock.dispose()
    },
    async frames() {
      return renderer.metrics.submittedFrames
    },
  }
}

async function workerActor(host: HTMLDivElement): Promise<HoldActor> {
  const canvas = document.createElement('canvas')
  host.append(canvas)
  const worker = new Worker(new URL('./fixtures/held-output.worker.ts', import.meta.url), {
    type: 'module',
  })
  const pending = new Map<
    number,
    { resolve(reply: HoldReply): void; reject(cause: unknown): void }
  >()
  let id = 0
  let frames = 0
  worker.onmessage = ({ data }: MessageEvent<HoldReply & { frames: number }>) => {
    const waiter = pending.get(data.id)
    pending.delete(data.id)
    frames = data.frames
    if (data.failure) waiter?.reject(createGhosttyError('held worker fixture', data.failure))
    else waiter?.resolve(data)
  }
  worker.onerror = (event) => {
    for (const waiter of pending.values())
      waiter.reject(createGhosttyError('held worker fixture', event.message))
    pending.clear()
  }
  async function send(
    command: HoldCommand | 'init',
    payload: object = {},
    transfer: Transferable[] = [],
  ) {
    const requestId = ++id
    return await new Promise<HoldReply>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId)
        reject(createGhosttyError('held worker fixture', 'The worker reply timed out'))
      }, 3_000)
      pending.set(requestId, {
        resolve(reply) {
          clearTimeout(timeout)
          resolve(reply)
        },
        reject(cause) {
          clearTimeout(timeout)
          reject(cause)
        },
      })
      worker.postMessage({ id: requestId, command, ...payload }, transfer)
    })
  }
  const offscreen = canvas.transferControlToOffscreen()
  try {
    await send('init', { canvas: offscreen, font, fontUrl, wasmUrl, bridgeUrl }, [offscreen])
  } catch (cause) {
    worker.terminate()
    throw cause
  }
  return {
    async write(color, held = false) {
      await send('write', { output: output(color), held })
    },
    async queue() {
      await send('queue')
    },
    async stimulate() {
      await send('stimulate')
    },
    async release() {
      await send('release')
    },
    async read() {
      return (await send('read')).snapshot!
    },
    async dispose() {
      try {
        await send('dispose')
      } finally {
        worker.terminate()
      }
    },
    async frames() {
      return frames
    },
  }
}

async function xtermActor(host: HTMLDivElement): Promise<HoldActor> {
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = new URL(
    '../../../node_modules/@xterm/xterm/css/xterm.css',
    import.meta.url,
  ).href
  host.append(stylesheet)
  await new Promise<void>((resolve, reject) => {
    stylesheet.onload = () => resolve()
    stylesheet.onerror = (cause) =>
      reject(createGhosttyError('held xterm fixture', 'The stylesheet failed to load', cause))
  })
  const terminal = new Xterm({
    allowProposedApi: true,
    cols: 24,
    rows: 4,
    fontFamily: font.family,
    fontSize: font.size,
    lineHeight: font.lineHeight,
    cursorBlink: false,
    scrollback: 0,
    theme: { foreground: '#ffffff', background: '#000000' },
  })
  terminal.open(host)
  terminal.loadAddon(new WebglAddon())
  let frames = 0
  terminal.onRender(() => {
    frames += 1
  })
  let refreshBeforeHold = false
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (!refreshBeforeHold || !params.includes(2026)) return false
    // Queue beside DEC 2026 so asynchronous parsing precedes the queued animation frame.
    terminal.refresh(0, 3)
    refreshBeforeHold = false
    return false
  })
  const write = (value: string) => new Promise<void>((resolve) => terminal.write(value, resolve))
  await write('\x1b[?25l\x1b[2J\x1b[H')
  const screen = host.querySelector('.xterm-screen') as HTMLDivElement
  const canvas = screen.querySelector('canvas')!
  return {
    async write(color, held = false) {
      await write(`${held ? '\x1b[?2026h' : ''}${output(color)}`)
    },
    async queue() {
      refreshBeforeHold = true
    },
    async stimulate() {
      terminal.refresh(0, 3)
    },
    async release() {
      await write('\x1b[?2026l')
    },
    async read() {
      const pixels = await displayedPixels(canvas)
      const x = Math.floor((screen.clientWidth / 24) * 2.5)
      const y = Math.floor((screen.clientHeight / 4) * 1.5)
      const offset = (y * canvas.width + x) * 4
      return { color: Array.from(pixels.subarray(offset, offset + 4)), frames }
    },
    async dispose() {
      terminal.dispose()
    },
    async frames() {
      return frames
    },
  }
}

for (const [name, create] of [
  ['main', mainActor],
  ['prototype worker', workerActor],
  ['xterm', xtermActor],
] as const) {
  it(`holds and releases actual ${name} terminal pixels`, async () => {
    await page.viewport(800, 600)
    const host = document.createElement('div')
    document.body.append(host)
    const face = await new FontFace(font.family, `url(${fontUrl})`).load()
    document.fonts.add(face)
    let actor: HoldActor | undefined
    let disposed = false
    try {
      actor = await create(host)
      await actor.write(oldColor)
      await expect.poll(async () => (await actor!.read()).color).toEqual(oldColor)
      const normal = await actor.read()
      await actor.queue()
      await actor.write(heldColor, true)
      await actor.stimulate()
      await outsideFrames()
      const held = await actor.read()
      expect(held.color).toEqual(oldColor)
      expect(held.frames).toBe(normal.frames)
      await actor.stimulate()
      await outsideFrames()
      expect((await actor.read()).color).toEqual(oldColor)
      await actor.release()
      await expect.poll(async () => (await actor!.read()).color).toEqual(heldColor)
      await outsideFrames()
      const released = await actor.read()
      expect(released.frames).toBe(normal.frames + 1)
      await actor.queue()
      await actor.write(canceledColor, true)
      await actor.stimulate()
      await outsideFrames()
      expect((await actor.read()).color).toEqual(heldColor)
      const beforeDispose = await actor.frames()
      await actor.dispose()
      disposed = true
      await outsideFrames()
      expect(await actor.frames()).toBe(beforeDispose)
    } finally {
      if (actor && !disposed) await actor.dispose()
      host.remove()
      document.fonts.delete(face)
    }
  }, 15_000)
}
