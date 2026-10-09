import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  assertHeadedHardware,
  assertHeadedSurfaceTransport,
  headedLaunchArguments,
  finishOwnedLaunchCleanup,
  matchingGlRendererIdentity,
  observedNativeContentInsets,
  ownedProcessAlive,
  ownedProcessStates,
  settleOwnedWindowGeometry,
  waitForOwnedNonceWindow,
} from './comparison-headed.mjs'
import { observeOwnedBrowserProvenance } from './comparison-provenance.mjs'

function observedFacts() {
  const executable = '/fixture/chrome'
  const profile = '/fixture/task/tmp/chrome-123'
  const requestedArguments = headedLaunchArguments(profile)
  const renderer =
    'ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA NVIDIA GeForce RTX 3060 Ti (0x00002489)), NVIDIA-610.57.4.0)'
  return {
    executable,
    profile,
    requestedArguments,
    provenance: {
      environment: { launchMode: 'headed', headless: false },
      browserPid: 123,
      observedExecutable: executable,
      observedProfile: profile,
      originalExecveArguments: null,
      observedFlagTokens: requestedArguments,
      observedFlagTokensQualification:
        'Exact whitespace tokens in observed OS rendering; original argv boundaries are unavailable',
      rawCommandLineBase64: Buffer.from(requestedArguments.join(' ') + '\0').toString('base64'),
    },
    window: {
      browserPid: 123,
      backend: 'wayland',
      mapped: true,
      hidden: false,
      xwayland: false,
    },
    gpu: {
      devices: [
        {
          vendorId: 4318,
          deviceId: 9353,
          deviceString: renderer,
          vendorString: 'Google Inc. (NVIDIA)',
          driverVendor: 'NVIDIA',
          driverVersion: '610.57.4.0',
        },
      ],
      auxAttributes: {
        displayType: 'ANGLE_VULKAN',
        glImplementationParts: '(gl=egl-angle,angle=vulkan)',
        hardwareSupportsVulkan: true,
        inProcessGpu: false,
        glRenderer: renderer,
      },
      featureStatus: {
        gpu_compositing: 'enabled',
        webgl: 'enabled',
        vulkan: 'enabled_on',
      },
    },
    gl: { renderer, contextLost: false },
  }
}

test('actual raw tokens without original execve boundaries qualify only with independent custody, hardware and compositor facts', () => {
  assertHeadedHardware(observedFacts())
})

test('headless, unknown and contradictory actual modes fail before acquisition', () => {
  for (const mode of ['headless', 'unknown', 'contradictory']) {
    const facts = observedFacts()
    facts.provenance.environment.launchMode = mode
    assert.throws(() => assertHeadedHardware(facts), /Observed headed/)
  }
  const facts = observedFacts()
  facts.provenance.environment.headless = null
  assert.throws(() => assertHeadedHardware(facts), /headless state/)
})

test('requested-only flags, ambiguous argument spaces, missing raw evidence and changed executable or profile fail', () => {
  for (const change of [
    (facts) => {
      facts.provenance.observedFlagTokens = []
    },
    (facts) => {
      facts.requestedArguments = ['--user-data-dir=/some path']
    },
    (facts) => {
      facts.provenance.rawCommandLineBase64 = null
    },
    (facts) => {
      facts.provenance.observedFlagTokensQualification = ''
    },
    (facts) => {
      facts.provenance.observedExecutable = '/another/chrome'
    },
    (facts) => {
      facts.provenance.observedProfile = '/another/profile'
    },
  ]) {
    const facts = observedFacts()
    change(facts)
    assert.throws(() => assertHeadedHardware(facts))
  }
})

test('conflicting observed backend switches and software or automation switches reject', () => {
  for (const flag of [
    '--ozone-platform=x11',
    '--ozone-platform=wayland',
    '--ozone-platform=headless',
    '--use-angle=swiftshader',
    '--use-angle=gl',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--use-gl=angle',
    '--enable-automation',
    '--ozone-platform-hint=auto',
    '--force-device-scale-factor=2',
  ]) {
    const facts = observedFacts()
    facts.provenance.observedFlagTokens = facts.provenance.observedFlagTokens.concat([flag])
    assert.throws(() => assertHeadedHardware(facts), undefined, flag)
  }
})

