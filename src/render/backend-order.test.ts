import { describe, expect, it } from 'vitest'
import { isDesktopLinux } from './backend-order.js'
import { rendererPlatforms } from './tests/platforms.js'

describe('automatic GPU backend order', () => {
  it.each(rendererPlatforms)('selects the order for $name', ({ navigator, backend }) => {
    expect(
      isDesktopLinux(navigator.userAgentData?.platform ?? navigator.platform, navigator.userAgent),
    ).toBe(backend === 'webgl2')
  })
})
