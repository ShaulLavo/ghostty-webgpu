import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { promisify } from 'node:util'

const scenario = process.argv[2]
const scenarios = [
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
]
assert(scenarios.includes(scenario))
const geometryScenario = scenario.startsWith('launch-')
let nativeSize = geometryScenario ? { width: 922, height: 1030 } : { width: 480, height: 560 }
let windowState = 'normal'
let resized = false
let delayedCalibrationRead = false
const scripts = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(scripts, 'comparison-presentation.mjs'))
const { PNG } = require('pngjs')
const browserPid = 51001
const gpuPid = 51002
const parentPid = 40000
const executable = '/fixture/chrome'
const taskRoot = '/fixture/task'
const profile = taskRoot + '/tmp/chrome-owned'
const renderer =
  'ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA NVIDIA GeForce RTX 3060 Ti (0x00002489)), NVIDIA-610.57.4.0)'
const processes = new Map()
const events = []
let profileAllocated = false
let serverListening = false
let asyncRootReads = 0
let child
let handler
let ownedPage
let pageUrl
let scissor
let color = [255, 255, 255]
let screencast = false
let sequence = 0
const image = new PNG({ width: 320, height: 440 })
image.data.fill(255)
const session = new EventEmitter()

function externalFailure(code) {
  const error = new Error('External boundary failure ' + code)
  error.code = code
  return error
}
function statText(pid) {
  const owner = processes.get(pid)
  if (!owner) throw externalFailure('ENOENT')
  const fields = Array(20).fill('0')
  fields[0] = 'S'
  fields[1] = String(owner.parent)
  fields[2] = String(owner.group)
  fields[19] = String(owner.birth)
  return `${pid} (fixture-chrome) ${fields.join(' ')}\n`
}
function spawn(command, args) {
  assert.equal(command, executable)
  processes.set(browserPid, {
    parent: parentPid,
    group: browserPid,
    birth: '100',
    argv: [command].concat(args),
  })
  if (
    scenario === 'orphan-descendant' ||
    scenario.includes('transport') ||
    scenario.startsWith('healthy') ||
    geometryScenario
  )
    processes.set(gpuPid, {
      parent: browserPid,
      group: browserPid,
      birth: '101',
      argv: [command, '--type=gpu-process'],
    })
  child = new EventEmitter()
  Object.assign(child, {
    pid: browserPid,
    exitCode: null,
    signalCode: null,
    stderr: new EventEmitter(),
  })
  return child
}
function synchronousRead(path) {
  if (scenario === 'reused-pid') {
    child.exitCode = 0
    processes.set(browserPid, {
      parent: 99999,
      group: browserPid,
      birth: '900',
      argv: ['foreign'],
    })
    throw externalFailure('ENOENT')
  }
  assert.equal(path, `/proc/${browserPid}/stat`)
  events.push('launch-birth-read-synchronously')
  return statText(browserPid)
}
const mockFs = {
  realpath: async (path) => path,
  mkdir: async () => {},
  mkdtemp: async () => {
    profileAllocated = true
    return profile
  },
  chmod: async () => {
    if (scenario === 'profile-init') throw externalFailure('EIO')
  },
  lstat: async (path) => ({
    uid: 1000,
    mode: 0o700,
    dev: 1,
    ino: 1,
    size: 4,
    isDirectory: () => path !== executable,
    isFile: () => path === executable,
  }),
  open: async () => ({
    read: async (buffer) => Buffer.from('7f454c46', 'hex').copy(buffer),
    close: async () => {},
  }),
  rm: async (path) => {
    assert.equal(path, profile)
    profileAllocated = false
    events.push('profile-finalized')
  },
  readdir: async (path) => {
    assert.equal(path, '/proc')
    if (scenario === 'discovery-error') throw externalFailure('EACCES')
    return [...processes.keys()].map(String)
  },
  readlink: async (path) => {
    assert(/^\/proc\/\d+\/exe$/.test(path))
    return executable
  },
  readFile: async (path, encoding) => {
    if (path === profile + '/DevToolsActivePort') {
      if (scenario === 'orphan-descendant') {
        processes.delete(browserPid)
        child.exitCode = 0
        throw externalFailure('EIO')
      }
      if (['discovery-error', 'termination-error'].includes(scenario)) throw externalFailure('EIO')
      return '43001\n/devtools/browser/fixture\n'
    }
    const match = path.match(/^\/proc\/(\d+)\/(stat|cmdline)$/)
    assert(match, 'Only external virtual proc/profile reads are allowed')
    const pid = Number(match[1])
    if (scenario === 'reused-pid' && pid === browserPid && asyncRootReads++ === 0) {
      child.exitCode = 0
      processes.set(browserPid, {
        parent: 99999,
        group: browserPid,
        birth: '900',
        argv: ['foreign'],
      })
      throw externalFailure('ENOENT')
    }
    if (match[2] === 'stat') return statText(pid)
    const bytes = Buffer.from(processes.get(pid).argv.join(' ') + '\0')
    return encoding ? bytes.toString(encoding) : bytes
  },
}
const mockProcess = {
  pid: parentPid,
  platform: 'linux',
  getuid: () => 1000,
  kill(pid, signal) {
    events.push({ signal, pid, birth: processes.get(pid)?.birth })
    if (scenario === 'termination-error') throw externalFailure('EPERM')
    processes.delete(pid)
    if (pid === browserPid) {
      child.exitCode = 0
      child.emit('exit', 0, null)
    }
  },
}
function createServer(callback) {
  handler = callback
  const server = new EventEmitter()
  return Object.assign(server, {
    once: server.once.bind(server),
    listen(port, host, done) {
      assert.equal(port, 0)
      assert.equal(host, '127.0.0.1')
      serverListening = true
      done()
    },
    address: () => ({ port: 43001 }),
    closeAllConnections() {},
    close(done) {
      serverListening = false
      events.push('server-finalized')
      done()
    },
  })
}
function execFile(command, args, options, callback) {
  assert.equal(command, executable)
  assert.deepEqual(Array.from(args), ['--version'])
  callback(null, 'Chromium 123.0.0.0\n', '')
}
execFile[promisify.custom] = async (...args) =>
  await new Promise((resolve, reject) =>
    execFile(...args, (error, stdout, stderr) =>
      error ? reject(error) : resolve({ stdout, stderr }),
    ),
  )
