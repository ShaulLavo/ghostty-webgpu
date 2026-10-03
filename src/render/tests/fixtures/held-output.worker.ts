import { HeldRenderClock } from '../../../../bench/held-render-clock.js'
import { createGhosttyError } from '../../../core/error.js'
import { calculateTerminalFittedFont } from '../../../dom/fit.js'
import { TerminalSession } from '../../../term/session.js'
import type { TerminalFontSettings } from '../../../term/types.js'
import { WebGlTerminalRenderer } from '../../webgl/renderer.js'

export type HoldCommand = 'write' | 'queue' | 'stimulate' | 'read' | 'release' | 'dispose'
export interface HoldSnapshot {
  color: number[]
  frames: number
}
export interface HoldReply {
  id: number
  snapshot?: HoldSnapshot
  failure?: string
}

type HoldRequest = { id: number } & (
  | {
      command: 'init'
      canvas: OffscreenCanvas
      font: TerminalFontSettings
      fontUrl: string
      wasmUrl: string
      bridgeUrl: string
    }
  | { command: 'write'; output: string; held: boolean }
  | { command: Exclude<HoldCommand, 'write'> }
)

const scope = globalThis as unknown as {
  fonts: FontFaceSet
  onmessage: ((event: MessageEvent<HoldRequest>) => void) | null
  postMessage(message: HoldReply & { frames?: number }): void
  requestAnimationFrame(callback: () => void): number
  cancelAnimationFrame(handle: number): void
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(handle: number): void
}
const clock = new HeldRenderClock({
  requestFrame: (callback) => scope.requestAnimationFrame(callback),
  cancelFrame: (handle) => scope.cancelAnimationFrame(handle),
  setTimer: (callback, delay) => scope.setTimeout(callback, delay),
  clearTimer: (handle) => scope.clearTimeout(handle),
})
let renderer: WebGlTerminalRenderer
let session: TerminalSession
let canvas: OffscreenCanvas
let centre: { x: number; y: number }

scope.onmessage = async ({ data }) => {
  try {
    if (data.command === 'init') {
      canvas = data.canvas
      const face = await new FontFace(data.font.family, `url(${data.fontUrl})`).load()
      scope.fonts.add(face)
      await scope.fonts.load(`20px "${data.font.family}"`)
      const context = new OffscreenCanvas(128, 64).getContext('2d')!
      context.font = `20px "${data.font.family}"`
      const measured = context.measureText('M')
      const font = calculateTerminalFittedFont(
        data.font as TerminalFontSettings,
        {
          advanceWidth: measured.width,
          fontAscent: measured.fontBoundingBoxAscent,
          fontDescent: measured.fontBoundingBoxDescent,
        },
        1,
      )
      centre = {
        x: Math.floor(2.5 * font.deviceCellWidth),
        y: Math.floor(1.5 * font.deviceCellHeight),
      }
      session = await TerminalSession.create({
        runtime: { kind: 'owned', options: { wasm: data.wasmUrl, bridge: data.bridgeUrl } },
        appearance: {
          grid: { columns: 24, rows: 4 },
          font: font.settings,
          cursor: { blink: false },
        },
      })
      session.write('\x1b[?25l\x1b[2J\x1b[H')
      renderer = await WebGlTerminalRenderer.create({
        canvas,
        columns: 24,
        rows: 4,
        font,
        renderState: session.renderState,
        schedulerClock: clock,
        cursorBlink: false,
      })
    }
    if (data.command === 'write') {
      if (data.held) clock.hold()
      session.write(data.output)
      renderer.notifyWrite()
    }
    if (data.command === 'queue') renderer.schedule()
    if (data.command === 'stimulate') {
      renderer.notifyWrite()
      renderer.schedule()
    }
    if (data.command === 'release') {
      clock.release()
      renderer.notifyWrite()
    }
    if (data.command === 'dispose') {
      renderer.dispose()
      clock.dispose()
      session.dispose()
    }
    let snapshot: HoldSnapshot | undefined
    if (data.command === 'read') {
      const pixels = await renderer.capturePixels()
      const offset = (centre.y * canvas.width + centre.x) * 4
      snapshot = {
        color: Array.from(pixels.slice(offset, offset + 4)),
        frames: renderer.metrics.submittedFrames,
      }
    }
    scope.postMessage({ id: data.id, snapshot, frames: renderer.metrics.submittedFrames })
  } catch (cause) {
    const error = createGhosttyError('held worker fixture', String(cause), cause)
    scope.postMessage({ id: data.id, failure: error.message })
  }
}
