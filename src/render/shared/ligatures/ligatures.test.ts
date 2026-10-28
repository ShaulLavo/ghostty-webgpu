import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CellStyle, RenderCell } from '../../../core/types.js'
import { loadGsubLigatureFinder, type LigatureFinder } from './finder.js'
import { ligatureRuns } from './runs.js'

const root = join(import.meta.dirname, '../../../..')
const fontFile = (path: string) => readFile(join(root, path))
const jetBrainsWoff =
  'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal'
const noto = 'bench/fixtures/correctness/NotoSansMono-Regular.ttf'

function points(text: string): number[] {
  return Array.from(text, (character) => character.codePointAt(0)!)
}

function cells(text: string, overrides: Record<number, Partial<RenderCell>> = {}): RenderCell[] {
  const result: RenderCell[] = []
  for (const character of text) {
    const x = result.length
    result.push({ continuation: false, selected: false, text: character, x, ...overrides[x] })
    if ((character.codePointAt(0) ?? 0) < 0x1100) continue
    result.push({ continuation: true, selected: false, text: '', x: x + 1 })
  }
  return result
}

const plain: CellStyle = {
  blink: false,
  bold: false,
  faint: false,
  invisible: false,
  inverse: false,
  italic: false,
  overline: false,
  strikethrough: false,
  underline: 0,
}

describe('GSUB ligature finder', () => {
  it.each(['woff', 'woff2'])('finds JetBrains Mono joining ranges from %s', async (format) => {
    const finder = await loadGsubLigatureFinder(await fontFile(`${jetBrainsWoff}.${format}`))
    expect(finder.find(points('=>'))).toEqual([[0, 2]])
    expect(finder.find(points('==='))).toEqual([[0, 3]])
    expect(finder.find(points('<=>'))).toEqual([[0, 3]])
    expect(finder.find(points('a=>b'))).toEqual([[1, 3]])
    expect(finder.find(points('office'))).toEqual([])
  })

  it('finds no ranges in a font without joining features', async () => {
    const finder = await loadGsubLigatureFinder(await fontFile(noto))
    expect(finder.find(points('=>'))).toEqual([])
    expect(finder.find(points('<=>'))).toEqual([])
  })
})

describe('ligature run policy', async () => {
  const finder: LigatureFinder = await loadGsubLigatureFinder(
    await fontFile(`${jetBrainsWoff}.woff`),
  )

  it('maps the programming row to cell ranges', () => {
    expect(ligatureRuns(cells('=> != -> === <=>'), finder, undefined)).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
      [9, 12],
      [13, 16],
    ])
  })

  it.each([
    [1, []],
    [2, []],
    [0, [[1, 3]]],
    [3, [[1, 3]]],
  ])('keeps a run separate only with the cursor at column %i inside it', (cursor, expected) => {
    expect(ligatureRuns(cells('a=>b'), finder, cursor)).toEqual(expected)
  })

  it('splits partial selections and keeps a uniform selection joined', () => {
    const row = (selected: number[]) =>
      cells('a=>b', Object.fromEntries(selected.map((x) => [x, { selected: true }])))
    expect(ligatureRuns(row([1]), finder, undefined)).toEqual([])
    expect(ligatureRuns(row([2]), finder, undefined)).toEqual([])
    expect(ligatureRuns(row([1, 2]), finder, undefined)).toEqual([[1, 3]])
  })

  it('breaks at ink changes but not at a background change', () => {
    const red = { r: 255, g: 0, b: 0 }
    const styled = (cell: Partial<RenderCell>) => cells('a=>b', { 2: cell })
    expect(ligatureRuns(styled({ foreground: red }), finder, undefined)).toEqual([])
    expect(ligatureRuns(styled({ style: { ...plain, bold: true } }), finder, undefined)).toEqual([])
    expect(ligatureRuns(styled({ style: { ...plain, underline: 1 } }), finder, undefined)).toEqual(
      [],
    )
    expect(ligatureRuns(styled({ background: red }), finder, undefined)).toEqual([[1, 3]])
    expect(ligatureRuns(styled({ background: red, style: plain }), finder, undefined)).toEqual([
      [1, 3],
    ])
  })

  it('breaks at a background change when backgrounds adjust ink', () => {
    const white = { r: 255, g: 255, b: 255 }
    const row = cells('a=>b', { 2: { background: white, style: plain } })
    expect(ligatureRuns(row, finder, undefined, true)).toEqual([])
    expect(
      ligatureRuns(
        cells('a=>b', { 1: { background: white }, 2: { background: white } }),
        finder,
        undefined,
        true,
      ),
    ).toEqual([[1, 3]])
  })

  it('keeps fallback, wide and color glyphs out of runs', () => {
    expect(ligatureRuns(cells('a=>🙂!=b'), finder, undefined)).toEqual([
      [1, 3],
      [5, 7],
    ])
    expect(ligatureRuns(cells('a界=>b'), finder, undefined)).toEqual([[3, 5]])
    expect(ligatureRuns(cells('a=界>b'), finder, undefined)).toEqual([])
    expect(ligatureRuns(cells('=>🙂!='), finder, undefined)).toEqual([
      [0, 2],
      [4, 6],
    ])
  })

  it('keeps symbols and box drawing per cell', () => {
    const always: LigatureFinder = { find: (codepoints) => [[0, codepoints.length]] }
    expect(ligatureRuns(cells('→→'), always, undefined)).toEqual([])
    expect(ligatureRuns(cells('──'), always, undefined)).toEqual([])
    expect(ligatureRuns(cells('ab'), always, undefined)).toEqual([[0, 2]])
  })

  it('keeps fi, fl and st apart', () => {
    expect(ligatureRuns(cells('office float st =>'), finder, undefined)).toEqual([[16, 18]])
  })
})
