import type { TerminalSession } from '../term/session.js'
import type {
  TerminalAppearanceOptions,
  TerminalColor,
  TerminalFontSettings,
  TerminalTheme,
} from '../term/types.js'
import type { ITheme } from './types.js'
import type { TerminalOptionKey, TerminalOptionValues } from './options.js'

const themePaletteKeys = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const satisfies readonly (keyof ITheme)[]

const fontOptionKeys = new Set<TerminalOptionKey>([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontWeightBold',
  'letterSpacing',
  'lineHeight',
])

function colorChannel(value: string): number | undefined {
  const channel = Number(value.trim())
  if (!Number.isFinite(channel)) return undefined
  return Math.max(0, Math.min(255, Math.round(channel)))
}

function hexColor(value: string): TerminalColor | undefined {
  const match = value.match(/^#([\da-f]{3}|[\da-f]{6})$/iu)
  const digits = match?.[1]
  if (!digits) return undefined
  const expanded = digits.length === 3 ? [...digits].map((part) => part + part).join('') : digits
  return Object.freeze({
    b: Number.parseInt(expanded.slice(4, 6), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    r: Number.parseInt(expanded.slice(0, 2), 16),
  })
}

function rgbColor(value: string): TerminalColor | undefined {
  const match = value.match(/^rgba?\(([^)]+)\)$/iu)
  const parts = match?.[1]?.split(',')
  if (!parts || parts.length < 3) return undefined
  const red = colorChannel(parts[0] ?? '')
  const green = colorChannel(parts[1] ?? '')
  const blue = colorChannel(parts[2] ?? '')
  if (red === undefined || green === undefined || blue === undefined) return undefined
  return Object.freeze({ b: blue, g: green, r: red })
}

export function parseXtermColor(value: string | undefined): TerminalColor | undefined {
  if (!value) return undefined
  return hexColor(value.trim()) ?? rgbColor(value.trim())
}

function numericFontWeight(value: TerminalOptionValues['fontWeight']): number {
  if (typeof value === 'number') return Math.round(value)
  if (value === 'normal') return 400
  if (value === 'bold') return 700
  return Number.parseInt(value, 10)
}

function nativeFont(values: TerminalOptionValues): TerminalFontSettings {
  return {
    boldWeight: numericFontWeight(values.fontWeightBold),
    family: values.fontFamily,
    letterSpacing: values.letterSpacing,
    lineHeight: values.lineHeight,
    size: values.fontSize,
    weight: numericFontWeight(values.fontWeight),
  }
}

export function initialAppearance(
  values: TerminalOptionValues,
  cols: number,
  rows: number,
): TerminalAppearanceOptions {
  return {
    cursor: { blink: values.cursorBlink, style: values.cursorStyle },
    font: nativeFont(values),
    grid: { columns: cols, rows },
    scrollbackLimit: values.scrollback,
  }
}

function replaceColor(current: TerminalColor, value: string | undefined): TerminalColor {
  return parseXtermColor(value) ?? current
}

function mappedPalette(current: readonly TerminalColor[], theme: ITheme): readonly TerminalColor[] {
  const palette = current.slice()
  for (const [index, key] of themePaletteKeys.entries()) {
    palette[index] = replaceColor(palette[index] as TerminalColor, theme[key] as string | undefined)
  }
  const extended = theme.extendedAnsi ?? []
  for (let index = 0; index < extended.length && index + 16 < palette.length; index += 1) {
    palette[index + 16] = replaceColor(palette[index + 16] as TerminalColor, extended[index])
  }
  return Object.freeze(palette)
}

function nativeTheme(
  current: TerminalTheme,
  theme: ITheme,
  minimumContrast: number,
): TerminalTheme {
  return {
    background: replaceColor(current.background, theme.background),
    cursor: replaceColor(current.cursor, theme.cursor),
    foreground: replaceColor(current.foreground, theme.foreground),
    minimumContrast,
    palette: mappedPalette(current.palette, theme),
    selectionBackground: replaceColor(current.selectionBackground, theme.selectionBackground),
    selectionForeground: replaceColor(current.selectionForeground, theme.selectionForeground),
  }
}

function hasAny(
  keys: readonly TerminalOptionKey[],
  candidates: ReadonlySet<TerminalOptionKey>,
): boolean {
  return keys.some((key) => candidates.has(key))
}

export function applyTerminalOptions(
  session: TerminalSession<Event>,
  values: TerminalOptionValues,
  keys: readonly TerminalOptionKey[],
): void {
  const font = hasAny(keys, fontOptionKeys) ? nativeFont(values) : undefined
  const cursor =
    keys.includes('cursorBlink') || keys.includes('cursorStyle')
      ? { blink: values.cursorBlink, style: values.cursorStyle }
      : undefined
  const scrollbackLimit = keys.includes('scrollback') ? values.scrollback : undefined
  const theme =
    keys.includes('theme') || keys.includes('minimumContrastRatio')
      ? nativeTheme(session.appearance.theme, values.theme, values.minimumContrastRatio)
      : undefined
  const appearance: TerminalAppearanceOptions = {
    ...(cursor ? { cursor } : {}),
    ...(font ? { font } : {}),
    ...(scrollbackLimit !== undefined ? { scrollbackLimit } : {}),
    ...(theme ? { theme } : {}),
  }
  if (Object.keys(appearance).length === 0) return
  session.setAppearance(appearance)
}

export function applyAllTerminalOptions(
  session: TerminalSession<Event>,
  values: TerminalOptionValues,
): void {
  applyTerminalOptions(session, values, [
    'cursorBlink',
    'cursorStyle',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontWeightBold',
    'letterSpacing',
    'lineHeight',
    'minimumContrastRatio',
    'scrollback',
    'theme',
  ])
}
