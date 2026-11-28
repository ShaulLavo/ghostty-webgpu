import {
  type GhosttyTerminal,
  normalizeScrollbackLimit,
  normalizeTerminalSize,
} from '../core/terminal.js'
import { normalizeCellGeometry, type RgbColor, type TerminalSize } from '../core/types.js'
import { normalizeFontMetrics } from './font-metrics.js'
import { defaultRendererTheme } from './theme.js'
import type {
  TerminalAppearance,
  TerminalAppearanceOptions,
  TerminalColor,
  TerminalColorScheme,
  TerminalCursorSettings,
  TerminalFontSettings,
  TerminalGrid,
  TerminalRendererTheme,
  TerminalTheme,
} from './types.js'

const paletteLength = 256

type CanonicalTerminalRendererTheme = TerminalRendererTheme & {
  readonly cursorText: TerminalColor
}

export const defaultGrid: TerminalGrid = Object.freeze({
  cellHeight: 16,
  cellWidth: 8,
  columns: 80,
  pixelRatio: 1,
  rows: 24,
})

const defaultFont: TerminalFontSettings = Object.freeze({
  boldWeight: 700,
  family: 'monospace',
  letterSpacing: 0,
  lineHeight: 1.2,
  size: 14,
  weight: 400,
})

const defaultCursor: TerminalCursorSettings = Object.freeze({
  blink: false,
  style: 'block',
})

