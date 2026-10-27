import { testFontUrl } from '../../tests/fonts.js'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { Terminal as MainTerminal } from '../terminal.js'
import type { GhosttyWebGpuTerminalOptions, TerminalOutputTiming } from '../types.js'
import type { TerminalApi } from '../terminal-api.js'
import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'

const terminals: TerminalApi[] = []
const hosts: HTMLElement[] = []
let runtime: GhosttyRuntime
beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterEach(async () => {
  for (const terminal of terminals.splice(0).reverse()) await terminal.dispose()
  for (const host of hosts.splice(0)) host.remove()
})
afterAll(() => runtime.dispose())

function host(): HTMLDivElement {
  const value = document.createElement('div')
  value.style.cssText = 'width:480px;height:160px;position:relative'
  document.body.append(value)
  hosts.push(value)
  return value
}

async function openMain(
  rendererMode: GhosttyWebGpuTerminalOptions['rendererMode'],
  presentation: GhosttyWebGpuTerminalOptions['presentation'],
) {
  const terminal = await MainTerminal.create({
    rendererMode,
    presentation,
    outputTiming: { quietMs: 30 },
    appearance: { cursor: { blink: false }, font: { family: 'monospace', size: 16 } },
    runtime: { kind: 'borrowed', runtime },
  })
  terminals.push(terminal)
  await terminal.open(host())
  await expect.poll(() => terminal.hasPendingFrame).toBe(false)
  return terminal
}

function nextTiming(terminal: TerminalApi): Promise<TerminalOutputTiming> {
  return new Promise((resolve) => {
    const subscription = terminal.on('outputTiming', (timing) => {
      subscription.dispose()
      resolve(timing)
    })
  })
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function expectOrdered(times: readonly (number | undefined)[]): void {
  for (const time of times) expect(time).toEqual(expect.any(Number))
  for (let index = 1; index < times.length; index += 1)
    expect(times[index]!).toBeGreaterThanOrEqual(times[index - 1]!)
}

it.for([
  ['auto', 'frame'],
  ['auto', 'immediate'],
  ['canvas2d-fill-text', 'frame'],
  ['canvas2d-fill-text', 'immediate'],
] as const)(
  'times %s output with %s presentation from input to the shown frame',
  async ([rendererMode, presentation]) => {
    const terminal = await openMain(rendererMode, presentation)
    const timing = nextTiming(terminal)

    terminal.sendInput('l')
    await pause(5)
    terminal.write('first ')
    await pause(5)
    terminal.write('second')

    const result = await timing
    expectOrdered([
      result.inputAt,
      result.firstOutputAt,
      result.lastOutputAt,
      result.drawnAt,
      result.presentedAt,
    ])
    expect(result.writes).toBe(2)
    expect(result.presentation).toBe(presentation)
    expect(result.rendererBackend).toBe(terminal.diagnostics.rendererBackend)
    expect(result.desynchronized).toBe(terminal.diagnostics.desynchronized)
  },
)

it('reports a later burst separately once output pauses', async () => {
  const terminal = await openMain('canvas2d-fill-text', 'frame')
  const results: TerminalOutputTiming[] = []
  terminal.on('outputTiming', (timing) => results.push(timing))

  terminal.write('one')
  await expect.poll(() => results.length).toBe(1)
  terminal.sendInput('x')
  terminal.write('two')
  await expect.poll(() => results.length).toBe(2)

  expect(results[0]?.inputAt).toBeUndefined()
  expect(results[1]?.inputAt).toBeLessThanOrEqual(results[1]!.firstOutputAt)
  expect(results[1]!.firstOutputAt).toBeGreaterThan(results[0]!.lastOutputAt)
})

it("pairs output with typed input, not with the terminal's own replies", async () => {
  const terminal = await openMain('canvas2d-fill-text', 'frame')
  const replies: Uint8Array[] = []
  terminal.onData(({ bytes: data }) => replies.push(data))
  const first = nextTiming(terminal)

  terminal.write('\x1b[c')
  await first
  expect(replies.length).toBeGreaterThan(0)
  const second = nextTiming(terminal)
  terminal.write('after reply')

  expect((await second).inputAt).toBeUndefined()
})

it('forgets input once the last listener leaves', async () => {
  const terminal = await openMain('canvas2d-fill-text', 'frame')
  const subscription = terminal.on('outputTiming', () => {})
  terminal.sendInput('l')
  subscription.dispose()
  const timing = nextTiming(terminal)

  terminal.write('later')

  expect((await timing).inputAt).toBeUndefined()
})

it('records nothing while no one listens', async () => {
  const terminal = await openMain('canvas2d-fill-text', 'frame')
  const events: TerminalOutputTiming[] = []
  const subscription = terminal.on('outputTiming', (timing) => events.push(timing))
  subscription.dispose()

  terminal.write('quiet')
  await pause(80)

  expect(events).toEqual([])
})

it('times worker output up to the frame notice', async () => {
  const terminal = await WorkerTerminal.create({
    outputTiming: { quietMs: 30 },
    appearance: { cursor: { blink: false } },
    fonts: [{ family: 'OutputTimingWorkerTest', source: { url: testFontUrl } }],
    workerUrl: new URL('../../../dist/worker/entry.js', import.meta.url),
    assets: {
      wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
      bridge: new URL('../../../bridge.wasm', import.meta.url).href,
    },
  })
  terminals.push(terminal)
  await terminal.open(host())
  const timing = nextTiming(terminal)

  await terminal.write('worker')
  const result = await timing

  expectOrdered([result.firstOutputAt, result.lastOutputAt, result.drawnAt])
  expect(result.presentedAt).toBeUndefined()
  expect(result.presentation).toBe('frame')
  await expect.poll(() => terminal.visibleLines()[0]).toContain('worker')
})
