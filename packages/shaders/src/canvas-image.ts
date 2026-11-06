import { ShaderAddonError } from './types.js'

const observeCanvasImage = Symbol.for('ghostty-webgpu.observeCanvasImage')

export function subscribeCanvasImage(terminal: object, listener: () => void): () => void {
  const binding: unknown = Reflect.get(terminal, observeCanvasImage)
  if (typeof binding !== 'function')
    throw new ShaderAddonError('capture', 'The terminal has no canvas-image subscription.')
  const subscription: unknown = binding.call(terminal, listener)
  if (typeof subscription !== 'object' || subscription === null || !('kind' in subscription))
    throw new ShaderAddonError('capture', 'The canvas-image subscription is invalid.')
  if (subscription.kind === 'unsupported')
    throw new ShaderAddonError('backend', 'The terminal renderer does not publish canvas images.')
  if (
    subscription.kind !== 'subscription' ||
    !('dispose' in subscription) ||
    typeof subscription.dispose !== 'function'
  )
    throw new ShaderAddonError('capture', 'The canvas-image subscription is invalid.')
  const dispose = subscription.dispose
  return () => dispose.call(subscription)
}
