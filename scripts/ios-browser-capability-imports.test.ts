import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import { createVitest } from 'vitest/node'
import type { ViteDevServer } from 'vite'
import { createFrameworkControl } from 'waffle/testing/page-runner/framework'
import { createBrowserTestConfig } from '../vitest.browser.config.ts'
import { attachedGhosttyProvider, ghosttyFrameworkPlugin } from './ios-browser.ts'
import { nativeStage } from './ios-browser-stages.ts'

test('native Vitest resolves capability and PNG helpers without opening a native session', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ghostty-imports-'))
  let context: Awaited<ReturnType<typeof createVitest>> | undefined
  let server: ViteDevServer | undefined
  try {
    const selected = nativeStage('webgpu')
    const host = createFrameworkControl(
      {
        suite: 'ghostty-native-import-control',
        native: { udid: 'not-allocated' },
        expected: selected.expected,
        scope: { kind: 'root-selection', command: 'test:browser', files: [selected.file] },
        resultPath: join(scratch, 'not-executed.json'),
      },
      'http://127.0.0.1:1/',
    )
    const base = createBrowserTestConfig()
    context = await createVitest(
      'test',
      { config: false, watch: false, root: fileURLToPath(new URL('../', import.meta.url)) },
      {
        ...base,
        plugins: base.plugins.concat([ghosttyFrameworkPlugin(host)]),
        test: {
          ...base.test,
          testTimeout: 15000,
          hookTimeout: 30000,
          retry: 0,
          browser: {
            ...base.test.browser,
            provider: attachedGhosttyProvider(host),
            instances: [{ browser: 'safari' }],
            commands: {},
            headless: false,
          },
        },
      },
    )
    const browser = context.projects.find((project) => project.browser)?.browser
    assert(browser)
    server = browser.vite
    const paths = [
      '/src/render/tests/webgpu-capability.js',
      '/src/render/tests/worker-webgl-capability.js',
      '/src/bidi/tests/browser-capabilities.js',
      '/src/render/tests/fixture-png.js',
    ]
    for (const path of paths) {
      const transformed = await browser.vite.transformRequest(path)
      assert(transformed, path)
      assert(!transformed.code.includes('__vite-browser-external'), path)
    }
    const vitest = await browser.vite.pluginContainer.resolveId('vitest')
    assert(vitest)
    const exports = await browser.vite.transformRequest('/@fs' + vitest.id)
    assert(exports)
    assert.match(exports.code, /export\s*\{[^}]*\bTestRunner\b/)
  } finally {
    try {
      await context?.close()
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  assert.equal(server?.httpServer?.listening, false)
  assert.equal(Reflect.has(globalThis, Symbol.for('ghostty.framework.instrumentDocument')), false)
})
