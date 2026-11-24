import { afterEach, beforeAll, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { testFontUrl } from '../../tests/fonts.js'
import { WebGlTerminalRenderer } from './renderer.js'
import { TestClock, fittedFont } from './tests/fixture.js'

// Two faces with different shapes for C; the fitted font fixes geometry, so only the face differs.
const mono = testFontUrl
const blocks = new URL('../tests/fixtures/intrinsic-colors.ttf', import.meta.url).href
const loaded = new Map<string, ArrayBuffer>()
const disposables: (() => void)[] = []

beforeAll(async () => {
  for (const url of [mono, blocks]) loaded.set(url, await (await fetch(url)).arrayBuffer())
})

afterEach(() => {
  for (const dispose of disposables.splice(0).reverse()) dispose()
})

async function face(family: string, url: string): Promise<FontFace> {
  return new FontFace(family, loaded.get(url)!).load()
}

function addFace(face: FontFace): void {
  document.fonts.add(face)
  disposables.push(() => document.fonts.delete(face))
}

// Paints `text` in a fresh WebGL terminal whose canvas lives in `host`, and returns its pixels.
async function paint(family: string, text: string, host: Document = document) {
  const runtime = await GhosttyRuntime.create()
  disposables.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
  const state = runtime.createRenderState(terminal)
  const canvas = host.createElement('canvas')
  host.body.append(canvas)
  disposables.push(() => canvas.remove())
  const clock = new TestClock()
  const font = fittedFont()
  const renderer = await WebGlTerminalRenderer.create({
    canvas,
    columns: 4,
    rows: 1,
    renderState: state,
    font: { ...font, settings: { ...font.settings, family: `"${family}"` } },
    schedulerClock: clock,
  })
  disposables.push(() => renderer.dispose())
  const write = async (value: string) => {
    terminal.write(value)
    renderer.notifyWrite()
    clock.flushFrame()
    return renderer.capturePixels()
  }
  return { pixels: await write(`\x1b[?25l${text}`), write }
}

it('does not keep a glyph drawn with a swapped face under the restored face', async () => {
  const original = await face('W8 Swap', mono)
  const replacement = await face('W8 Swap', blocks)
  addFace(await face('W8 Swap Reference', mono))
  const expected = (await paint('W8 Swap Reference', 'C')).pixels
  addFace(original)
  const live = await paint('W8 Swap', 'M')
  // Programmatic face changes fire no loading events.
  document.fonts.delete(original)
  addFace(replacement)
  await live.write('C')
  document.fonts.delete(replacement)
  addFace(original)
  expect((await paint('W8 Swap', 'C')).pixels).toEqual(expected)
})

it('keys shared glyphs on the faces that draw them, not the canvas document', async () => {
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  disposables.push(() => iframe.remove())
  const frame = iframe.contentDocument!
  const before = await face('W8 Frame', mono)
  addFace(before)
  await paint('W8 Frame', 'C', frame)
  // The iframe's own face set stays unchanged while the drawing realm's face is replaced.
  document.fonts.delete(before)
  addFace(await face('W8 Frame', blocks))
  addFace(await face('W8 Frame Reference', blocks))
  const expected = (await paint('W8 Frame Reference', 'C')).pixels
  expect((await paint('W8 Frame', 'C', frame)).pixels).toEqual(expected)
})
