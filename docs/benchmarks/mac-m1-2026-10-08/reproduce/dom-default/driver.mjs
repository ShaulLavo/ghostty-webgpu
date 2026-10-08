import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile, writeFile, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'
import { fitWindow, fitGrid, displayProbe, assertDisplay } from './display-helpers.mjs'
import { nativeSnapshot, nativeDelta, assertWork } from './measure.mjs'

const root = process.argv[2]
const protocolPath = process.argv[3]
const protocolBytes = await readFile(protocolPath)
const protocol = JSON.parse(protocolBytes)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const actors = {
  GL: { variant: 'ghostty-webgl' },
  GPU: { variant: 'ghostty-webgpu' },
  CANVAS: { variant: 'ghostty-canvas' },
  PIXELS: { variant: 'ghostty-canvas', query: '&canvas=pixels' },
  DOM: { variant: 'ghostty-dom' },
  XGL: { variant: 'xterm-webgl' },
  XDOM: { variant: 'xterm-dom' },
}
assert.equal(process.platform, 'darwin')
assert.match(protocol.id, /^tw-dom-[a-z0-9-]+$/)
for (const actor of protocol.order) assert(actors[actor], `Actor unavailable: ${actor}`)
const manifest = JSON.parse(await readFile(join(root, 'bundle.json')))
assert.equal(sha(await readFile(join(root, 'packet/browser.js'))), manifest.bundleSha256)
const seal = JSON.parse(await readFile(join(root, 'seal.json')))
for (const [path, digest] of Object.entries(seal.files))
  assert.equal(sha(await readFile(join(root, path))), digest, `Sealed artifact changed: ${path}`)
const recipeBytes = await readFile(join(root, 'recipe.json'))
const recipe = JSON.parse(recipeBytes)
assert.equal(recipe.browserVersion, '154.0.8037.93')
const out = join(root, protocol.id)
await mkdir(out, { recursive: false })
const result = {
  id: protocol.id,
  sessionId: randomUUID(),
  startedAt: new Date().toISOString(),
  protocol,
  protocolSha256: sha(protocolBytes),
  bundleSha256: manifest.bundleSha256,
  runtimeCommit: manifest.runtimeCommit,
  sealSha256: sha(await readFile(join(root, 'seal.json'))),
  readerSha256: sha(await readFile(join(import.meta.dirname, 'rusage.py'))),
  readerValidation: protocol.readerValidation,
  recipeSha256: sha(recipeBytes),
  recipe: {
    browserVersion: recipe.browserVersion,
    browserExecutable: recipe.browserExecutable,
    browserLaunchArguments: recipe.browserLaunchArguments,
  },
  endpoint:
    'Native counters bracket reset + paced writes + two RAFs + target counter snapshots. Final text and screenshot capture are outside the counter window. Kernel energy covers process CPU energy, excludes physical GPU/display.',
  runs: [],
}
const save = () => writeFile(join(out, 'index.json'), JSON.stringify(result, null, 2) + '\n')
await save()

