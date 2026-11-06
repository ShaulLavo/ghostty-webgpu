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
