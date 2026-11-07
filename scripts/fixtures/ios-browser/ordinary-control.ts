import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createVitest } from 'vitest/node'
import { playwright } from '@vitest/browser-playwright'
import { createBrowserTestConfig } from '../../../vitest.browser.config.ts'
import { frameworkEndReporter } from '../../../scripts/ios-browser-report.ts'

const report = process.env.GHOSTTY_FRAMEWORK_REPORT
assert.ok(report)
const base = createBrowserTestConfig()
const ordinary = frameworkEndReporter()
let context: Awaited<ReturnType<typeof createVitest>> | undefined
try {
  context = await createVitest(
    'test',
    { config: false, watch: false },
    {
      ...base,
      test: {
        ...base.test,
        include: ['scripts/fixtures/ios-browser/ordinary.browser.test.ts'],
        env: { GHOSTTY_FRAMEWORK_MODE: 'ordinary' },
        testTimeout: 15000,
        hookTimeout: 30000,
        retry: 0,
        reporters: ['default', ordinary.reporter],
        browser: {
          ...base.test.browser,
          provider: playwright({
            launchOptions: {
              args: ['--no-sandbox', '--disable-dev-shm-usage'],
            },
          }),
        },
      },
    },
  )
  await context.start(['scripts/fixtures/ios-browser/ordinary.browser.test.ts'])
  assert.deepEqual(ordinary.endStatus(), { status: 'passed' })
  assert.equal(process.exitCode ?? 0, 0)
  await writeFile(
    `${report}/ordinary-desktop.json`,
    JSON.stringify(
      {
        runtime: process.version,
        end: ordinary.endStatus(),
        observationInstalled: false,
        provider: base.test.browser.provider.name,
        desktopCommands: Object.keys(base.test.browser.commands),
      },
      null,
      2,
    ),
  )
} finally {
  await context?.close()
}