function hostState() {
  const battery = execFileSync('/usr/bin/pmset', ['-g', 'batt'], {
    encoding: 'utf8',
    timeout: 2000,
  })
  const loads = execFileSync('/usr/sbin/sysctl', ['-n', 'vm.loadavg'], {
    encoding: 'utf8',
    timeout: 2000,
  })
  return {
    at: new Date().toISOString(),
    ac: battery.includes("'AC Power'"),
    load: Number(loads.replace(/[{}]/g, '').trim().split(/\s+/)[0]),
  }
}
async function admit(label) {
  const readings = []
  const deadline = Date.now() + 120000
  for (;;) {
    const state = hostState()
    readings.push(state)
    assert(state.ac, `AC power required (${label})`)
    if (state.load < 4) return { label, readings }
    assert(Date.now() < deadline, `Load admission timeout (${label})`)
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}
const reader = spawn('python3', [join(import.meta.dirname, 'rusage.py')], {
  stdio: ['pipe', 'pipe', 'inherit'],
})
const owned = new Set([reader.pid])
const readerExited = new Promise((resolve) => reader.once('exit', resolve))
const replies = createInterface({ input: reader.stdout })[Symbol.asyncIterator]()
result.readerReady = JSON.parse((await replies.next()).value)
assert.equal(result.readerReady.ready, true)
async function rusage(pids) {
  reader.stdin.write(JSON.stringify({ pids }) + '\n')
  const row = await replies.next()
  assert(!row.done, 'Native reader exited')
  return JSON.parse(row.value)
}
const fixture = createFixture(join(root, 'packet'), protocol.port)
let browser
let stopped = false
const soft = setTimeout(() => {
  stopped = true
  result.stopReason = '590-second soft deadline'
  void save().then(() => browser?.close())
}, 590000)
const hard = setTimeout(() => {
  result.hardDeadline = true
  void save().finally(() => process.exit(1))
}, 600000)

async function trace(browserSession, filename, run) {
  const categories = [
    'toplevel',
    'gpu',
    'viz',
    'cc',
    'benchmark',
    'blink.user_timing',
    'devtools.timeline',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
  ]
  await browserSession.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    streamFormat: 'json',
    streamCompression: 'gzip',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: categories,
      excludedCategories: ['*'],
    },
  })
  let value
  try {
    value = await run()
  } finally {
    const completion = new Promise((resolve) =>
      browserSession.once('Tracing.tracingComplete', resolve),
    )
    await browserSession.send('Tracing.end')
    const { stream, dataLossOccurred } = await completion
    const file = await open(filename, 'w')
    try {
      for (;;) {
        const chunk = await browserSession.send('IO.read', { handle: stream, size: 1 << 20 })
        await file.write(
          chunk.base64Encoded
            ? Buffer.from(chunk.data, 'base64')
            : Buffer.from(chunk.data, 'binary'),
        )
        if (chunk.eof) break
      }
    } finally {
      await file.close()
      await browserSession.send('IO.close', { handle: stream })
    }
    assert(!dataLossOccurred, 'Trace lost events')
  }
  return value
}

async function capture(browserSession, port, actor, index, workload) {
  assert(!stopped, 'Deadline reached')
  const row = { index, actor, workload, errors: [], admission: await admit(`${actor}-${index}`) }
  result.runs.push(row)
  const context = await browser.newContext({ viewport: null })
  const page = await context.newPage()
  page.on('pageerror', (error) => row.errors.push(error.message))
  page.setDefaultTimeout(20000)
  try {
    const pageSession = await context.newCDPSession(page)
    await pageSession.send('Performance.enable', { timeDomain: 'threadTicks' })
    await page.goto(
      `http://127.0.0.1:${port}/?accessibility=off${actors[actor].query ?? ''}${protocol.trace ? '&trace=1' : ''}`,
    )
    await page.waitForFunction(() => window.__direct)
    row.windowGeometry = await fitWindow(page, browserSession, pageSession)
    await page.evaluate(
      ({ variant, count }) => window.__compare.prepare({ variant, count, path: 'bytes' }),
      { variant: actors[actor].variant, count: protocol.count },
    )
    if (protocol.fonts?.[actor])
      await page.evaluate((font) => window.__direct.setFont(font), protocol.fonts[actor])
    row.grid = await fitGrid(page)
    row.geometry = await page.evaluate(() => window.__direct.snapshot())
    assert.equal(row.geometry.length, protocol.count)
    assert.equal(row.geometry[0].dpr, 2)
    row.correctness = await page.evaluate(() => window.__compare.correctness())
    row.display = await displayProbe({
      page,
      session: pageSession,
      browserSession,
      metadata: { actor, kind: 'idle-display' },
    })
    assertDisplay(row.display)
    row.warmup = await page.evaluate(
      ({ fixture, ticks }) => window.__direct.measured(fixture, ticks),
      { fixture: workload, ticks: protocol.warmupTicks },
    )
    assertWork(row.warmup, protocol.count, protocol.warmupTicks)
    row.performanceBefore = Object.fromEntries(
      (await pageSession.send('Performance.getMetrics')).metrics.map(({ name, value }) => [
        name,
        value,
      ]),
    )
    const before = await nativeSnapshot(browserSession, rusage)
    before.cpu.forEach((process) => owned.add(process.id))
    if (protocol.trace) {
      row.measured = await trace(browserSession, join(out, `${index}-${actor}.trace.json.gz`), () =>
        page.evaluate(
          async ({ fixture, ticks }) => {
            performance.mark('diag-start')
            window.__compare.traceBegin()
            const value = await window.__direct.measured(fixture, ticks)
            const operations = window.__compare.traceEnd()
            performance.mark('diag-end')
            return { ...value, operations }
          },
          { fixture: workload, ticks: protocol.ticks },
        ),
      )
    } else {
      row.measured = await page.evaluate(
        ({ fixture, ticks }) => window.__direct.measured(fixture, ticks),
        { fixture: workload, ticks: protocol.ticks },
      )
    }
    const after = await nativeSnapshot(browserSession, rusage)
    after.cpu.forEach((process) => owned.add(process.id))
    row.performanceAfter = Object.fromEntries(
      (await pageSession.send('Performance.getMetrics')).metrics.map(({ name, value }) => [
        name,
        value,
      ]),
    )
    row.snapshots = { before, after }
    row.native = nativeDelta(before, after)
    row.targetWork = assertWork(row.measured, protocol.count, protocol.ticks)
    row.content = await page.evaluate(() => window.__direct.content())
    const semantic = row.content.map((target) => ({
      text: target.publicText.map((line) => line.trimEnd()),
      historyRows: target.historyRows,
      retainedRows: target.retainedRows,
      retainedTextSha256: target.retainedTextSha256,
    }))
    row.contentSha256 = sha(JSON.stringify(semantic))
    row.screenshotSha256 = sha(
      await page.screenshot({
        path: join(out, `${String(index).padStart(2, '0')}-${actor}-${workload}.png`),
      }),
    )
    row.hostAfter = hostState()
    assert(row.hostAfter.ac, 'AC power lost during actor')
    assert.deepEqual(row.errors, [])
    row.status = 'complete'
  } catch (error) {
    row.failure = String(error.stack ?? error)
    row.failureInfo = await page
      .evaluate(() => ({ info: window.__compare?.info(), direct: window.__direct?.snapshot() }))
      .catch(() => null)
    await page.screenshot({ path: join(out, `${index}-${actor}-failure.png`) }).catch(() => null)
    throw error
  } finally {
    await context.close()
    await save()
  }
}

