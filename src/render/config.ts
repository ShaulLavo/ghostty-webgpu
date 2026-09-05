import type { TerminalFittedFont } from '../term/types.js'
import {
  defaultRendererTheme,
  type CanonicalRendererTheme,
  type RendererTheme,
} from './instances/types.js'
import type { RenderSchedulerClock } from './scheduler.js'

export interface RendererGridInput {
  readonly columns: number
  readonly rows: number
}

function positiveFinite(name: string, value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError(`${name} must be finite and greater than zero`)
}

function positiveInteger(name: string, value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new RangeError(`${name} must be a positive safe integer`)
}

function nonEmptyString(name: string, value: string): string {
  if (typeof value === 'string' && value.length > 0) return value.slice()
  throw new TypeError(`${name} must be a non-empty string`)
}

function fittedFontWeight(name: string, value: number): number {
  if (Number.isInteger(value) && value >= 1 && value <= 1000) return value
  throw new RangeError(`${name} must be an integer from 1 to 1000`)
}

function fontSettingsEqual(left: TerminalFittedFont, right: TerminalFittedFont): boolean {
  return (
    left.settings.boldWeight === right.settings.boldWeight &&
    left.settings.family === right.settings.family &&
    left.settings.letterSpacing === right.settings.letterSpacing &&
    left.settings.lineHeight === right.settings.lineHeight &&
    left.settings.size === right.settings.size &&
    left.settings.weight === right.settings.weight
  )
}

export function browserRenderClock(): RenderSchedulerClock {
  return {
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    clearTimer: (handle) => window.clearTimeout(handle),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  }
}

export function copyFittedFont(font: TerminalFittedFont): TerminalFittedFont {
  const settings = Object.freeze({
    boldWeight: fittedFontWeight('font.settings.boldWeight', font.settings.boldWeight),
    family: nonEmptyString('font.settings.family', font.settings.family),
    letterSpacing: Number(font.settings.letterSpacing),
    lineHeight: positiveFinite('font.settings.lineHeight', font.settings.lineHeight),
    size: positiveFinite('font.settings.size', font.settings.size),
    weight: fittedFontWeight('font.settings.weight', font.settings.weight),
  })
  if (!Number.isFinite(settings.letterSpacing)) {
    throw new RangeError('font.settings.letterSpacing must be finite')
  }
  if (settings.lineHeight < 1) throw new RangeError('font.settings.lineHeight must be at least 1')
  return Object.freeze({
    charLeft: safeRendererInteger('font.charLeft', font.charLeft, Number.MIN_SAFE_INTEGER),
    charTop: safeRendererInteger('font.charTop', font.charTop),
    cssCellHeight: positiveFinite('font.cssCellHeight', font.cssCellHeight),
    cssCellWidth: positiveFinite('font.cssCellWidth', font.cssCellWidth),
    deviceBaseline: positiveInteger('font.deviceBaseline', font.deviceBaseline),
    deviceCellHeight: positiveInteger('font.deviceCellHeight', font.deviceCellHeight),
    deviceCellWidth: positiveInteger('font.deviceCellWidth', font.deviceCellWidth),
    deviceCharHeight: positiveInteger('font.deviceCharHeight', font.deviceCharHeight),
    deviceCharWidth: positiveInteger('font.deviceCharWidth', font.deviceCharWidth),
    pixelRatio: positiveFinite('font.pixelRatio', font.pixelRatio),
    settings,
  })
}

export function fittedFontsEqual(left: TerminalFittedFont, right: TerminalFittedFont): boolean {
  if (!fontSettingsEqual(left, right)) return false
  return (
    left.charLeft === right.charLeft &&
    left.charTop === right.charTop &&
    left.cssCellHeight === right.cssCellHeight &&
    left.cssCellWidth === right.cssCellWidth &&
    left.deviceBaseline === right.deviceBaseline &&
    left.deviceCellHeight === right.deviceCellHeight &&
    left.deviceCellWidth === right.deviceCellWidth &&
    left.deviceCharHeight === right.deviceCharHeight &&
    left.deviceCharWidth === right.deviceCharWidth &&
    left.pixelRatio === right.pixelRatio
  )
}

export function fittedFontGeometryEquals(
  left: TerminalFittedFont,
  right: TerminalFittedFont,
): boolean {
  return (
    left.cssCellHeight === right.cssCellHeight &&
    left.cssCellWidth === right.cssCellWidth &&
    left.deviceCellHeight === right.deviceCellHeight &&
    left.deviceCellWidth === right.deviceCellWidth &&
    left.pixelRatio === right.pixelRatio
  )
}

export function mergeRendererTheme(theme: Partial<RendererTheme> | undefined): RendererTheme {
  return { ...defaultRendererTheme, ...theme }
}

export function canonicalRendererTheme(theme: RendererTheme): CanonicalRendererTheme {
  return { ...theme, cursorText: theme.cursorText ?? theme.background }
}

export function normalizeRendererGrid(grid: RendererGridInput): RendererGridInput {
  return Object.freeze({
    columns: positiveInteger('columns', grid.columns),
    rows: positiveInteger('rows', grid.rows),
  })
}

export function safeRendererInteger(name: string, value: number, minimum = 0): number {
  if (Number.isSafeInteger(value) && value >= minimum) return value
  throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}`)
}