test('actual non-Wayland, foreign, hidden, unmapped and XWayland compositor windows reject', () => {
  for (const patch of [
    { backend: 'x11' },
    { browserPid: 456 },
    { mapped: false },
    { hidden: true },
    { xwayland: true },
  ]) {
    const facts = observedFacts()
    Object.assign(facts.window, patch)
    assert.throws(() => assertHeadedHardware(facts))
  }
})

test('actual software, unknown, inconsistent and unavailable GPU facts reject', () => {
  for (const change of [
    (facts) => {
      facts.gpu.auxAttributes.glRenderer = 'ANGLE Vulkan SwiftShader'
    },
    (facts) => {
      facts.gpu.auxAttributes.glRenderer = ''
    },
    (facts) => {
      facts.gpu.auxAttributes.displayType = 'ANGLE_OPENGL'
    },
    (facts) => {
      facts.gpu.auxAttributes.glImplementationParts = '(gl=egl-angle,angle=opengl)'
    },
    (facts) => {
      facts.gpu.auxAttributes.hardwareSupportsVulkan = false
    },
    (facts) => {
      facts.gpu.auxAttributes.inProcessGpu = true
    },
    (facts) => {
      facts.gpu.featureStatus.gpu_compositing = 'disabled_software'
    },
    (facts) => {
      facts.gpu.featureStatus.webgl = 'unavailable'
    },
    (facts) => {
      facts.gpu.featureStatus.vulkan = 'disabled_off'
    },
    (facts) => {
      facts.gpu.devices = []
    },
    (facts) => {
      facts.gpu.devices[0].vendorId = 0
    },
    (facts) => {
      facts.gl.renderer = 'Another GPU'
    },
    (facts) => {
      facts.gl.contextLost = true
    },
  ]) {
    const facts = observedFacts()
    change(facts)
    assert.throws(() => assertHeadedHardware(facts))
  }
})

test('standalone recipe skips with stated reason when the display is absent, without launching Chrome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'headed-recipe-test-'))
  try {
    const output = join(root, 'proof')
    const script = join(import.meta.dirname, 'headed-presentation-smoke.mjs')
    await promisify(execFile)(
      process.execPath,
      [
        script,
        '--executable',
        '/missing/chrome',
        '--output',
        output,
        '--window-system',
        'hyprland',
      ],
      {
        env: { ...process.env, WAYLAND_DISPLAY: '', XDG_RUNTIME_DIR: '' },
        timeout: 5000,
      },
    )
    const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'))
    assert.equal(result.status, 'SKIP')
    assert.match(result.reason, /No Wayland display/)
    assert.equal(result.terminalMarkers, 0)
    assert.equal(result.measurements, 0)
  } finally {
    await rm(root, { recursive: true })
  }
})

test('approved real provenance rejects profile-last startup URL and accepts the fixed profile-before-flag order', async () => {
  const profile = '/fixture/task/tmp/chrome-owned'
  const flags = headedLaunchArguments(profile)
  const product = 'Chrome/152.0.7977.82'
  const session = {
    async send(method) {
      if (method === 'Browser.getVersion')
        return {
          product,
          userAgent: 'Chrome/152.0.7977.82',
          revision: 'synthetic-version',
        }
      assert.equal(method, 'SystemInfo.getProcessInfo')
      return { processInfo: [{ id: 101, type: 'browser' }] }
    },
  }
  const observe = (arguments_) =>
    observeOwnedBrowserProvenance({
      session,
      taskRoot: '/fixture/task',
      ownerPid: 100,
      platform: 'linux',
      expectedProduct: product,
      requestedArguments: flags,
      requestedHeadless: false,
      acceptance: true,
      read: async (path) => {
        if (path.endsWith('/stat'))
          return `101 (chrome) S 100 ${Array(17).fill('0').join(' ')} 123456 0\n`
        assert.equal(path, '/proc/101/cmdline')
        return Buffer.from(['/fixture/chrome'].concat(arguments_, ['about:blank']).join(' ') + '\0')
      },
      readLink: async () => '/fixture/chrome',
    })
  await assert.rejects(
    observe(flags.slice(1).concat([flags[0]])),
    /Rendered profile boundary is ambiguous/,
  )
  const actual = await observe(flags)
  assert.equal(actual.observedProfile, profile)
  assert.equal(actual.environment.launchMode, 'headed')
  assert.equal(actual.originalExecveArguments, null)
  assert.deepEqual(actual.observedFlagTokens, flags)
})