const gl = {
  SCISSOR_TEST: 3089,
  COLOR_BUFFER_BIT: 16384,
  isContextLost: () => false,
  getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37446 }),
  getParameter: () => renderer,
  disable: () => {
    scissor = null
  },
  enable() {},
  clearColor: (...rgba) => {
    color = rgba.slice(0, 3).map((value) => Math.round(value * 255))
  },
  scissor: (...rect) => {
    scissor = rect
  },
  clear() {
    const [left, bottom, width, height] = scissor ?? [0, 0, 320, 320]
    for (let y = 320 - bottom - height; y < 320 - bottom; y++)
      for (let x = left; x < left + width; x++) {
        const offset = (y * 320 + x) * 4
        image.data.set(color.concat([255]), offset)
      }
  },
  flush() {
    if (!screencast) return
    sequence++
    if (sequence === 1 && scenario.includes('transport')) {
      const diagnostic = "'--ozone-platform=wayland' is not compatible with Vulkan"
      if (scenario === 'truncated-transport') child.stderr.emit('data', Buffer.alloc(64000, 120))
      child.stderr.emit('data', Buffer.from(diagnostic.slice(0, 33)))
      child.stderr.emit('data', Buffer.from(diagnostic.slice(33)))
    }
    session.emit('Page.screencastFrame', {
      sessionId: sequence,
      data: PNG.sync.write(image).toString('base64'),
      metadata: {
        deviceWidth: 320,
        deviceHeight: 440,
        offsetTop: 0,
        pageScaleFactor: 1,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        timestamp: sequence,
      },
    })
  },
}
const pageContext = vm.createContext({
  innerWidth: geometryScenario ? 500 : 320,
  innerHeight: geometryScenario ? 431 : 440,
  outerWidth: 480,
  outerHeight: 560,
  devicePixelRatio: 1,
  document: {
    visibilityState: 'visible',
    querySelector: () => ({ getContext: () => gl, height: 320 }),
  },
  location: { href: '' },
})
vm.runInContext('window=globalThis', pageContext)
const page = {
  url: () => pageUrl,
  bringToFront: async () => {},
  goto: async (url) => {
    pageUrl = url
    pageContext.location.href = url
    let html
    const response = {
      writeHead: () => response,
      end: (value) => {
        html = value
      },
    }
    handler({ url: new URL(url).pathname + new URL(url).search }, response)
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], pageContext)
  },
  evaluate: async (fn, input) => {
    const result = vm.runInContext('(' + fn.toString() + ')', pageContext)(input)
    if (
      scenario === 'healthy-delayed-calibration' &&
      windowState === 'maximized' &&
      !delayedCalibrationRead
    ) {
      delayedCalibrationRead = true
      pageContext.innerWidth = 1468
      pageContext.innerHeight = 1071
      events.push('delayed-calibration-page-delivered')
    }
    return result
  },
}
session.send = async (method, parameters) => {
  if (method === 'Browser.setWindowBounds') {
    assert.equal(parameters.windowId, 7)
    if (parameters.bounds.windowState === 'maximized') {
      windowState = 'maximized'
      if (scenario !== 'launch-calibration-target') {
        nativeSize = { width: 1500, height: 1200 }
        if (scenario !== 'healthy-delayed-calibration') {
          pageContext.innerWidth = 1468
          pageContext.innerHeight = 1071
        }
      }
      events.push('calibration-maximized')
      return {}
    }
    if (parameters.bounds.windowState === 'normal') {
      windowState = 'normal'
      return {}
    }
    assert.equal(windowState, 'normal')
    assert.deepEqual(
      { ...parameters.bounds },
      {
        width: pageContext.devicePixelRatio * (geometryScenario ? 500 : 320) + 32,
        height: pageContext.devicePixelRatio * (geometryScenario ? 431 : 440) + 129,
      },
    )
    if (scenario === 'launch-no-resize') {
      events.push('target-resize-request-ignored')
      return {}
    }
    nativeSize = geometryScenario ? { width: 922, height: 1030 } : { ...parameters.bounds }
    pageContext.innerWidth = geometryScenario ? 500 : 320
    pageContext.innerHeight = geometryScenario ? 431 : 440
    resized = true
    events.push('target-resize')
    return {}
  }
  if (method === 'Browser.getVersion')
    return {
      product: 'Chrome/123.0.0.0',
      userAgent: 'Chrome/123.0.0.0',
      revision: 'fixture',
    }
  if (method === 'SystemInfo.getProcessInfo')
    return {
      processInfo: [
        { id: browserPid, type: 'browser' },
        { id: gpuPid, type: 'GPU' },
      ],
    }
  if (method === 'SystemInfo.getInfo')
    return {
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
    }
  if (method === 'Target.getTargetInfo')
    return {
      targetInfo: { targetId: 'fixture-target', type: 'page', url: pageUrl },
    }
  if (method === 'Browser.getWindowForTarget')
    return {
      windowId: 7,
      bounds: { width: nativeSize.width, height: nativeSize.height, windowState },
    }
  if (method === 'Page.startScreencast') {
    screencast = true
    return {}
  }
  if (method === 'Page.stopScreencast') {
    screencast = false
    return {}
  }
  if (method === 'Page.screencastFrameAck') return {}
  assert.fail('Unexpected external CDP method ' + method)
}
const browserContext = {
  pages: () => [page],
  newCDPSession: async () => session,
}
const browser = {
  contexts: () => [browserContext],
  newBrowserCDPSession: async () => session,
  close: async () => {},
}
const overrides = new Map([
  ['node:fs/promises', mockFs],
  ['node:path', posix],
  ['node:fs', { readFileSync: synchronousRead }],
  ['node:child_process', { execFile, spawn }],
  ['node:http', { createServer }],
  ['playwright', { chromium: { connectOverCDP: async () => browser } }],
  ['pngjs', { PNG }],
])
const context = vm.createContext({
  process: mockProcess,
  Buffer,
  TextDecoder,
  TextEncoder,
  URL,
  setTimeout,
  clearTimeout,
  performance,
  console,
})
const cache = new Map()
async function load(identifier) {
  if (cache.has(identifier)) return cache.get(identifier)
  let module
  if (overrides.has(identifier) || identifier.startsWith('node:')) {
    const exports = overrides.get(identifier) ?? (await import(identifier))
    module = new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const key of Object.keys(exports)) this.setExport(key, exports[key])
      },
      { context, identifier },
    )
  } else {
    assert(
      identifier.startsWith(join(scripts, 'comparison-')),
      'Only actual owned helper modules are loaded',
    )
    module = new vm.SourceTextModule(await fs.readFile(identifier, 'utf8'), {
      context,
      identifier,
      initializeImportMeta: (meta) => {
        meta.url = pathToFileURL(identifier).href
      },
    })
  }
  cache.set(identifier, module)
  return module
}
const entry = await load(join(scripts, 'comparison-headed.mjs'))
await entry.link((specifier, parent) =>
  load(
    specifier.startsWith('.')
      ? fileURLToPath(new URL(specifier, pathToFileURL(parent.identifier)))
      : specifier,
  ),
)
await entry.evaluate()
let evidence
let failure
try {
  const options = {
    executablePath: executable,
    taskRoot,
    viewport: geometryScenario ? { width: 500, height: 431 } : { width: 320, height: 440 },
    observeWindow: async (input) => ({
      browserPid: input.browserPid,
      backend: 'wayland',
      mapped: true,
      hidden: false,
      xwayland: false,
      size: { ...nativeSize },
    }),
  }
  if (scenario.includes('transport') || scenario.startsWith('healthy'))
    evidence = await entry.namespace.runHeadedPresentationSmoke(options)
  else {
    ownedPage = await entry.namespace.launchOwnedHeadedBrowser(options)
    evidence = ownedPage.evidence
    await ownedPage.close()
  }
} catch (error) {
  failure = String(error)
  evidence = error.launchEvidence ?? ownedPage?.evidence
}
const result = {
  scenario,
  mockedExternalBoundariesOnly: true,
  realChromeLaunches: 0,
  failure,
  evidence,
  events,
  serverListening,
  profileAllocated,
  remainingVirtualProcesses: [...processes.entries()],
}
console.log(JSON.stringify(result))
if (scenario !== 'profile-init')
  assert(child, 'The actual launch must reach the controlled browser boundary')
