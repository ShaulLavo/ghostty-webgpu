import type { RenderRow } from '../types.js'
import type { AtlasGlyph, GlyphRasterizationInput } from '../../render/atlas/types.js'
import { contrastAdjustedColor } from '../../render/contrast.js'
import type { CanonicalRendererTheme } from '../../render/instances/types.js'

export const zigFrameContents = [
  'plain ASCII abc 123',
  '\x1b[31;44mANSI\x1b[0m default',
  '\x1b[38;5;202;48;5;17mindexed',
  '\x1b[38;2;19;91;173;48;2;31;42;53mtruecolor',
  '\x1b[1;3;2;4;7;9;53mstyled\x1b[0m\x1b[8mhidden',
] as const

export const zigUnicodeFixtures: readonly Readonly<{ name: string; content: string }>[] = [
  { name: 'ASCII', content: 'ASCII abc XYZ 0123 !@#' },
  { name: 'accented Latin', content: 'café naïve Ångström ç ÿ' },
  { name: 'box drawing', content: '┌─┬─┐│╬│└─┴─┘ ╭╮╰╯' },
  { name: 'Nerd Font and Powerline', content: '   ' },
  { name: 'CJK wide', content: 'A界B漢字C日本語D' },
  { name: 'combining marks', content: 'é ä́ ñ x̧́' },
  { name: 'emoji ZWJ and variation', content: '👩‍💻 👨‍👩‍👧‍👦 ❤️ 🏳️‍🌈' },
  { name: 'legacy emoji segmentation', content: '\x1b[?2027l👩‍💻 👨‍👩‍👧‍👦' },
  { name: 'emoji modifiers and flags', content: '👍🏽 🇯🇵 🧑🏿‍🚀' },
  { name: 'styled Unicode', content: '\x1b[1;3m界éé👩‍💻\x1b[0m' },
  { name: 'colored Unicode', content: '\x1b[38;2;19;91;173;48;2;31;42;53m界é👩‍💻\x1b[0m' },
]

export const zigGlyphCollisionFixtures: readonly Readonly<{ name: string; content: string }>[] = [
  { name: 'full codepoints with equal low seven bits', content: 'AÁŁ' },
  { name: 'supplementary codepoints with equal low sixteen bits', content: '\u{1f600}\u{2f600}' },
  { name: 'combining sequences sharing a base', content: 'e é è ȩ́' },
  { name: 'ZWJ sequences sharing an emoji prefix', content: '👩 👩‍💻 👩‍🚀' },
  { name: 'bold and italic Unicode keys', content: 'é\x1b[1mé\x1b[0;3mé\x1b[1mé\x1b[0m' },
  {
    name: 'same grapheme with different brushes',
    content: '\x1b[31;44mé\x1b[32;45mé\x1b[7mé\x1b[0m',
  },
]

export const zigFrameCursorStyles = ['block', 'bar', 'underline', 'outline'] as const

// Decode through the styled reader, independently of the native frame's glyph descriptors.
export function expectedGlyphs(rows: readonly RenderRow[], theme: CanonicalRendererTheme) {
  return rows.flatMap((row) =>
    row.cells.flatMap((cell, index) => {
      if (cell.continuation || !cell.text || cell.style?.invisible) return []
      const foreground = cell.foreground ?? theme.foreground
      const background = cell.background ?? theme.background
      const input: GlyphRasterizationInput = {
        text: cell.text,
        cellSpan: row.cells[index + 1]?.continuation ? 2 : 1,
        weight: cell.style?.bold ? 'bold' : 'normal',
        italic: cell.style?.italic ?? false,
        foreground: contrastAdjustedColor(
          cell.style?.inverse ? background : foreground,
          cell.style?.inverse ? foreground : background,
          theme.minimumContrast,
        ),
      }
      return [{ x: cell.x, y: row.y, input }]
    }),
  )
}

const glyph = {
  atlasWidth: 512,
  atlasHeight: 512,
  x: 8,
  y: 12,
  width: 5,
  height: 9,
  offsetX: 1,
  offsetY: 2,
  generation: 1,
  key: 'fixture',
  layer: 0,
  kind: 'grayscale' as const,
  pixels: new Uint8Array(45),
}

export function inputIdentity(input: GlyphRasterizationInput): string {
  return JSON.stringify([
    input.text,
    input.cellSpan,
    input.weight,
    input.italic,
    input.foreground.r,
    input.foreground.g,
    input.foreground.b,
  ])
}

export function fixtureGlyphs(kind: 'color' | 'grayscale') {
  const glyphs = new Map<string, AtlasGlyph>()
  const identityOf = (input: GlyphRasterizationInput) =>
    kind === 'color'
      ? inputIdentity(input)
      : JSON.stringify([input.text, input.cellSpan, input.weight, input.italic])
  const resolveInput = (input: GlyphRasterizationInput): AtlasGlyph => {
    const identity = identityOf(input)
    const existing = glyphs.get(identity)
    if (existing) return existing
    const index = glyphs.size + 1
    const value: AtlasGlyph = {
      ...glyph,
      kind,
      key: identity,
      x: index * 7,
      y: index * 11,
      width: 3 + index,
      height: 5 + index,
    }
    glyphs.set(identity, value)
    return value
  }
  return {
    glyphs,
    identityOf,
    resolveInput,
  }
}
