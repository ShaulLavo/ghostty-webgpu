import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright'
import { swiftShaderArgs, swiftShaderEnv } from './swiftshader-launch.js'
import {
  lifecycleCases,
  type LifecycleCase,
  type LifecycleEvent,
  type LifecycleResult,
} from './queue-lifecycle-types.js'

const root = resolve(import.meta.dirname, '..')
const hardware = process.env.GHOSTTY_BROWSER_HARDWARE === '1'
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      'src/render/renderer.ts',
      'scripts/queue-lifecycle-entry.ts',
      'scripts/queue-lifecycle.ts',
      'scripts/queue-lifecycle-types.ts',
    ].map(async (path) => [
      path,
      createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex'),
    ]),
  ),
)
const repetitions = Number(process.argv[2] ?? 1)
assert(
  Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10,
  'Use 1 to 10 lifecycle repetitions',
)
const output = resolve(process.argv[3] ?? join(tmpdir(), 'ghostty-queue-lifecycle.json'))
const origin = 'https://queue-lifecycle.test'
const bundled = await Bun.build({
  entrypoints: [join(root, 'scripts/queue-lifecycle-entry.ts')],
  target: 'browser',
})
assert(bundled.success && bundled.outputs[0], 'Lifecycle browser bundle failed')
const bundle = await bundled.outputs[0].text()
const [wasm, bridge] = await Promise.all([
  readFile(join(root, 'ghostty-vt.wasm')),
  readFile(join(root, 'bridge.wasm')),
])
const args = [
  '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
]
const software = process.platform === 'linux' && !hardware
if (software) args.push(...swiftShaderArgs)
if (hardware && process.platform === 'linux' && process.env.WAYLAND_DISPLAY)
  args.push('--ozone-platform=wayland')
const browser = await chromium.launch({
  args,
  channel: software ? undefined : 'chromium',
  env: software ? swiftShaderEnv() : undefined,
  headless: !hardware,
  timeout: 15_000,
})
const records: {
  name: LifecycleCase | 'realm-health'
  repetition: number
  result: LifecycleResult
}[] = []
const problems: { kind: string; text: string }[] = []
let gpuInfo: unknown
let adapterInfo: unknown
let qualifiedHardware = false
let failure: unknown

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DOMException('Lifecycle case exceeded 15 seconds', 'TimeoutError')),
          15_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function prepare(page: Page): Promise<void> {
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => problems.push({ kind: 'pageerror', text: error.message }))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push({ kind: 'console', text: message.text() })
  })
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/bundle.js')
      return route.fulfill({ body: bundle, contentType: 'text/javascript' })
    if (path === '/ghostty-vt.wasm')
      return route.fulfill({ body: wasm, contentType: 'application/wasm' })
    if (path === '/bridge.wasm')
      return route.fulfill({ body: bridge, contentType: 'application/wasm' })
    if (path !== '/') return route.abort()
    await route.fulfill({
      body: '<!doctype html><title>Queue lifecycle proof</title><script type="module" src="/bundle.js"></script>',
      contentType: 'text/html',
    })
  })
  await page.goto(origin)
  await page.waitForFunction(() => !!window.queueLifecycle)
}

function event(result: LifecycleResult, device: string, name: string): LifecycleEvent {
  const found = result.events.find((entry) => entry.device === device && entry.event === name)
  assert(found, `Missing ${device} ${name}`)
  return found
}

function verify(name: LifecycleCase, result: LifecycleResult): void {
  assert.equal(
    result.events.filter((entry) => entry.event.startsWith('uncaptured-')).length,
    0,
    'No WebGPU validation errors',
  )
  if (name === 'construction-failure') {
    const failed = event(result, 'A', 'pipeline-setup-failure')
    assert(failed.writes > 0, 'Constructor failed after viewport upload')
    assert.equal(failed.submits, 0, 'Construction made no explicit queue.submit call')
    event(result, 'A', 'original-setup-error-preserved')
    return
  }
  assert.equal(
    result.frames,
    name === 'replacement' ? 2 : 1,
    'Real renderer submitted expected frames',
  )
  event(result, 'A', 'submit-return')
  if (name === 'submitted-work') {
    const active = event(result, 'A', 'known-good-pending')
    assert.equal(
      active.pending,
      3,
      'Real completion callbacks remain undelivered at known-good marker',
    )
    event(result, 'A', 'readback-verified')
    const settlements = result.events.filter((entry) =>
      /^fence-(resolve|reject)-[123]$/u.test(entry.event),
    )
    assert.deepEqual(
      settlements.map((entry) => entry.event),
      ['fence-resolve-1', 'fence-resolve-2', 'fence-resolve-3'],
      'Known-good concurrent fences resolve in registration order',
    )
    return
  }
  if (name === 'replacement') {
    assert.equal(result.restores, 1, 'Replacement installed B')
    assert(
      event(result, 'A', 'replacement-start').pending > 0,
      'Replacement started before A completion delivery',
    )
    event(result, 'B', 'readback-verified')
    return
  }
  assert.equal(result.restores, 0, 'Cancelled or failed replacements stay uninstalled')
  if (name === 'replacement-failure') {
    const failed = event(result, 'B', 'pipeline-setup-failure')
    assert(failed.writes > 0, 'Replacement failed after viewport upload')
    assert.equal(failed.submits, 0, 'Failed replacement made no explicit queue.submit call')
  }
  if (name === 'late-replacement' || name === 'generation-change') {
    event(result, 'B', 'submit-return')
    event(result, 'B', 'destroy-call')
  }
  if (name === 'external-destroy') {
    assert(
      event(result, 'A', 'external-destroy-start').pending > 0,
      'External destroy interrupts pending real disposal fences',
    )
    event(result, 'A', 'lost-destroyed')
  }
}