assert.equal(
  serverListening,
  false,
  'Fixture server must finalize despite earlier cleanup failures',
)
assert.equal(
  profileAllocated,
  false,
  'Allocated profile must finalize despite initialization or process failures',
)
if (scenario === 'reused-pid')
  assert.equal(
    events.filter((event) => event.pid === browserPid).length,
    0,
    'A replacement PID must never be adopted or signalled',
  )
if (scenario === 'orphan-descendant')
  assert.equal(
    processes.has(gpuPid),
    false,
    'Owned group descendants must stop after early root death',
  )
if (scenario.includes('transport')) {
  assert(failure, 'Late incompatible transport must reject successful readback')
  assert.notEqual(evidence?.status, 'PASS_SETUP_ONLY')
}
if (geometryScenario) {
  assert(failure, 'Production launch must reject contradiction or an unobserved native resize')
  const reuse = scenario === 'launch-calibration-target'
  assert.match(failure, reuse ? /must require a native resize/ : /geometry did not settle/)
  assert.equal(resized, scenario === 'launch-native-contradiction')
  assert.deepEqual(
    { ...evidence.nativeContentInsets },
    reuse ? { width: 422, height: 599 } : { width: 32, height: 129 },
  )
  assert.equal(evidence.geometryResize.observations.length, reuse ? 0 : 20)
  assert.equal(evidence.geometry, undefined)
  assert.equal(processes.size, 0)
}
if (scenario.startsWith('healthy')) {
  assert.equal(failure, undefined)
  assert.equal(evidence.status, 'PASS_SETUP_ONLY')
  assert.equal(evidence.geometryCalibration.calibrationOnly, true)
  assert.equal(
    evidence.geometryCalibration.observations.length,
    scenario === 'healthy-delayed-calibration' ? 3 : 2,
  )
  assert.deepEqual({ ...evidence.nativeContentInsets }, { width: 32, height: 129 })
  assert.deepEqual({ ...evidence.geometry.nativeContentSize }, { width: 320, height: 440 })
  assert.equal(evidence.geometryResize.observed, true)
  assert.equal(evidence.geometryResize.observations.length, 2)
  assert(events.indexOf('calibration-maximized') < events.indexOf('target-resize'))
  assert.equal(processes.size, 0)
}
