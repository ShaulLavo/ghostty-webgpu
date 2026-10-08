import type { TerminalFittedFont } from '../term/types.js'
import { workerError } from './structured-errors.js'

function isFittedFont(value: unknown): value is TerminalFittedFont {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const font = value as Partial<TerminalFittedFont>
  const settings = font.settings
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    typeof settings.family !== 'string'
  )
    return false
  const positiveNumbers = [font.cssCellWidth, font.cssCellHeight, font.pixelRatio, settings.size]
  const deviceMetrics = [
    font.deviceBaseline,
    font.deviceCellHeight,
    font.deviceCellWidth,
    font.deviceCharHeight,
    font.deviceCharWidth,
  ]
  const weights = [settings.weight, settings.boldWeight]
  return (
    settings.family.trim().length > 0 &&
    positiveNumbers.every(
      (metric) => typeof metric === 'number' && Number.isFinite(metric) && metric > 0,
    ) &&
    deviceMetrics.every(
      (metric) => typeof metric === 'number' && Number.isSafeInteger(metric) && metric > 0,
    ) &&
    weights.every((weight) => Number.isInteger(weight) && weight >= 1 && weight <= 1000) &&
    Number.isFinite(settings.lineHeight) &&
    settings.lineHeight >= 1 &&
    Number.isFinite(settings.letterSpacing) &&
    Number.isSafeInteger(font.charLeft) &&
    Number.isSafeInteger(font.charTop) &&
    font.charTop! >= 0 &&
    font.cssCellWidth === font.deviceCellWidth! / font.pixelRatio! &&
    font.cssCellHeight === font.deviceCellHeight! / font.pixelRatio!
  )
}

export function readOpeningFont(value: unknown): TerminalFittedFont {
  if (isFittedFont(value)) return value
  throw workerError('protocol', 'open.font', {
    expected: 'complete fitted font',
    receivedType: typeof value,
  })
}
