import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { withDeadline } from './comparison-guards.mjs'
import {
  diagnosticFailed,
  isolatedDiagnostic,
  legacyDiagnostic,
} from './comparison-diagnostics.mjs'

test(
  'a crashed diagnostic retains its failure while the correctness browser continues',
  {
    skip: existsSync(chromium.executablePath()) ? false : 'Playwright Chromium is not installed',
    timeout: 30_000,
  },
  async () => {
    const server = createServer((_request, response) =>
      response.end(`<!doctype html><script>
    window.__compare = {
      prepare: async () => {},
      legacyWriteControl: async () => ({ documentedTerminalApi: { accepted: true, calls: 35 } }),
      legacyOriginalUnicode: async () => {
        console.info('legacy-original-unicode', JSON.stringify({ api: 'documentedTerminalApi', call: 22, phase: 'before-write' }));
        return { coreApi: { accepted: false, error: 'WASM trap fixture' } };
      },
    };
  </script>`),
    )
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const launchOptions = { headless: true }
    let correctnessBrowser
    try {
      correctnessBrowser = await chromium.launch(launchOptions)
      const correctnessPage = await correctnessBrowser.newPage()
      await correctnessPage.goto(origin)
      const contexts = new Set()
      const options = { launchOptions, origin, testCase: {}, contexts }
      const control = await legacyDiagnostic({ ...options, method: 'legacyWriteControl' })
      assert.equal(control.status, 'complete')
      assert.equal(control.documentedTerminalApi.calls, 35)
      assert.equal(diagnosticFailed({ legacyWriteControl: control }), false)

      const failed = await isolatedDiagnostic(options, async (page) => {
        await page.goto(origin)
        const session = await page.context().newCDPSession(page)
        const crashed = page.waitForEvent('crash')
        void session.send('Page.crash').catch(() => {})
        await crashed
        return page.evaluate(() => window.__compare.legacyOriginalUnicode())
      })
      assert.equal(failed.status, 'failed')
      assert.equal(failed.isolation, 'browser-process')
      assert.equal(failed.crashed, true)
      assert.match(failed.error, /crash/i)
      assert.equal(diagnosticFailed({ originalUnicodeProbe: failed }), true)
      assert.equal(contexts.size, 0)
      assert.equal(await correctnessPage.evaluate(() => document.readyState), 'complete')
      assert.deepEqual(
        await correctnessPage.evaluate(() => window.__compare.legacyWriteControl()),
        {
          documentedTerminalApi: { accepted: true, calls: 35 },
        },
      )

      const rejected = await legacyDiagnostic({ ...options, method: 'legacyOriginalUnicode' })
      assert.equal(rejected.status, 'failed')
      assert.equal(rejected.crashed, false)
      assert.equal(rejected.coreApi.error, 'WASM trap fixture')
      assert.deepEqual(rejected.trace.at(-1), {
        api: 'documentedTerminalApi',
        call: 22,
        phase: 'before-write',
      })
      assert.equal(diagnosticFailed({ originalUnicodeProbe: rejected }), true)
    } finally {
      await correctnessBrowser?.close()
      await new Promise((resolve) => server.close(resolve))
    }
  },
)

test(
  'a deadline owns a pending browser launch and prevents late diagnostic work',
  {
    skip: existsSync(chromium.executablePath()) ? false : 'Playwright Chromium is not installed',
    timeout: 30_000,
  },
  async () => {
    const contexts = new Set()
    let pending
    let registeredAtDeadline
    let operationCalled = false
    let enterOperation
    const operationEntered = new Promise((resolve) => {
      enterOperation = resolve
    })
    try {
      const outcome = await withDeadline(
        () => {
          pending = isolatedDiagnostic(
            { launchOptions: { headless: true }, contexts },
            async (page) => {
              operationCalled = true
              enterOperation()
              return page.evaluate(() => new Promise(() => {}))
            },
          )
          return pending
        },
        1,
        async () => {
          registeredAtDeadline = contexts.size
          await Promise.all([...contexts].map((context) => context.close().catch(() => {})))
        },
        { drain: true, drainMilliseconds: 1000 },
      ).then(
        () => 'complete',
        (error) => error.message,
      )
      assert.match(outcome, /deadline exceeded/)
      assert.equal(registeredAtDeadline, 1)
      assert.equal(contexts.size, 0)
      assert.equal(operationCalled, false)
      assert.equal((await pending).status, 'failed')
    } finally {
      await Promise.race([operationEntered, pending])
      await Promise.all([...contexts].map((context) => context.close().catch(() => {})))
      await pending
    }
  },
)

test(
  'a fulfilled payload cannot qualify a diagnostic whose renderer crashed',
  {
    skip: existsSync(chromium.executablePath()) ? false : 'Playwright Chromium is not installed',
    timeout: 30_000,
  },
  async () => {
    const result = await isolatedDiagnostic({ launchOptions: { headless: true } }, async (page) => {
      const session = await page.context().newCDPSession(page)
      const crashed = page.waitForEvent('crash')
      void session.send('Page.crash').catch(() => {})
      await crashed
      return { documentedTerminalApi: { accepted: true, calls: 35 } }
    })
    assert.equal(result.crashed, true)
    assert.equal(result.status, 'failed')
    assert.equal(diagnosticFailed({ originalUnicodeProbe: result }), true)
  },
)