test('the observed vendor-only page driver label matches CDP vendor/version, with exact Vulkan device identity', () => {
  const facts = observedFacts()
  const renderer =
    'ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA NVIDIA GeForce RTX 3060 Ti (0x00002489)), NVIDIA-610.57.4.0)'
  facts.gpu.auxAttributes.glRenderer = renderer
  Object.assign(facts.gpu.devices[0], {
    deviceString: renderer,
    driverVendor: 'NVIDIA',
    driverVersion: '610.57.4.0',
  })
  facts.gl.renderer =
    'ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA NVIDIA GeForce RTX 3060 Ti (0x00002489)), NVIDIA)'
  assertHeadedHardware(facts)
  const valid = facts.gl.renderer
  for (const invalid of [
    valid.replace('0x00002489', '0x00001234'),
    valid.replace('RTX 3060 Ti', 'Another GPU'),
    valid.replace('Vulkan 1.4.341', 'OpenGL 4.6'),
    valid.replace('Vulkan 1.4.341', 'Vulkan 1.3.341'),
    valid.replace('ANGLE (NVIDIA,', 'ANGLE (AMD,'),
    valid.replace('NVIDIA)', 'AMD)'),
    valid.replace('NVIDIA)', 'NVIDIA-unknown)'),
    'unknown',
  ]) {
    facts.gl.renderer = invalid
    assert.throws(() => assertHeadedHardware(facts))
  }
  facts.gl.renderer = valid
  facts.gpu.devices[0].driverVersion = 'unexpected'
  assert.throws(() => assertHeadedHardware(facts), /Page driver label/)
})

test('Linux process disappearance via ESRCH or ENOENT is gone; other OS errors remain unknown', async () => {
  const owned = { pid: 101, startTimeTicks: '123456' }
  for (const code of ['ENOENT', 'ESRCH']) {
    const gone = Object.assign(new Error('External proc disappearance'), {
      code,
    })
    assert.equal(
      await ownedProcessAlive(owned, async () => {
        throw gone
      }),
      false,
    )
  }
  const denied = Object.assign(new Error('External proc read denied'), {
    code: 'EACCES',
  })
  await assert.rejects(
    ownedProcessAlive(owned, async () => {
      throw denied
    }),
    denied,
  )
  const read =
    (start, state = 'S') =>
    async () =>
      `101 (chrome) ${state} 100 ${Array(17).fill('0').join(' ')} ${start} 0\n`
  assert.equal(await ownedProcessAlive(owned, read('123456')), true)
  assert.equal(await ownedProcessAlive(owned, read('123457')), false)
  assert.equal(await ownedProcessAlive(owned, read('123456', 'Z')), false)
})

test('multi-process cleanup state batches preserve the OS reader, independent of Array.map indexes', async () => {
  const owned = [
    { pid: 101, startTimeTicks: '123456' },
    { pid: 102, startTimeTicks: '123457' },
  ]
  const read = async (path) => {
    const pid = Number(path.split('/')[2])
    return `${pid} (chrome) S 100 ${Array(17).fill('0').join(' ')} ${pid === 101 ? '123456' : 'changed-lifetime'} 0\n`
  }
  const states = await ownedProcessStates(owned, read)
  assert.deepEqual(
    states.map(({ pid, alive }) => ({ pid, alive })),
    [
      { pid: 101, alive: true },
      { pid: 102, alive: false },
    ],
  )
  const vanished = await ownedProcessStates(owned, async () => {
    throw Object.assign(new Error('External process gone'), { code: 'ESRCH' })
  })
  assert(vanished.every((entry) => !entry.alive))
})

