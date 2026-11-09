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

test('caught append overflow during encoding invalidates the active snapshot', () => {
  const recorder = new ReportingRecorder()
  const values = recorder.array<number>()
  for (let index = 0; index < 1024; index++) values.push(index)
  let rejected = false
  const reentrant = new Proxy(
    { value: 1 },
    {
      getOwnPropertyDescriptor(target, key) {
        try {
          values.push(1024)
        } catch {
          rejected = true
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    },
  )
  expect(() => recorder.encode({ values, reentrant })).toThrow('recorder')
  expect(rejected).toBe(true)
  expect(values).toHaveLength(1024)
  expect(() => recorder.encode({ values })).toThrow('recorder')
})

test('even an in-capacity append cannot mutate a snapshot being encoded', () => {
  const recorder = new ReportingRecorder()
  const values = recorder.array<number>()
  const reentrant = new Proxy(
    { value: 1 },
    {
      getOwnPropertyDescriptor(target, key) {
        try {
          values.push(1)
        } catch {
          // The active snapshot must still see the failed append.
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    },
  )
  expect(() => recorder.encode({ values, reentrant })).toThrow('recorder')
  expect(values).toHaveLength(0)
})

test('caught nested encoding invalidates the outer snapshot', () => {
  const recorder = new ReportingRecorder()
  const reentrant = new Proxy(
    { value: 1 },
    {
      ownKeys(target) {
        try {
          recorder.encode(null)
        } catch {
          // A caught nested attempt must not let the outer capture succeed.
        }
        return Reflect.ownKeys(target)
      },
    },
  )
  expect(() => recorder.encode(reentrant)).toThrow('recorder')
  expect(() => recorder.encode(null)).toThrow('recorder')
})

test('key inventory is rejected before per-field descriptor callbacks', () => {
  let descriptors = 0
  const fields = Object.fromEntries(
    Array.from({ length: 20000 }, (_, index) => [`f${index}`, index]),
  )
  const value = new Proxy(fields, {
    getOwnPropertyDescriptor(target, key) {
      descriptors++
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  expect(() => encodeReportingData(value)).toThrow('too many fields')
  expect(descriptors).toBe(0)
})

test('the exact field and recorder limits keep complete enumerable data', () => {
  const fields = Object.fromEntries(
    Array.from({ length: 1024 }, (_, index) => [`f${index}`, index]),
  )
  expect(JSON.parse(encodeReportingData(fields))).toEqual(fields)
  const recorder = new ReportingRecorder()
  const values = recorder.array<number>()
  for (let index = 0; index < 1024; index++) values.push(index)
  expect(Reflect.ownKeys(values)).toHaveLength(1026)
  expect(JSON.parse(recorder.encode(values))).toEqual(
    Array.from({ length: 1024 }, (_, index) => index),
  )
})

test('enumerability and descriptor values are observed once and hidden accessors stay unread', () => {
  let descriptors = 0
  let reads = 0
  const hidden = { value: 1 }
  Object.defineProperty(hidden, 'hidden', { get: () => reads++ })
  Object.defineProperty(hidden, Symbol('hidden'), { enumerable: true, get: () => reads++ })
  const value = new Proxy(hidden, {
    getOwnPropertyDescriptor(target, key) {
      descriptors++
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  expect(JSON.parse(encodeReportingData(value))).toEqual({ value: 1 })
  expect(descriptors).toBe(2)
  expect(reads).toBe(0)
})

test('successful snapshot releases the recorder for later original events', () => {
  const recorder = new ReportingRecorder()
  const values = recorder.array<number>()
  values.push(1)
  expect(JSON.parse(recorder.encode(values))).toEqual([1])
  values.push(2)
  expect(JSON.parse(recorder.encode(values))).toEqual([1, 2])
})
