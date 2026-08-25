import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export type XtermBrowser = 'chromium' | 'firefox' | 'webkit'

export function xtermBrowserConfig(browser: XtermBrowser) {
  return defineConfig({
    test: {
      browser: {
        enabled: true,
        headless: true,
        instances: [{ browser }],
        provider: playwright(),
        screenshotFailures: false,
      },
      fileParallelism: false,
      include: ['src/xterm/tests/**/*.browser.test.ts'],
      name: `xterm-${browser}`,
    },
  })
}