async function removeRealm(page: Page): Promise<LifecycleResult> {
  const realmEvents = await page.evaluate(async () => {
    const events: LifecycleEvent[] = []
    const removed = Promise.withResolvers<void>()
    const frame = document.createElement('iframe')
    window.queueLifecycleRealmEvents = events
    window.queueLifecycleEvent = (entry) => events.push({ ...entry, sequence: events.length })
    window.queueLifecycleRemove = () => {
      frame.remove()
      const last = events.at(-1)
      if (last)
        events.push({ ...last, device: 'realm', event: 'realm-removed', sequence: events.length })
      removed.resolve()
    }
    frame.src = '/'
    document.body.append(frame)
    await new Promise<void>((resolveLoad) =>
      frame.addEventListener('load', () => resolveLoad(), { once: true }),
    )
    const child = frame.contentWindow
    if (!child) throw new TypeError('Owned lifecycle iframe was unavailable')
    await new Promise<void>((resolveReady, rejectReady) => {
      const deadline = performance.now() + 5_000
      const poll = () => {
        if (child.queueLifecycle) return resolveReady()
        if (performance.now() >= deadline)
          return rejectReady(new TypeError('Owned lifecycle iframe did not become ready'))
        setTimeout(poll, 10)
      }
      poll()
    })
    void child.queueLifecycle.run('realm-removal').catch(removed.reject)
    await removed.promise
    return events
  })
  const armed = realmEvents.find((entry) => entry.event === 'realm-removal-armed')
  assert(
    armed && armed.pending > 0 && armed.submits > 0,
    'Realm removal interrupted real submitted-work completion delivery',
  )
  return { events: realmEvents, frames: 1, restores: 0 }
}

try {
  const session = await browser.newBrowserCDPSession()
  const info = await session.send('SystemInfo.getInfo')
  gpuInfo = info.gpu
  const renderer = String(info.gpu.auxAttributes?.glRenderer ?? '')
  const page = await browser.newPage()
  try {
    await prepare(page)
    adapterInfo = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) return null
      return {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
        isFallbackAdapter: adapter.info.isFallbackAdapter,
      }
    })
    assert(adapterInfo, 'WebGPU adapter was unavailable')
    const description = JSON.stringify(adapterInfo)
    const details = adapterInfo as {
      vendor: string
      architecture: string
      isFallbackAdapter: boolean
    }
    qualifiedHardware =
      renderer.length > 0 &&
      details.vendor.length > 0 &&
      details.architecture.length > 0 &&
      !/swiftshader|llvmpipe|software|unknown/i.test(renderer + description) &&
      !details.isFallbackAdapter
    assert(!hardware || qualifiedHardware, 'Hardware requested but adapter qualification failed')
    console.log(
      JSON.stringify({
        stage: 'qualified',
        hardware: qualifiedHardware,
        renderer,
        adapter: adapterInfo,
      }),
    )
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      for (const name of lifecycleCases) {
        console.log(JSON.stringify({ stage: 'start', name, repetition }))
        const result =
          name === 'realm-removal'
            ? await bounded(removeRealm(page))
            : await bounded(page.evaluate((selected) => window.queueLifecycle.run(selected), name))
        verify(name, result)
        records.push({ name, repetition, result })
        console.log(JSON.stringify({ stage: 'pass', name, repetition, events: result.events }))
        if (name !== 'realm-removal') continue
        const health = await bounded(
          page.evaluate(() => window.queueLifecycle.run('submitted-work')),
        )
        verify('submitted-work', health)
        records.push({ name: 'realm-health', repetition, result: health })
        const afterRemoval = await page.evaluate(() => {
          const events = window.queueLifecycleRealmEvents ?? []
          delete window.queueLifecycleEvent
          delete window.queueLifecycleRemove
          delete window.queueLifecycleRealmEvents
          return { events, frames: document.querySelectorAll('iframe').length }
        })
        result.events = afterRemoval.events
        event(result, 'realm', 'realm-removed')
        event(result, 'A', 'realm-removal-returned')
        assert.equal(afterRemoval.frames, 0, 'Owned iframe was removed')
      }
    }
    assert.equal(
      problems.filter((problem) => problem.kind === 'pageerror').length,
      0,
      'Browser stayed responsive without page execution errors',
    )
  } finally {
    await page.close()
  }
} catch (cause) {
  failure = cause instanceof Error ? { name: cause.name, message: cause.message } : String(cause)
  process.exitCode = 1
} finally {
  await browser.close()
  await mkdir(dirname(output), { recursive: true })
  await writeFile(
    output,
    JSON.stringify(
      {
        commit,
        sourceHashes,
        browser: browser.version(),
        hardwareRequested: hardware,
        qualifiedHardware,
        adapterInfo,
        gpuInfo,
        records,
        problems,
        failure,
        limits:
          'JavaScript API/callback order only. Pending means callbacks undelivered; native completion, mutex ownership, and final handle release are unobserved. Successful bounded runs do not prove universal safety.',
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ output, records: records.length, failure }))
}