try {
  const port = await fixture.start()
  result.fixturePort = port
  result.initialAdmission = await admit('launch')
  browser = await chromium.launch({
    executablePath: recipe.browserExecutable,
    headless: false,
    args: recipe.browserLaunchArguments,
    timeout: 20000,
  })
  result.browserVersion = browser.version()
  assert.equal(result.browserVersion, recipe.browserVersion)
  const browserSession = await browser.newBrowserCDPSession()
  result.backend = await browserSession.send('SystemInfo.getInfo')
  const gpuInfo = result.backend.gpu
  assert(
    !JSON.stringify(gpuInfo).includes('SwiftShader'),
    'Software GPU unavailable for a Mac measurement',
  )
  await new Promise((resolve) => setTimeout(resolve, 20000))
  let index = 0
  for (const workload of protocol.workloads) {
    for (const actor of protocol.order)
      await capture(browserSession, port, actor, index++, workload)
    const hashes = result.runs
      .filter((row) => row.workload === workload)
      .map((row) => row.contentSha256)
    assert.equal(new Set(hashes).size, 1, `Final logical output differs for ${workload}`)
  }
  result.complete = true
} catch (error) {
  result.failure = String(error.stack ?? error)
  process.exitCode = 1
} finally {
  clearTimeout(soft)
  reader.stdin.end()
  await readerExited
  try {
    await browser?.close()
    result.browserClosed = true
  } finally {
    await fixture.close()
    result.fixtureRequests = fixture.requests
    clearTimeout(hard)
    result.finishedAt = new Date().toISOString()
    result.ownedPids = [...owned]
    result.custody = [...owned].map((pid) => {
      try {
        process.kill(pid, 0)
        return { pid, alive: true }
      } catch {
        return { pid, alive: false }
      }
    })
    await save()
  }
}
console.log(
  JSON.stringify({
    id: result.id,
    complete: result.complete,
    failure: result.failure,
    runs: result.runs.map((row) => ({
      actor: row.actor,
      workload: row.workload,
      status: row.status,
      channels: row.native?.channels,
    })),
  }),
)
