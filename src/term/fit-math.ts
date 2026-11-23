import { fontMetricsEqual, normalizeFontMetrics } from './font-metrics.js'
import type { TerminalFittedFont, TerminalFontSettings } from './types.js'

export type TerminalFitFont = TerminalFontSettings

export interface TerminalFontMeasurement {
  readonly advanceWidth: number
  readonly fontAscent: number
  readonly fontDescent: number
}

export interface TerminalFitGrid {
  readonly cellHeight: number
  readonly cellWidth: number
  readonly columns: number
  readonly pixelRatio: number
  readonly rows: number
}

export interface TerminalFitPadding {
  readonly bottom: number
  readonly left: number
  readonly right: number
  readonly top: number
}

export function positiveFinite(name: string, value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError(`${name} must be a finite positive number`)
}

function finite(name: string, value: number): number {
  if (Number.isFinite(value)) return value
  throw new RangeError(`${name} must be finite`)
}

function fontWeight(name: string, value: number): number {
  if (Number.isInteger(value) && value >= 1 && value <= 1000) return value
  throw new RangeError(`${name} must be an integer from 1 to 1000`)
}

function lineHeight(value: number): number {
  if (Number.isFinite(value) && value >= 0.5) return value
  throw new RangeError('font.lineHeight must be finite and at least 0.5')
}

function nonEmptyString(name: string, value: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.slice()
  throw new TypeError(`${name} must be a non-empty string`)
}

export function normalizeFont(font: TerminalFitFont): TerminalFitFont {
  const metrics = normalizeFontMetrics(font.metrics)
  return Object.freeze({
    ...(metrics ? { metrics } : {}),
    boldWeight: fontWeight('font.boldWeight', font.boldWeight),
    family: nonEmptyString('font.family', font.family),
    letterSpacing: finite('font.letterSpacing', font.letterSpacing),
    lineHeight: lineHeight(font.lineHeight),
    size: positiveFinite('font.size', font.size),
    weight: fontWeight('font.weight', font.weight),
  })
}

function positiveSafeInteger(name: string, value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new RangeError(`${name} must be a positive safe integer`)
}

function nonNegativeFinite(name: string, value: number): number {
  if (Number.isFinite(value) && value >= 0) return value
  throw new RangeError(`${name} must be a finite non-negative number`)
}

export function canonicalPixelRatio(value: number): number {
  return positiveFinite('pixelRatio', value)
}

export function calculateTerminalFittedFont(
  rawFont: TerminalFitFont,
  measurement: TerminalFontMeasurement,
  rawPixelRatio: number,
): TerminalFittedFont {
  const settings = normalizeFont(rawFont)
  const pixelRatio = canonicalPixelRatio(rawPixelRatio)
  const advanceWidth = positiveFinite('font advance width', measurement.advanceWidth)
  const ascent = nonNegativeFinite('font ascent', measurement.fontAscent)
  const descent = nonNegativeFinite('font descent', measurement.fontDescent)
  const measuredHeight = positiveFinite('font height', ascent + descent)
  const deviceCharWidth = positiveSafeInteger(
    'device character width',
    Math.floor(advanceWidth * pixelRatio),
  )
  const deviceCharHeight = positiveSafeInteger(
    'device character height',
    Math.ceil(measuredHeight * pixelRatio),
  )
  const deviceSpacing = Math.round(settings.letterSpacing * pixelRatio)
  const deviceCellWidth = positiveSafeInteger('device cell width', deviceCharWidth + deviceSpacing)
  const deviceCellHeight = positiveSafeInteger(
    'device cell height',
    Math.floor(deviceCharHeight * settings.lineHeight),
  )
  const charLeft = Math.floor(deviceSpacing / 2)
  const charTop =
    settings.lineHeight === 1 ? 0 : Math.round((deviceCellHeight - deviceCharHeight) / 2)
  const deviceBaseline = positiveSafeInteger(
    'device baseline',
    charTop + Math.ceil(ascent * pixelRatio),
  )
  return Object.freeze({
    charLeft,
    charTop,
    cssCellHeight: deviceCellHeight / pixelRatio,
    cssCellWidth: deviceCellWidth / pixelRatio,
    deviceBaseline,
    deviceCellHeight,
    deviceCellWidth,
    deviceCharHeight,
    deviceCharWidth,
    pixelRatio,
    settings,
  })
}

export function fontEquals(left: TerminalFitFont, right: TerminalFitFont): boolean {
  return (
    fontMetricsEqual(left.metrics, right.metrics) &&
    left.boldWeight === right.boldWeight &&
    left.family === right.family &&
    left.letterSpacing === right.letterSpacing &&
    left.lineHeight === right.lineHeight &&
    left.size === right.size &&
    left.weight === right.weight
  )
}

export function fittedFontEquals(left: TerminalFittedFont, right: TerminalFittedFont): boolean {
  if (!fontEquals(left.settings, right.settings)) return false
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

export function paddingEquals(left: TerminalFitPadding, right: TerminalFitPadding): boolean {
  return (
    left.bottom === right.bottom &&
    left.left === right.left &&
    left.right === right.right &&
    left.top === right.top
  )
}

export function gridEquals(left: TerminalFitGrid, right: TerminalFitGrid): boolean {
  return (
    left.cellHeight === right.cellHeight &&
    left.cellWidth === right.cellWidth &&
    left.columns === right.columns &&
    left.pixelRatio === right.pixelRatio &&
    left.rows === right.rows
  )
}