test('setup waits for exact inner and native content geometry twice before capturing ownership viewport', async () => {
  let count = 0
  const page = {
    evaluate: async () =>
      ++count === 1
        ? {
            width: 500,
            height: 431,
            outerWidth: 532,
            outerHeight: 560,
            dpr: 1,
            visibility: 'visible',
          }
        : {
            width: 922,
            height: 943,
            outerWidth: 922,
            outerHeight: 1030,
            dpr: 1,
            visibility: 'visible',
          },
  }
  const session = {
    send: async () => ({
      windowId: 7,
      bounds: {
        width: count === 1 ? 532 : 922,
        height: count === 1 ? 560 : 1030,
        windowState: 'normal',
      },
    }),
  }
  const observeWindow = async () => ({
    browserPid: 101,
    backend: 'wayland',
    mapped: true,
    hidden: false,
    xwayland: false,
    size: { width: 922, height: 1030 },
  })
  const ready = await settleOwnedWindowGeometry({
    page,
    session,
    observeWindow,
    browserPid: 101,
    windowId: 7,
    targetId: 'owned-page',
    smokeId: 'owned-smoke',
    viewport: { width: 922, height: 943 },
    deviceScaleFactor: 1,
    nativeContentInsets: { width: 0, height: 87 },
  })
  assert.equal(ready.snapshots.length, 3)
  assert.deepEqual(
    { width: ready.page.width, height: ready.page.height },
    { width: 922, height: 943 },
  )
  assert.equal(ready.snapshots[0].page.width, 500)
})

test('setup refuses native content sizes that contradict the registered inner viewport', async () => {
  const page = {
    evaluate: async () => ({
      width: 500,
      height: 431,
      outerWidth: 532,
      outerHeight: 560,
      dpr: 1,
      visibility: 'visible',
    }),
  }
  const session = {
    send: async () => ({
      windowId: 7,
      bounds: { width: 532, height: 560, windowState: 'normal' },
    }),
  }
  const observeWindow = async () => ({
    browserPid: 101,
    backend: 'wayland',
    mapped: true,
    hidden: false,
    xwayland: false,
    size: { width: 922, height: 1030 },
  })
  await assert.rejects(
    settleOwnedWindowGeometry({
      page,
      session,
      observeWindow,
      browserPid: 101,
      windowId: 7,
      targetId: 'owned-page',
      smokeId: 'owned-smoke',
      viewport: { width: 500, height: 431 },
      deviceScaleFactor: 1,
      nativeContentInsets: { width: 32, height: 129 },
    }),
    /geometry did not settle/,
  )
})

function workerGeometryBoundaries(overrides = {}) {
  let observations = 0
  return {
    page: {
      evaluate: async () => ({
        width: 480,
        height: 240,
        outerWidth: ++observations === 1 ? 500 : 520,
        outerHeight: 383,
        dpr: 2,
        visibility: 'visible',
        ...overrides.page,
      }),
    },
    session: {
      send: async () => ({
        windowId: 7,
        bounds: { width: observations === 1 ? 480 : 490, height: 383, windowState: 'normal' },
      }),
    },
    observeWindow: async () => ({
      browserPid: 101,
      backend: 'wayland',
      mapped: true,
      hidden: false,
      xwayland: false,
      size: { width: 960, height: 766, ...overrides.native },
    }),
    browserPid: 101,
    windowId: 7,
    targetId: 'owned-page',
    smokeId: 'owned-smoke',
    viewport: { width: 480, height: 240 },
    deviceScaleFactor: 2,
    nativeContentInsets: observedNativeContentInsets(
      { width: 1920, height: 1457, dpr: 2 },
      { width: 3840, height: 3200 },
    ),
  }
}

test('observed 480 CSS inner / 500 outer floor qualifies exact DPR2 native content', async () => {
  const ready = await settleOwnedWindowGeometry(workerGeometryBoundaries())
  assert.equal(ready.snapshots.length, 2)
  assert.equal(ready.snapshots[0].page.outerWidth, 500)
  assert.equal(ready.snapshots[0].window.bounds.width, 480)
  assert.equal(ready.page.outerWidth, 520)
  assert.equal(ready.window.bounds.width, 490)
  assert.deepEqual(ready.nativeContentSize, { width: 960, height: 480 })
  assert.deepEqual(ready.nativeContentInsets, { width: 0, height: 286 })
})