function validatePositive(name: string, value: number, integer: boolean): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`)
  }
  if (!integer || Number.isInteger(value)) return value
  throw new RangeError(`${name} must be a positive integer`)
}

function validateColorChannel(name: string, value: number): number {
  if (Number.isInteger(value) && value >= 0 && value <= 0xff) return value
  throw new RangeError(`${name} must be an integer from 0 to 255`)
}

function validateNonNegative(name: string, value: number): number {
  if (Number.isFinite(value) && value >= 0) return value
  throw new RangeError(`${name} must be a finite non-negative number`)
}

function validateFinite(name: string, value: number): number {
  if (Number.isFinite(value)) return value
  throw new RangeError(`${name} must be finite`)
}

function validateFontWeight(name: string, value: number): number {
  if (Number.isInteger(value) && value >= 1 && value <= 1000) return value
  throw new RangeError(`${name} must be an integer from 1 to 1000`)
}

function validateLineHeight(value: number): number {
  if (Number.isFinite(value) && value >= 0.5) return value
  throw new RangeError('font.lineHeight must be finite and at least 0.5')
}

function copyColor(color: RgbColor, name: string): TerminalColor {
  return Object.freeze({
    b: validateColorChannel(`${name}.b`, color.b),
    g: validateColorChannel(`${name}.g`, color.g),
    r: validateColorChannel(`${name}.r`, color.r),
  })
}

function copyPalette(palette: readonly RgbColor[]): readonly TerminalColor[] {
  if (palette.length !== paletteLength) {
    throw new RangeError(`theme.palette must contain exactly ${paletteLength} colors`)
  }
  return Object.freeze(palette.map((color, index) => copyColor(color, `theme.palette[${index}]`)))
}

function copyRendererTheme(theme: TerminalTheme): CanonicalTerminalRendererTheme {
  return Object.freeze({
    background: theme.background,
    cursor: theme.cursor,
    cursorText: theme.cursorText ?? theme.background,
    foreground: theme.foreground,
    minimumContrast: theme.minimumContrast,
    selectionBackground: theme.selectionBackground,
    selectionForeground: theme.selectionForeground,
  })
}

function copyOptionalCursorText(theme: TerminalTheme): Readonly<{ cursorText?: TerminalColor }> {
  if (theme.cursorText === undefined) return Object.freeze({})
  return Object.freeze({ cursorText: copyColor(theme.cursorText, 'theme.cursorText') })
}

function copyTheme(theme: TerminalTheme): TerminalTheme {
  const minimumContrast = validateNonNegative('theme.minimumContrast', theme.minimumContrast)
  return Object.freeze({
    background: copyColor(theme.background, 'theme.background'),
    cursor: copyColor(theme.cursor, 'theme.cursor'),
    ...copyOptionalCursorText(theme),
    foreground: copyColor(theme.foreground, 'theme.foreground'),
    minimumContrast,
    palette: copyPalette(theme.palette),
    selectionBackground: copyColor(theme.selectionBackground, 'theme.selectionBackground'),
    selectionForeground: copyColor(theme.selectionForeground, 'theme.selectionForeground'),
  })
}

export function normalizeGrid(
  current: TerminalGrid,
  next: Partial<TerminalGrid> = {},
): TerminalGrid {
  const geometry = normalizeCellGeometry({
    cellHeight: next.cellHeight ?? current.cellHeight,
    cellWidth: next.cellWidth ?? current.cellWidth,
    pixelRatio: next.pixelRatio ?? current.pixelRatio,
  })
  return Object.freeze({
    cellHeight: geometry.cellHeight,
    cellWidth: geometry.cellWidth,
    columns: validatePositive('grid.columns', next.columns ?? current.columns, true),
    pixelRatio: geometry.pixelRatio,
    rows: validatePositive('grid.rows', next.rows ?? current.rows, true),
  })
}

export function nativeGrid(grid: TerminalGrid): TerminalSize {
  const geometry = normalizeCellGeometry(grid)
  return {
    cellHeight: geometry.deviceCellHeight,
    cellWidth: geometry.deviceCellWidth,
    columns: grid.columns,
    rows: grid.rows,
  }
}

function updatedFontMetrics(current: TerminalFontSettings, next: Partial<TerminalFontSettings>) {
  if ('metrics' in next) return normalizeFontMetrics(next.metrics)
  if (next.family !== undefined && next.family !== current.family) return undefined
  if (next.weight !== undefined && next.weight !== current.weight) return undefined
  return current.metrics
}

function normalizeFont(
  current: TerminalFontSettings,
  next: Partial<TerminalFontSettings> = {},
): TerminalFontSettings {
  const family = next.family ?? current.family
  if (typeof family !== 'string' || family.length === 0) {
    throw new TypeError('font.family must be a non-empty string')
  }
  const metrics = updatedFontMetrics(current, next)
  return Object.freeze({
    ...(metrics ? { metrics } : {}),
    boldWeight: validateFontWeight('font.boldWeight', next.boldWeight ?? current.boldWeight),
    family: family.slice(),
    letterSpacing: validateFinite(
      'font.letterSpacing',
      next.letterSpacing ?? current.letterSpacing,
    ),
    lineHeight: validateLineHeight(next.lineHeight ?? current.lineHeight),
    size: validatePositive('font.size', next.size ?? current.size, false),
    weight: validateFontWeight('font.weight', next.weight ?? current.weight),
  })
}

function normalizeCursor(
  current: TerminalCursorSettings,
  next: Partial<TerminalCursorSettings> = {},
): TerminalCursorSettings {
  const blink = next.blink ?? current.blink
  const style = next.style ?? current.style
  if (typeof blink !== 'boolean') throw new TypeError('cursor.blink must be a boolean')
  if (style === 'bar' || style === 'block' || style === 'outline' || style === 'underline') {
    return Object.freeze({ blink, style })
  }
  throw new TypeError(`Unknown cursor style: ${String(style)}`)
}

export function normalizeColorScheme(value: TerminalColorScheme): TerminalColorScheme {
  if (value === 'dark' || value === 'light') return value
  throw new TypeError(`Unknown color scheme: ${String(value)}`)
}

function normalizeBackgroundOpacity(value: number): number {
  if (Number.isFinite(value) && value >= 0 && value <= 1) return value
  throw new TypeError(`backgroundOpacity must be between 0 and 1: ${String(value)}`)
}

function createDefaultTheme(terminal: GhosttyTerminal): TerminalTheme {
  return copyTheme({ ...defaultRendererTheme, palette: terminal.defaultPalette })
}

export function createAppearance(
  terminal: GhosttyTerminal,
  grid: TerminalGrid,
  options: TerminalAppearanceOptions = {},
): TerminalAppearance {
  const theme = options.theme ? copyTheme(options.theme) : createDefaultTheme(terminal)
  return freezeAppearance({
    backgroundOpacity: normalizeBackgroundOpacity(options.backgroundOpacity ?? 1),
    colorScheme: normalizeColorScheme(options.colorScheme ?? 'dark'),
    cursor: normalizeCursor(defaultCursor, options.cursor),
    font: normalizeFont(defaultFont, options.font),
    grid,
    rendererTheme: copyRendererTheme(theme),
    scrollbackByteLimit: options.scrollbackByteLimit ?? terminal.scrollbackByteLimit,
    scrollbackLimit: options.scrollbackLimit,
    theme,
  })
}

export function freezeAppearance(appearance: TerminalAppearance): TerminalAppearance {
  normalizeTerminalSize(nativeGrid(appearance.grid))
  return Object.freeze({
    ...appearance,
    scrollbackByteLimit: normalizeScrollbackLimit(
      appearance.scrollbackByteLimit,
      'ghostty_terminal_set(SCROLLBACK_MAX_BYTES)',
    ),
    scrollbackLimit: normalizeScrollbackLimit(
      appearance.scrollbackLimit,
      'ghostty_terminal_set(SCROLLBACK_MAX_LINES)',
    ),
  })
}

export function mergeAppearance(
  current: TerminalAppearance,
  options: TerminalAppearanceOptions,
): TerminalAppearance {
  const theme = options.theme ? copyTheme(options.theme) : current.theme
  return freezeAppearance({
    backgroundOpacity: normalizeBackgroundOpacity(
      options.backgroundOpacity ?? current.backgroundOpacity,
    ),
    colorScheme: normalizeColorScheme(options.colorScheme ?? current.colorScheme),
    cursor: normalizeCursor(current.cursor, options.cursor),
    font: normalizeFont(current.font, options.font),
    grid: normalizeGrid(current.grid, options.grid),
    rendererTheme: copyRendererTheme(theme),
    scrollbackByteLimit: options.scrollbackByteLimit ?? current.scrollbackByteLimit,
    scrollbackLimit: options.scrollbackLimit ?? current.scrollbackLimit,
    theme,
  })
}

export function withScrollbackLimit(
  current: TerminalAppearance,
  scrollbackLimit: number | undefined,
): TerminalAppearance {
  return freezeAppearance({ ...current, scrollbackLimit })
}

function colorsEqual(first: TerminalColor, second: TerminalColor): boolean {
  return first.r === second.r && first.g === second.g && first.b === second.b
}

function optionalColorsEqual(
  first: TerminalColor | undefined,
  second: TerminalColor | undefined,
): boolean {
  if (!first || !second) return first === second
  return colorsEqual(first, second)
}

function palettesEqual(first: readonly TerminalColor[], second: readonly TerminalColor[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (!colorsEqual(first[index]!, second[index]!)) return false
  }
  return true
}

export function themesEqual(first: TerminalTheme, second: TerminalTheme): boolean {
  return (
    first.minimumContrast === second.minimumContrast &&
    colorsEqual(first.background, second.background) &&
    colorsEqual(first.cursor, second.cursor) &&
    optionalColorsEqual(first.cursorText, second.cursorText) &&
    colorsEqual(first.foreground, second.foreground) &&
    colorsEqual(first.selectionBackground, second.selectionBackground) &&
    colorsEqual(first.selectionForeground, second.selectionForeground) &&
    palettesEqual(first.palette, second.palette)
  )
}

export function gridsEqual(first: TerminalGrid, second: TerminalGrid): boolean {
  return (
    first.cellHeight === second.cellHeight &&
    first.cellWidth === second.cellWidth &&
    first.columns === second.columns &&
    first.pixelRatio === second.pixelRatio &&
    first.rows === second.rows
  )
}

function fontsEqual(first: TerminalFontSettings, second: TerminalFontSettings): boolean {
  return (
    first.boldWeight === second.boldWeight &&
    first.family === second.family &&
    first.letterSpacing === second.letterSpacing &&
    first.lineHeight === second.lineHeight &&
    first.size === second.size &&
    first.weight === second.weight
  )
}

export function cursorsEqual(
  first: TerminalCursorSettings,
  second: TerminalCursorSettings,
): boolean {
  return first.blink === second.blink && first.style === second.style
}

export function appearancesEqual(first: TerminalAppearance, second: TerminalAppearance): boolean {
  return (
    first.backgroundOpacity === second.backgroundOpacity &&
    first.colorScheme === second.colorScheme &&
    first.scrollbackByteLimit === second.scrollbackByteLimit &&
    first.scrollbackLimit === second.scrollbackLimit &&
    gridsEqual(first.grid, second.grid) &&
    fontsEqual(first.font, second.font) &&
    cursorsEqual(first.cursor, second.cursor) &&
    themesEqual(first.theme, second.theme)
  )
}
