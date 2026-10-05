import { expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { createGhosttyWebGpuTerminalFromSession } from '../../dom/terminal.js'
import type { Terminal } from '../../dom/terminal.js'
import { TerminalSession } from '../../term/session.js'
import { CanvasTerminalRenderer } from './renderer.js'
import { StampTarget } from './stamp-target.js'

function targetFor(renderer: CanvasTerminalRenderer): StampTarget {
  const surface: unknown = Reflect.get(renderer, 'canvasSurface')
  if (typeof surface !== 'object' || surface === null) throw new TypeError('Missing Canvas surface')
  const target: unknown = Reflect.get(surface, 'pixelTarget')
  if (!(target instanceof StampTarget)) throw new TypeError('Missing actual packed Canvas target')
  return target
}

it('repaints cursor-only appearance changes while retaining warm glyph stamps in17 public terminals', async () => {
  const runtime = await GhosttyRuntime.create()
  const host = document.createElement('main')
  document.body.append(host)
  const terminals: Terminal[] = []
  const renderers: CanvasTerminalRenderer[] = []
  const callbacks: number[] = []
  const settle = async () => {
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  }
  const snapshot = () =>
    renderers.map((renderer, index) => ({
      rasterCalls: targetFor(renderer).cache.metrics.rasterCalls,
      hits: targetFor(renderer).cache.metrics.hits,
      repaintedRows: renderer.metrics.repaintedRows,
      frames: renderer.metrics.submittedFrames,
      callbacks: callbacks[index]!,
    }))
  try {
    for (let index = 0; index < 17; index += 1) {
      const element = document.createElement('section')
      element.style.width = '420px'
      element.style.height = '260px'
      host.append(element)
      const session = await TerminalSession.create({
        runtime: { kind: 'borrowed', runtime },
        appearance: {
          grid: { columns: 40, rows: 12 },
          font: { family: 'monospace', size: 12 },
          cursor: { blink: false },
        },
      })
      const terminal = createGhosttyWebGpuTerminalFromSession(session, {
        autoFit: false,
        accessibility: false,
        rendererFactory: async (options) => {
          const renderer = await CanvasTerminalRenderer.create({
            ...options,
            rendererMode: 'canvas2d-pixels',
          })
          renderers.push(renderer)
          return renderer
        },
      })
      terminals.push(terminal)
      callbacks[index] = 0
      terminal.on('frame', () => {
        callbacks[index] = callbacks[index]! + 1
      })
      await terminal.open(element)
      terminal.write('\x1b[?25lCache warm alphabet ABC xyz 0123\r\n\x1b[2m faint é界👩‍💻\x1b[0m')
    }
    await settle()
    expect(snapshot().every((entry) => entry.rasterCalls > 10)).toBe(true)
    for (const terminal of terminals) terminal.refresh(0, 11)
    await settle()
    const before = snapshot()
    for (const terminal of terminals) terminal.setCursor({ style: 'bar' })
    await settle()
    for (const [index, after] of snapshot().entries()) {
      expect(after.rasterCalls).toBe(before[index]!.rasterCalls)
      expect(after.hits).toBeGreaterThan(before[index]!.hits)
      expect(after.repaintedRows - before[index]!.repaintedRows).toBe(12)
      expect(after.frames - before[index]!.frames).toBe(1)
      expect(after.callbacks - before[index]!.callbacks).toBe(1)
    }
  } finally {
    for (const terminal of terminals) terminal.dispose()
    runtime.dispose()
    host.remove()
  }
}, 20000)
