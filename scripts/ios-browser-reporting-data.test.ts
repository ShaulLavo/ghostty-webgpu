import { expect, test } from 'vitest'
import { encodeReportingData, ReportingRecorder } from './ios-browser-reporting-data.ts'

test('recorded data is bounded without raw accessors, toJSON, or original then assimilation', () => {
  let reads = 0
  const raw = Object.defineProperty({}, 'message', {
    enumerable: true,
    get() {
      reads++
      return 'raw'
    },
  })
  expect(() => encodeReportingData(raw)).toThrow('accessor')
  // oxlint-disable-next-line unicorn/no-thenable -- Detect accidental observation of an original return.
  const original = Object.defineProperty({}, 'then', {
    enumerable: true,
    get() {
      reads++
      return 'original'
    },
  })
  expect(() => encodeReportingData(original)).toThrow('accessor')
  expect(() =>
    encodeReportingData({
      toJSON() {
        reads++
        return null
      },
    }),
  ).toThrow('recorded data')
  expect(reads).toBe(0)
})

test('recorder fails rather than truncating after 1,024 total entries', () => {
  const recorder = new ReportingRecorder()
  const first = recorder.array<number>()
  const second = recorder.array<number>()
  for (let index = 0; index < 1024; index++) first.push(index)
  expect(() => second.push(1)).toThrow('1,024')
  expect(first.length).toBe(1024)
  expect(second.length).toBe(0)
  expect(() => recorder.encode({ first })).toThrow('overflowed')
})

test('bounded UTF-8 encoder preserves complete Unicode and refuses oversized data', () => {
  const text = encodeReportingData({ text: '𝌆\n\u0000\ud800', list: [false, null, 0] })
  expect(JSON.parse(text)).toEqual({ text: '𝌆\n\u0000\ud800', list: [false, null, 0] })
  expect(() => encodeReportingData({ text: '界'.repeat(17000) })).toThrow('48 KiB')
  expect(() => encodeReportingData({ text: 'x'.repeat(50000) })).toThrow('48 KiB')
})

test('encoder refuses cycles and deep trees without invoking application code', () => {
  const cycle: { next?: unknown } = {}
  cycle.next = cycle
  expect(() => encodeReportingData(cycle)).toThrow('cycle')
  let value: unknown = null
  for (let index = 0; index < 20; index++) value = { value }
  expect(() => encodeReportingData(value)).toThrow('bounds')
})
