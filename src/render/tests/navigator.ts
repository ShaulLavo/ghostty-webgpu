import type { RendererPlatform } from './platforms.js'

const properties = ['platform', 'userAgent', 'userAgentData'] as const
const originals = new Map<string, PropertyDescriptor | undefined>()

export function stubRendererNavigator(platform: RendererPlatform): void {
  for (const key of properties) {
    if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(navigator, key))
    Object.defineProperty(navigator, key, { configurable: true, value: platform[key] })
  }
}

export function restoreRendererNavigator(): void {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(navigator, key, descriptor)
    else Reflect.deleteProperty(navigator, key)
  }
  originals.clear()
}
