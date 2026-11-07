import { expect, test } from 'vitest'
import { commands } from 'vitest/browser'
import type {} from './desktop-command-types.d.ts'

test('keeps ordinary startup and the desktop insertText command', async () => {
  const field = document.createElement('textarea')
  document.body.append(field)
  try {
    field.focus()
    await commands.insertText('ordinary\nUnicode שלום 😀')
    expect(field.value).toBe('ordinary\nUnicode שלום 😀')
    expect(Reflect.has(globalThis, Symbol.for('waffle.framework.observation'))).toBe(false)
  } finally {
    field.remove()
  }
})