for (const [name, overrides] of [
  ['inner width', { page: { width: 481 } }],
  ['inner height', { page: { height: 241 } }],
  ['DPR', { page: { dpr: 1 } }],
  ['native content width', { native: { width: 961 } }],
  ['native content height', { native: { height: 767 } }],
]) {
  test(`outer metadata never admits a mismatched ${name}`, async () => {
    await assert.rejects(
      settleOwnedWindowGeometry(workerGeometryBoundaries(overrides)),
      /geometry did not settle/,
    )
  })
}

const nativeClient = {
  pid: 101,
  title: 'owned-smoke',
  class: 'chromium',
  mapped: true,
  hidden: false,
  xwayland: false,
  address: 'owned-address',
  size: [922, 1030],
}

test('owned lookup waits for delayed title and mapping without inspecting foreign titles', async () => {
  let clock = 0
  let calls = 0
  const observations = []
  const frames = [
    [{ ...nativeClient, title: 'about:blank' }],
    [{ ...nativeClient, mapped: false }],
    [nativeClient],
  ]
  const foreign = {
    pid: 999,
    get title() {
      assert.fail('Foreign title was inspected')
    },
  }
  const result = await waitForOwnedNonceWindow({
    browserPid: 101,
    smokeId: 'owned-smoke',
    readClients: async () => frames[calls++].concat([foreign]),
    onObservation: (observation) => observations.push(observation),
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds
    },
  })
  assert.equal(calls, 3)
  assert.equal(result.client, nativeClient)
  assert.deepEqual(result.observations, observations)
  assert.deepEqual(
    observations.map((observation) => observation.clients[0].title),
    ['about:blank', 'owned-smoke', 'owned-smoke'],
  )
  assert.deepEqual(
    observations.map((observation) => observation.clients[0].mapped),
    [true, false, true],
  )
  assert(
    observations.every((observation) => observation.clients.every((client) => client.pid === 101)),
  )
  assert.equal(JSON.stringify(observations).includes('999'), false)
})

test('lookup deadline rejects missing, foreign, unmapped and hidden windows with owned observations', async () => {
  for (const clients of [
    [],
    [{ ...nativeClient, pid: 999, title: 'FOREIGN_PRIVATE_TITLE' }],
    [{ ...nativeClient, mapped: false }],
    [{ ...nativeClient, hidden: true }],
  ]) {
    let clock = 0
    let calls = 0
    await assert.rejects(
      waitForOwnedNonceWindow({
        browserPid: 101,
        smokeId: 'owned-smoke',
        timeoutMilliseconds: 100,
        readClients: async () => {
          calls++
          return clients
        },
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds
        },
      }),
      (error) => {
        assert.match(error.message, /did not map before deadline/)
        assert.equal(error.ownedWindowObservations.length, 2)
        assert.equal(
          JSON.stringify(error.ownedWindowObservations).includes('FOREIGN_PRIVATE_TITLE'),
          false,
        )
        assert(
          error.ownedWindowObservations
            .flatMap((observation) => observation.clients)
            .every((client) => client.pid === 101),
        )
        return true
      },
    )
    assert.equal(calls, 2)
    assert.equal(clock, 100)
  }
})

test('lookup refuses ambiguous own windows and XWayland without retrying', async () => {
  for (const clients of [
    [nativeClient, { ...nativeClient, address: 'second' }],
    [{ ...nativeClient, xwayland: true }],
  ]) {
    let calls = 0
    await assert.rejects(
      waitForOwnedNonceWindow({
        browserPid: 101,
        smokeId: 'owned-smoke',
        readClients: async () => {
          calls++
          return clients
        },
      }),
      /Ambiguous|Native Wayland/,
    )
    assert.equal(calls, 1)
  }
})

