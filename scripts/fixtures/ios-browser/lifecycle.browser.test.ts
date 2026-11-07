import { page } from 'vitest/browser'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
const mode = import.meta.env.GHOSTTY_FRAMEWORK_MODE
if (mode === 'import-fault') throw new Error('GHOSTTY_CONTROL_IMPORT_FAULT')
const event = (name: string, elapsedMs?: number) =>
  fetch('/ghostty-local-event', {
    method: 'POST',
    body: JSON.stringify({ role: 'body', event: name, elapsedMs }),
  })
beforeAll(async () => {
  await event('before-all')
  if (mode === 'before-all') throw new Error('GHOSTTY_CONTROL_BEFORE_ALL')
})
afterEach(async () => {
  await event('after-each')
  if (mode === 'after-each') throw new Error('GHOSTTY_CONTROL_AFTER_EACH')
})
afterAll(async () => {
  await event('after-all')
  if (mode === 'after-all') throw new Error('GHOSTTY_CONTROL_AFTER_ALL')
  if (mode === 'late-error' || mode === 'observer-throws')
    setTimeout(() => {
      throw new Error('GHOSTTY_CONTROL_LATE_ERROR')
    }, 10)
  await new Promise((resolve) => setTimeout(resolve, 70))
})
const withFixture = test.extend<{ owned: string }>({
  owned: [
    async ({ task }, use) => {
      expect(task.type).toBe('test')
      await use('local fixture')
      await event('fixture-cleanup')
      if (mode === 'fixture-error') throw new Error('GHOSTTY_CONTROL_FIXTURE_ERROR')
    },
    { auto: true },
  ],
})

describe('local synthetic lifecycle, not Ghostty originals', () => {
  withFixture('actual body', async () => {
    await event('body')
    if (mode === 'viewport-reject') {
      const started = performance.now()
      await expect(page.viewport(414, 896)).rejects.toThrow(
        'Unsupported Ghostty native browser command: __vitest_viewport',
      )
      const elapsed = performance.now() - started
      expect(elapsed).toBeLessThan(15000)
      await event('client-viewport-rejected', elapsed)
    }
    expect(window.innerWidth).toBe(414)
    expect(window.innerHeight).toBe(896)
  })
})
