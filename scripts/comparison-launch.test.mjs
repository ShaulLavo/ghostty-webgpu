import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  accessibilityMode,
  browserExecutable,
  hardwareLaunch,
  measurementPhases,
  selectedPhases,
} from './comparison-options.mjs'

const source = await readFile(new URL('./comparison-runner.mjs', import.meta.url), 'utf8')
const start = source.indexOf('const args = process.argv.slice(2)')
const end = source.indexOf('\nconst value =', start)
assert(start >= 0 && end > start)
const configure = new Function(
  'process',
  'platform',
  'assert',
  'accessibilityMode',
  'selectedPhases',
  'hardwareLaunch',
  'browserExecutable',
  `${source.slice(start, end)}\nreturn { smoke, tracing, phases, launch, headless }`,
)

function options(host, args) {
  return configure(
    { argv: ['node', 'comparison-runner.mjs', ...args] },
    () => host,
    assert,
    accessibilityMode,
    selectedPhases,
    hardwareLaunch,
    browserExecutable,
  )
}

test('ordinary Linux --headed preserves hardware launch flags and measurement mode', () => {
  const defaults = options('linux', [])
  const headed = options('linux', ['--headed'])
  assert.equal(defaults.headless, true)
  assert.equal(headed.headless, false)
  assert.equal(headed.smoke, false)
  assert.equal(headed.tracing, false)
  assert.deepEqual(headed.phases, measurementPhases)
  assert.deepEqual(headed.launch.arguments, defaults.launch.arguments)
  assert.deepEqual(headed.launch.arguments, [
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
    '--ignore-gpu-blocklist',
  ])
})

test('headed Chromium launch retains the ordinary hardware GPU requirement', async () => {
  const optionsStart = source.indexOf("let browserChannel = 'chromium'")
  const optionsEnd = source.indexOf('\nlet browser', optionsStart)
  const launchStart = source.indexOf('  browser = await chromium.launch(browserLaunchOptions)')
  const launchEnd = source.indexOf('\n  artifact.environment =', launchStart)
  const rendererStart = source.indexOf('function renderer(info) {')
  const rendererEnd = source.indexOf('\n}', rendererStart) + 2
  assert(optionsStart >= 0 && optionsEnd > optionsStart)
  assert(launchStart >= 0 && launchEnd > launchStart)
  assert(rendererStart >= 0 && rendererEnd > rendererStart)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const launch = new AsyncFunction(
    'chromium',
    'platform',
    'headless',
    'browserArgs',
    'launchEnv',
    'smoke',
    'assert',
    `let browser, browserSession; const artifact = {}; const executablePath = undefined;
${source.slice(optionsStart, optionsEnd)}
${source.slice(rendererStart, rendererEnd)}
${source.slice(launchStart, launchEnd)}
return artifact.hardware`,
  )
  const args = options('linux', ['--headed']).launch.arguments
  const env = {}
  for (const renderer of ['ANGLE hardware GPU', 'SwiftShader', 'llvmpipe', 'unknown']) {
    const chromium = {
      launch: async (actual) => {
        assert.deepEqual(actual, {
          channel: 'chromium',
          executablePath: undefined,
          headless: false,
          args,
          env,
        })
        return {
          newBrowserCDPSession: async () => ({
            send: async (method) => {
              assert.equal(method, 'SystemInfo.getInfo')
              return { gpu: { auxAttributes: { glRenderer: renderer } } }
            },
          }),
        }
      },
    }
    const run = () => launch(chromium, () => 'linux', false, args, env, false, assert)
    if (renderer === 'ANGLE hardware GPU') {
      assert.equal(await run(), true)
      continue
    }
    await assert.rejects(run, /Hardware GPU required for measurements/)
  }
})

test('--headed is independent of smoke, trace and selected phases on both hosts', () => {
  for (const host of ['linux', 'darwin']) {
    assert.equal(options(host, []).headless, host === 'linux')
    assert.equal(options(host, ['--smoke']).headless, true)
    const smoke = options(host, ['--smoke', '--headed'])
    assert.equal(smoke.headless, false)
    assert.equal(smoke.smoke, true)
    assert.equal(smoke.tracing, false)
    assert.deepEqual(smoke.phases, measurementPhases)
    assert.deepEqual(smoke.launch.arguments, [])
    const ordinary = options(host, ['--headed', '--phases', 'output,latency'])
    assert.equal(ordinary.headless, false)
    assert.equal(ordinary.smoke, false)
    assert.deepEqual(ordinary.phases, ['output', 'latency'])
    const trace = options(host, ['--trace', '--headed'])
    assert.equal(trace.headless, false)
    assert.equal(trace.tracing, true)
    assert.equal(trace.smoke, false)
  }
})
