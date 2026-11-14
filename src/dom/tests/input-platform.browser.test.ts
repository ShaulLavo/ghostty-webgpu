import { afterEach, expect, it } from 'vitest'
import { restoreRendererNavigator, stubRendererNavigator } from '../../render/tests/navigator.js'
import { createDomInputController } from '../input.js'

const cases: {
  name: string
  platform: string
  userAgent: string
  override?: 'mac' | 'linux'
  apple: boolean
}[] = [
  {
    name: 'Linux platform with a Macintosh user agent',
    platform: 'Linux x86_64',
    userAgent: 'Macintosh',
    apple: false,
  },
  {
    name: 'Mac platform with a Linux user agent',
    platform: 'MacIntel',
    userAgent: 'Linux',
    apple: true,
  },
  { name: 'iPhone platform', platform: 'iPhone', userAgent: 'iPhone like Mac OS X', apple: true },
  {
    name: 'Macintosh user agent without a platform',
    platform: '',
    userAgent: 'Macintosh',
    apple: true,
  },
  {
    name: 'explicit Mac override',
    platform: 'Linux x86_64',
    userAgent: 'Linux',
    override: 'mac',
    apple: true,
  },
  {
    name: 'explicit Linux override',
    platform: 'MacIntel',
    userAgent: 'Macintosh',
    override: 'linux',
    apple: false,
  },
]

afterEach(restoreRendererNavigator)

it.each(cases)('copies with the clipboard shortcut for $name', async (entry) => {
  stubRendererNavigator({ platform: entry.platform, userAgent: entry.userAgent })
  const textarea = document.createElement('textarea')
  document.body.append(textarea)
  const abort = new AbortController()
  let copies = 0
  const keys: string[] = []
  const errors: unknown[] = []
  const input = createDomInputController({
    textarea,
    platform: entry.override,
    signal: abort.signal,
    selectionReadback: {
      hasSelection: () => true,
      copy: () => {
        copies++
      },
    },
    onError: (cause) => errors.push(cause),
    encoding: {
      key: async (key) => {
        keys.push(key.code)
        return new Uint8Array()
      },
      paste: async () => new Uint8Array(),
      sendInput: async () => new Uint8Array(),
    },
  })
  try {
    const copy = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyC',
      key: 'c',
      ctrlKey: !entry.apple,
      shiftKey: !entry.apple,
      metaKey: entry.apple,
    })
    textarea.dispatchEvent(copy)
    await Promise.resolve()
    expect(copy.defaultPrevented).toBe(true)
    expect(copies).toBe(1)
    expect(keys).toEqual([])
    expect(errors).toEqual([])
  } finally {
    input.dispose()
    abort.abort()
    textarea.remove()
  }
})
