import { expect, it } from 'vitest'
import { GhosttyError } from '../core/error.js'
import { freezeWorkerValue } from './owned.js'
import { serializeWorkerFailure, workerError } from './structured-errors.js'

it('restores readonly nested values after structured cloning', () => {
  const original = Object.freeze({
    grid: Object.freeze({ columns: 80 }),
    rows: Object.freeze([{ text: 'owned' }]),
  })
  const copied = structuredClone(original)
  expect(Object.isFrozen(copied)).toBe(false)
  const value = freezeWorkerValue(copied)
  expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(value.grid)).toBe(true)
  expect(Object.isFrozen(value.rows[0])).toBe(true)
  expect(value).toEqual(original)
})

it('leaves a received input byte result attached and caller writable', () => {
  const bytes = new Uint8Array([97])
  expect(freezeWorkerValue(bytes)).toBe(bytes)
  bytes[0] = 98
  expect(bytes.byteLength).toBe(1)
  expect(bytes[0]).toBe(98)
})

it('carries structured runtime facts without serializing arbitrary exception text', () => {
  const failure = workerError('protocol', 'fence', { expected: 2, output: 1 })
  expect(serializeWorkerFailure(failure, 'request')).toMatchObject({
    code: 'protocol',
    operation: 'fence',
    internal: { expected: 2, output: 1 },
  })
  const unknown = serializeWorkerFailure(new TypeError('private payload'), 'startup')
  expect(unknown.internal).toEqual({ causeType: 'TypeError' })
  expect(JSON.stringify(unknown)).not.toContain('private payload')
})

it('keeps native operation and result receipts without exception text', () => {
  const cause = new GhosttyError('private payload', {
    operation: 'ghostty_selection_gesture_event(PRESS)',
    result: -2,
  })
  const failure = serializeWorkerFailure(cause, 'selectionPress')
  expect(failure).toMatchObject({
    code: 'execution',
    operation: 'selectionPress',
    internal: {
      causeType: 'GhosttyError',
      causeOperation: 'ghostty_selection_gesture_event(PRESS)',
      causeResult: -2,
    },
  })
  expect(JSON.stringify(failure)).not.toContain('private payload')
})
