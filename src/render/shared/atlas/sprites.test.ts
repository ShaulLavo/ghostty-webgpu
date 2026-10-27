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

for (const size of [14, 16, 18, 20, 24, 28, 32]) {
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
        Math.max(1, Math.ceil(underlineThickness * ((size * pixelRatio) / unitsPerEm))),
      )
    })
  }
}
