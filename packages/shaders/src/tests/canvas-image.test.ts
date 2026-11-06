import { expect, it, vi } from 'vitest'
import { subscribeCanvasImage } from '../canvas-image.js'

const key = Symbol.for('ghostty-webgpu.observeCanvasImage')

it.each([undefined, null, 1, {}, 'binding'])(
  'rejects a non-callable private binding: %s',
  (binding) => {
    expect(() => subscribeCanvasImage({ [key]: binding }, () => {})).toThrow(
      'no canvas-image subscription',
    )
  },
)

it.each([
  undefined,
  null,
  1,
  {},
  { kind: 'wrong' },
  { kind: 'subscription' },
  { kind: 'subscription', dispose: false },
])('rejects a malformed result: %s', (result) => {
  expect(() => subscribeCanvasImage({ [key]: () => result }, () => {})).toThrow(
    'subscription is invalid',
  )
})

it('fails unsupported renderers explicitly', () => {
  expect(() => subscribeCanvasImage({ [key]: () => ({ kind: 'unsupported' }) }, () => {})).toThrow(
    'does not publish canvas images',
  )
})

it('preserves binding and disposal receivers without a terminal type assertion', () => {
  const listener = vi.fn()
  const subscription = {
    kind: 'subscription',
    dispose() {
      expect(this).toBe(subscription)
    },
  }
  const terminal = {
    [key](callback: () => void) {
      expect(this).toBe(terminal)
      callback()
      return subscription
    },
  }
  const dispose = subscribeCanvasImage(terminal, listener)
  expect(listener).toHaveBeenCalledTimes(1)
  dispose()
})

it.each(['getter', 'call', 'result-getter'] as const)(
  'classifies a throwing %s capability as a capture error',
  (failure) => {
    const cause = new TypeError('malformed capability')
    const fail = () => {
      throw cause
    }
    const terminal = {}
    if (failure === 'getter') Object.defineProperty(terminal, key, { get: fail })
    if (failure === 'call') Object.defineProperty(terminal, key, { value: fail })
    if (failure === 'result-getter')
      Object.defineProperty(terminal, key, {
        value: () => Object.defineProperty({ kind: 'subscription' }, 'dispose', { get: fail }),
      })
    let error: unknown
    try {
      subscribeCanvasImage(terminal, () => {})
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'capture', cause })
  },
)
