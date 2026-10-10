import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { webkit } from 'playwright'

const [url, directory] = process.argv.slice(2)
assert(
  url && directory,
  'Usage: bun scripts/verify-mobile-input.mjs <site-url> <evidence-directory>',
)
await mkdir(directory, { recursive: true })
const browser = await webkit.launch()
const results = []

async function checkPage(path, compatibilityMouse) {
  const name = `${path.replaceAll('/', '-') || 'shell'}-${compatibilityMouse ? 'ios-mouse' : 'touch'}`
  const page = await browser.newPage({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript((replayMouse) => {
    window.mobileInputEvents = []
    if (replayMouse) {
      // iOS Safari emits compatibility mouse events despite cancelling touch pointerdown.
      // Desktop WebKit suppresses them; allow its real mouse default action for this case.
      const preventDefault = Event.prototype.preventDefault
      Event.prototype.preventDefault = function () {
        if (
          this instanceof PointerEvent &&
          this.type === 'pointerdown' &&
          this.pointerType === 'touch'
        )
          return
        preventDefault.call(this)
      }
    }
    for (const type of ['focus', 'blur', 'pointerdown', 'touchend', 'mousedown', 'click']) {
      document.addEventListener(
        type,
        (event) => {
          window.mobileInputEvents.push({
            type,
            target: event.target.className,
            active: document.activeElement.className,
            prevented: event.defaultPrevented,
          })
        },
        type === 'focus' || type === 'blur',
      )
    }
  }, compatibilityMouse)
  try {
    await page.goto(new URL(path, url).href)
    const host = page.locator(path === '' ? '#terminal' : '[data-docs-terminal]')
    if (path === '') {
      await page.locator('#tabs button[data-demo=shell]').tap()
      await page.waitForFunction(() =>
        document.querySelector('#terminal').textContent.includes('bash in your browser tab'),
      )
    }
    await host.scrollIntoViewIfNeeded()
    const input = host.getByRole('textbox', { name: 'Terminal input' })
    await input.waitFor({ state: 'attached' })
    // Startup autofocus must not make a broken tap look successful.
    await input.evaluate((element) => element.blur())
    await page.evaluate(() => {
      window.mobileInputEvents = []
    })
    await host.locator('canvas').tap({ position: { x: 40, y: 40 } })
    await page.waitForTimeout(300)
    assert.equal(
      await input.evaluate((element) => document.activeElement === element),
      true,
      'Tap must retain terminal input focus',
    )
    assert.equal(
      await page.evaluate(() => window.mobileInputEvents.some((event) => event.type === 'blur')),
      false,
      'Tap must not blur and reopen the keyboard',
    )
    if (compatibilityMouse) {
      assert.equal(
        await page.evaluate(() =>
          window.mobileInputEvents.some((event) => event.type === 'mousedown'),
        ),
        true,
        'Exercise the iOS compatibility mouse sequence',
      )
    }
    await page.keyboard.insertText('mobile-echo-check')
    await host
      .getByRole('listitem')
      .filter({ hasText: 'mobile-echo-check' })
      .waitFor({ state: 'attached' })
    if (path === '') {
      await page.keyboard.press('Control+c')
      await page.keyboard.insertText('echo mobile-shell-$((6*7))')
      await page.keyboard.press('Enter')
      await host
        .getByRole('listitem')
        .filter({ hasText: 'mobile-shell-42' })
        .waitFor({ state: 'attached' })
    }
    assert.equal(await input.evaluate((element) => document.activeElement === element), true)
    assert.deepEqual(errors, [])
    results.push({ name, passed: true })
  } catch (cause) {
    results.push({ name, passed: false, message: String(cause), errors })
  } finally {
    await page.screenshot({ path: `${directory}/${name}.png` })
    await writeFile(
      `${directory}/${name}-events.json`,
      JSON.stringify(await page.evaluate(() => window.mobileInputEvents), null, 2),
    )
    await page.close()
  }
}

try {
  for (const compatibilityMouse of [false, true]) {
    for (const path of ['', 'docs/start/quick-start/', 'docs/examples/echo/']) {
      await checkPage(path, compatibilityMouse)
    }
  }
} finally {
  await browser.close()
  await writeFile(`${directory}/verification.json`, JSON.stringify(results, null, 2))
}
console.log(JSON.stringify(results, null, 2))
assert(
  results.every((result) => result.passed),
  'Every mobile input regression passes',
)
