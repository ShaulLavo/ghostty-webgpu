import { expect, it } from 'vitest'
import { calculateTerminalFittedFont } from '../dom/fit.js'
import { readOpeningFont } from './opening-font.js'

const font = calculateTerminalFittedFont(
  { boldWeight: 700, family: 'monospace', letterSpacing: -1, lineHeight: 1, size: 15, weight: 400 },
  { advanceWidth: 9, fontAscent: 18, fontDescent: 6 },
  1.25,
)

it('accepts complete actor metrics without copying their settings or offsets', () => {
  const received = structuredClone(font)
  expect(readOpeningFont(received)).toBe(received)
  expect(received.charLeft).toBeLessThan(0)
})

it.each([
  ['missing result', undefined],
  ['null result', null],
  ['non-object result', 'font'],
  ['array result', []],
  ['missing settings', { ...font, settings: undefined }],
  ['array settings', { ...font, settings: Object.assign([], font.settings) }],
  ['empty family', { ...font, settings: { ...font.settings, family: ' ' } }],
  ['invalid size', { ...font, settings: { ...font.settings, size: 0 } }],
  ['invalid weight', { ...font, settings: { ...font.settings, weight: 1001 } }],
  ['invalid bold weight', { ...font, settings: { ...font.settings, boldWeight: 0 } }],
  ['invalid line height', { ...font, settings: { ...font.settings, lineHeight: 0.5 } }],
  ['non-finite spacing', { ...font, settings: { ...font.settings, letterSpacing: NaN } }],
  ['zero cell width', { ...font, cssCellWidth: 0 }],
  ['non-finite cell height', { ...font, cssCellHeight: Infinity }],
  ['inconsistent cell width', { ...font, cssCellWidth: font.cssCellWidth + 1 }],
  ['invalid pixel ratio', { ...font, pixelRatio: 0 }],
  ['missing device width', { ...font, deviceCellWidth: undefined }],
  ['fractional device height', { ...font, deviceCellHeight: 1.5 }],
  ['missing character offset', { ...font, charLeft: undefined }],
  ['invalid baseline', { ...font, deviceBaseline: -1 }],
])('rejects %s with structured protocol guidance', (_name, value) => {
  expect(() => readOpeningFont(value)).toThrow(
    expect.objectContaining({
      name: 'TerminalWorkerError',
      code: 'protocol',
      operation: 'open.font',
      status: 500,
      why: expect.any(String),
      fix: expect.any(String),
      internal: { expected: 'complete fitted font', receivedType: typeof value },
    }),
  )
})