test('lookup preserves only earlier owned observations when the external reader fails', async () => {
  let calls = 0
  let clock = 0
  await assert.rejects(
    waitForOwnedNonceWindow({
      browserPid: 101,
      smokeId: 'owned-smoke',
      readClients: async () => {
        if (calls++) assert.fail('External compositor unavailable')
        return [
          { ...nativeClient, title: 'about:blank' },
          { ...nativeClient, pid: 999, title: 'FOREIGN_PRIVATE_TITLE' },
        ]
      },
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds
      },
    }),
    (error) => {
      assert.match(error.message, /External compositor unavailable/)
      assert.equal(error.ownedWindowObservations.length, 1)
      assert.equal(error.ownedWindowObservations[0].clients[0].title, 'about:blank')
      assert.equal(
        JSON.stringify(error.ownedWindowObservations).includes('FOREIGN_PRIVATE_TITLE'),
        false,
      )
      return true
    },
  )
})

test('lookup bounds an external reader that never responds', async () => {
  await assert.rejects(
    waitForOwnedNonceWindow({
      browserPid: 101,
      smokeId: 'owned-smoke',
      timeoutMilliseconds: 20,
      readClients: () => new Promise(() => {}),
    }),
    (error) => {
      assert.equal(error.ownedWindowObservations.length, 0)
      return true
    },
  )
})

test('static launch scope check detects a cleanup-local identity referenced from launch', async (t) => {
  let binary
  try {
    const require = createRequire(import.meta.url)
    binary = join(require.resolve('oxlint/package.json'), '..', 'bin', 'oxlint')
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    t.skip('Optional Oxlint scope checker is absent; install repository dev dependencies to run it')
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'headed-launch-scope-'))
  try {
    const source = await readFile(new URL('./comparison-headed.mjs', import.meta.url), 'utf8')
    const faulty = source.replace(
      'browserPid: provenance.browserPid,\n          browserIdentity,',
      'browserPid: provenance.browserPid,\n          browserIdentity: rootIdentity,',
    )
    assert.notEqual(faulty, source, 'Known-bad scope fixture must alter the launch call site')
    const goodFile = join(directory, 'good.mjs')
    const badFile = join(directory, 'bad.mjs')
    const config = join(directory, 'scope.json')
    await writeFile(goodFile, source)
    await writeFile(badFile, faulty)
    await writeFile(
      config,
      JSON.stringify({
        env: { browser: true, node: true },
        rules: { 'no-undef': 'error' },
      }),
    )
    const check = (file) =>
      promisify(execFile)(
        process.execPath,
        [binary, '--config', config, '-A', 'all', '-D', 'no-undef', '--no-ignore', file],
        { cwd: directory, timeout: 5000, maxBuffer: 100000 },
      )
    await assert.rejects(check(badFile), (error) => {
      assert.match(error.stdout + error.stderr, /rootIdentity/)
      return true
    })
    await check(goodFile)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('physical Vulkan adapter facts cannot override an observed incompatible native surface transport', () => {
  assert.doesNotThrow(() => assertHeadedHardware(observedFacts()))
  assert.doesNotThrow(() => assertHeadedSurfaceTransport(''))
  assert.doesNotThrow(() =>
    assertHeadedSurfaceTransport('WARNING: optional desktop portal is unavailable'),
  )
  assert.throws(
    () =>
      assertHeadedSurfaceTransport(
        "ERROR:wayland_surface_factory.cc:249] '--ozone-platform=wayland' is not compatible with Vulkan. Consider switching to '--ozone-platform=x11' or disabling Vulkan",
      ),
    /surface transport rejects native Wayland with Vulkan/,
  )
  assert.throws(
    () => assertHeadedSurfaceTransport(undefined),
    /Observed Chrome diagnostics required/,
  )
})

test('cleanup waits for the owned child exit notification before asserting it', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'headed-exit-test-'))
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  const cleanup = {}
  const server = {
    closeAllConnections() {
      cleanup.connectionsClosed = true
    },
    close(done) {
      done()
    },
  }
  const pending = finishOwnedLaunchCleanup({ child, server, profile, cleanup })
  setImmediate(() => {
    child.exitCode = 0
    child.emit('exit', 0, null)
  })
  await pending
  assert.equal(cleanup.browserExited, true)
  assert.equal(cleanup.connectionsClosed, true)
  assert.equal(cleanup.serverClosed, true)
  assert.equal(cleanup.profileRemoved, true)
  assert.equal(child.listenerCount('exit'), 0)
  await assert.rejects(readFile(profile), { code: 'ENOENT' })
})

