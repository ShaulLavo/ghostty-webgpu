import assert from 'node:assert/strict'
import { createVitest, type BrowserCommandContext, type TestProject } from 'vitest/node'
import { webdriverio } from '@vitest/browser-webdriverio'
import { fileURLToPath } from 'node:url'
import { createBrowserTestConfig } from '../../../vitest.browser.config.ts'
import type {} from '../../ios-browser.ts'

export type CaptureOptions = Parameters<
  import('vitest/internal/browser').BrowserCommands['__vitest_takeScreenshot']
>[1]

export type OfficialScreenshotContext = {
  project: TestProject
  commandContext(file: string): BrowserCommandContext
  screenshot: (...args: unknown[]) => Promise<unknown>
  lookupReached: Error
}

export async function withOfficialScreenshot<T>(
  check: (input: OfficialScreenshotContext) => Promise<T>,
): Promise<T> {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const base = createBrowserTestConfig()
  let context: Awaited<ReturnType<typeof createVitest>> | undefined
  try {
    context = await createVitest(
      'test',
      { config: false, watch: false, root },
      {
        ...base,
        test: {
          ...base.test,
          include: [],
          browser: {
            ...base.test.browser,
            provider: webdriverio(),
            instances: [{ browser: 'safari' }],
            commands: {},
          },
        },
      },
    )
    const project = context.projects[0]
    assert(project?.browser)
    const browser = project.browser
    await browser.initBrowserProvider(project)
    const parent: unknown = Reflect.get(browser, 'parent')
    assert(parent && typeof parent === 'object' && 'commands' in parent)
    assert(parent.commands && typeof parent.commands === 'object')
    const command: unknown = Reflect.get(parent.commands, '__vitest_screenshot')
    assert(typeof command === 'function')
    const lookupReached = new Error('CPU contract stops before browser lookup or pixels')
    return await check({
      project,
      lookupReached,
      screenshot: async (...args) => command(...args),
      commandContext: (file) => screenshotContext(project, file, lookupReached),
    })
  } finally {
    await context?.close()
  }
}

function screenshotContext(
  project: TestProject,
  file: string,
  lookupReached: Error,
): BrowserCommandContext {
  const browser = project.browser
  assert(browser)
  const context: BrowserCommandContext = {
    project,
    provider: browser.provider,
    sessionId: 'cpu-contract-only',
    testPath: file,
    mark: async () => {},
    triggerCommand: (name, ...args) => browser.triggerCommand(name, context, ...args),
    get browser(): never {
      throw lookupReached
    },
    get page(): never {
      throw new Error('Unexpected Playwright access')
    },
    get frame(): never {
      throw new Error('Unexpected Playwright access')
    },
    get iframe(): never {
      throw new Error('Unexpected Playwright access')
    },
    get context(): never {
      throw new Error('Unexpected Playwright access')
    },
  }
  return context
}
