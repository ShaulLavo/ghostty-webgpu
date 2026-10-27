import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { TerminalFittedFont } from '../../../term/types.js'
import { spriteThickness } from './sprites.js'

const bytes = readFileSync(new URL('./sprite-fixtures/JetBrainsMono-Regular.ttf', import.meta.url))
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
function table(tag: string): number {
  for (let index = 0; index < view.getUint16(4); index++) {
    const entry = 12 + index * 16
    if (bytes.toString('ascii', entry, entry + 4) === tag) return view.getUint32(entry + 8)
  }
  throw new Error(`Missing font table ${tag}`)
}
const unitsPerEm = view.getUint16(table('head') + 18)
const underlineThickness = view.getInt16(table('post') + 10)
const ascent = view.getInt16(table('hhea') + 4)

for (const size of [14, 16, 16.1, 18, 20, 20.1, 24, 28, 32]) {
  for (const pixelRatio of [1, 1.25, 2]) {
    it(`uses the font post metric at size ${size}, DPR ${pixelRatio}`, () => {
      const settings = {
        family: 'JetBrains Mono',
        size,
        weight: 400,
        boldWeight: 700,
        lineHeight: 1.2,
        letterSpacing: 0,
        metrics: { unitsPerEm, underlineThickness },
      }
      const font: TerminalFittedFont = {
        settings,
        pixelRatio,
        charLeft: 0,
        charTop: 0,
        cssCellWidth: 9,
        cssCellHeight: 18,
        deviceCellWidth: Math.round(9 * pixelRatio),
        deviceCellHeight: Math.round(18 * pixelRatio),
        deviceCharWidth: 9,
        deviceCharHeight: 18,
        deviceBaseline: Math.ceil((ascent * size * pixelRatio) / unitsPerEm),
      }
      expect(spriteThickness(font)).toBe(
        Math.max(
          1,
          Math.ceil(underlineThickness * (Math.max(1, Math.round(size * pixelRatio)) / unitsPerEm)),
        ),
      )
    })
  }
}

it('reads and validates the real font tables', async () => {
  const { readSfntFontMetrics } = await import('../../../term/font-metrics.js')
  expect(readSfntFontMetrics(bytes)).toEqual({ unitsPerEm: 1000, underlineThickness: 50 })
  expect(readSfntFontMetrics(bytes.subarray(0, 8))).toBeUndefined()
  const malformed = new Uint8Array(bytes)
  const corrupt = new DataView(malformed.buffer)
  corrupt.setUint32(20, 0xffffffff)
  expect(() => readSfntFontMetrics(malformed)).not.toThrow()
  expect(readSfntFontMetrics(new Uint8Array([0x77, 0x4f, 0x46, 0x32]))).toBeUndefined()
})

it('copies font metadata and invalidates a metric-only renderer font change', async () => {
  const { copyFittedFont, fittedFontsEqual, fittedFontGeometryEquals } =
    await import('../config.js')
  const settings = {
    family: 'JetBrains Mono',
    size: 14,
    weight: 400,
    boldWeight: 700,
    lineHeight: 1.2,
    letterSpacing: 0,
    metrics: { unitsPerEm, underlineThickness },
  }
  const font: TerminalFittedFont = {
    settings,
    pixelRatio: 1,
    charLeft: 0,
    charTop: 0,
    cssCellWidth: 9,
    cssCellHeight: 18,
    deviceCellWidth: 9,
    deviceCellHeight: 18,
    deviceCharWidth: 9,
    deviceCharHeight: 18,
    deviceBaseline: 15,
  }
  const copy = copyFittedFont(font)
  expect(copy.settings.metrics).toEqual(settings.metrics)
  expect(copy.settings.metrics).not.toBe(settings.metrics)
  const next = copyFittedFont({
    ...font,
    settings: { ...settings, metrics: { unitsPerEm, underlineThickness: 75 } },
  })
  expect(fittedFontsEqual(copy, next)).toBe(false)
  expect(fittedFontGeometryEquals(copy, next)).toBe(true)
})

it('reads a changed post value and declines nonpositive metrics', async () => {
  const { readSfntFontMetrics } = await import('../../../term/font-metrics.js')
  const changed = new Uint8Array(bytes)
  const changedView = new DataView(changed.buffer)
  changedView.setInt16(table('post') + 10, 75)
  expect(readSfntFontMetrics(changed)).toEqual({ unitsPerEm: 1000, underlineThickness: 75 })
  changedView.setInt16(table('post') + 10, 0)
  expect(readSfntFontMetrics(changed)).toBeUndefined()
})