test('missing child exit notification still closes the server and removes its owned profile', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'headed-exit-timeout-'))
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  const cleanup = {}
  const server = {
    closeAllConnections() {
      cleanup.connectionsClosed = true
    },
    close(done) {
      done()
    },
  }
  await assert.rejects(
    finishOwnedLaunchCleanup({
      child,
      server,
      profile,
      cleanup,
      exitTimeoutMilliseconds: 20,
    }),
    /Owned browser exit must be observed/,
  )
  assert.equal(cleanup.browserExited, false)
  assert.equal(cleanup.connectionsClosed, true)
  assert.equal(cleanup.serverClosed, true)
  assert.equal(cleanup.profileRemoved, true)
  assert.equal(typeof cleanup.browserExitError, 'string')
  assert.equal(child.listenerCount('exit'), 0)
  await assert.rejects(readFile(profile), { code: 'ENOENT' })
})

test('server close failure still removes the owned profile', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'headed-server-error-'))
  const cleanup = {}
  const server = {
    closeAllConnections() {},
    close(done) {
      done({ code: 'EIO' })
    },
  }
  await assert.rejects(
    finishOwnedLaunchCleanup({ server, profile, cleanup }),
    /fixture server cleanup failed/,
  )
  assert.equal(cleanup.browserExited, true)
  assert.equal(cleanup.profileRemoved, true)
  assert.equal(typeof cleanup.serverCloseError, 'string')
  await assert.rejects(readFile(profile), { code: 'ENOENT' })
})

test('observed page OpenGL identity qualifies when only browser diagnostics expose the driver suffix', () => {
  const browser =
    'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Ti/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 610.57.04)'
  const page = 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060 Ti/PCIe/SSE2, OpenGL 4.5.0)'
  const identity = matchingGlRendererIdentity(browser, page)
  assert.equal(identity.vendor, 'NVIDIA Corporation')
  assert.equal(identity.deviceDescription, 'NVIDIA GeForce RTX 3060 Ti/PCIe/SSE2')
  assert.equal(identity.openGlVersion, '4.5.0')
  assert.equal(identity.driverLabel, 'NVIDIA 610.57.04')
  assert.deepEqual(identity.rawRendererStrings, { browser, page })
  assert.deepEqual(matchingGlRendererIdentity(browser, browser).rawRendererStrings, {
    browser,
    page: browser,
  })
  for (const rejected of [
    page.replace('NVIDIA Corporation', 'Other vendor'),
    page.replace('RTX 3060 Ti', 'RTX 3070'),
    page.replace('4.5.0', '4.6.0'),
    page.replace('RTX 3060 Ti', 'llvmpipe'),
    browser.replace('610.57.04', 'other driver'),
    page.replace('OpenGL', 'Vulkan'),
  ])
    assert.throws(() => matchingGlRendererIdentity(browser, rejected))
  assert.throws(() => matchingGlRendererIdentity(page, browser), /driver identities must match/)
})

for (const scenario of [
  'healthy',
  'discovery-error',
  'termination-error',
  'reused-pid',
  'orphan-descendant',
  'profile-init',
  'late-transport',
  'truncated-transport',
  'launch-native-contradiction',
  'launch-no-resize',
  'launch-calibration-target',
  'healthy-delayed-calibration',
]) {
  test(
    `actual launch and cleanup respect external ${scenario} boundaries`,
    { timeout: 20_000 },
    async () => {
      const execute = promisify(execFile)
      const script = new URL('./fixtures/headed-launch-boundaries.mjs', import.meta.url)
      const { stdout } = await execute(
        process.execPath,
        ['--experimental-vm-modules', fileURLToPath(script), scenario],
        {
          timeout: 15000,
          maxBuffer: 1_000_000,
        },
      )
      const result = JSON.parse(stdout)
      assert.equal(result.mockedExternalBoundariesOnly, true)
      assert.equal(result.realChromeLaunches, 0)
    },
  )
}
