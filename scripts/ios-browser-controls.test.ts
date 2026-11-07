import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { test } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const entry = fileURLToPath(new URL('./fixtures/ios-browser/node-control.ts', import.meta.url))

async function control(target: string, mode: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'ghostty-fw-'))
  let child: ReturnType<typeof spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const observer = join(scratch, 'desktop-observer.js')
    if (target === 'desktop') await bundleObserver(observer)
    child = spawn(process.execPath, [entry, target], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GHOSTTY_FRAMEWORK_REPORT: scratch,
        GHOSTTY_FRAMEWORK_MODE: mode,
        GHOSTTY_FRAMEWORK_OBSERVER: observer,
      },
    })
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })
    const completion = once(child, 'close')
    timer = setTimeout(() => stopControl(child), 45000)
    const [code, signal] = await completion
    assert.equal(signal, null, output)
    assert.equal(code, 0, output)
    const report = target === 'sdk' ? 'sdk-checkpoint.json' : `${target}-${mode}.json`
    if (target === 'ordinary') {
      assert.match(await readFile(join(scratch, 'ordinary-desktop.json'), 'utf8'), /"passed"/)
      return
    }
    assert.ok((await readFile(join(scratch, report), 'utf8')).length > 0)
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      stopControl(child)
      await closed
    }
    await rm(scratch, { recursive: true, force: true })
  }
}

function stopControl(child: ReturnType<typeof spawn> | undefined): void {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

async function bundleObserver(output: string): Promise<void> {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: join(output, '..'),
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(
          new URL('./fixtures/ios-browser/desktop-observer.ts', import.meta.url),
        ),
        formats: ['es'],
        fileName: () => 'desktop-observer.js',
      },
    },
  })
}

// These are real SDK/Vite/WebSocket controls with no executing browser.
for (const mode of ['unowned', 'expired', 'revoked', 'malformed'])
  test(
    `published host and actual attached provider reject ${mode} HTTP work`,
    () => control('sdk', mode),
    55000,
  )

// These execute Chromium with an observation double, not Waffle admission or native proof.
for (const mode of [
  'clean',
  'before-all',
  'after-each',
  'after-all',
  'fixture-error',
  'import-fault',
  'inventory-reject',
  'late-error',
  'observer-throws',
  'caught-observer-throws',
  'viewport-reject',
])
  test(
    `desktop observation double preserves normal ${mode} lifecycle`,
    () => control('desktop', mode),
    55000,
  )

test(
  'uninstrumented Playwright keeps ordinary insertText',
  () => control('ordinary', 'ordinary'),
  55000,
)
