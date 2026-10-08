import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { Terminal as MainTerminal, attachTerminalHotkeys } from '../../dist/index.js'
import { Terminal as WorkerTerminal, TerminalWorkerError } from '../../dist/worker/index.js'
import type { TerminalApi } from '../../dist/dom/terminal-api.js'
import { WebGlTerminalRenderer } from '../../dist/render/webgl/renderer.js'
import { createDomInputController } from '../../dist/dom/input.js'
import type {
  TerminalOutputReady,
  TerminalOutputMessage,
  TerminalOutputAck,
  WorkerMessage,
} from './protocol.js'
import type { DeviceObservation } from './tests/device-loss.worker.js'
import type { DeviceLifecycleObservation } from './tests/device-lifecycle.worker.js'
import { observeDevice, type DeviceLifecycleCounts } from './tests/device-lifecycle.js'

const family = 'PackagedWorkerTest'
const fontUrl = new URL(
  '../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2',
  import.meta.url,
).href
const workerUrl = new URL('../../dist/worker/entry.js', import.meta.url)
const assets = {
  wasm: new URL('../../ghostty-vt.wasm', import.meta.url).href,
  bridge: new URL('../../bridge.wasm', import.meta.url).href,
}
const active: TerminalApi[] = []
const containers: HTMLElement[] = []
afterEach(async () => {
  for (const terminal of active.splice(0)) await terminal.dispose()
  for (const container of containers.splice(0)) container.remove()
})
function container(): HTMLDivElement {
  const value = document.createElement('div')
  value.style.cssText = 'width:480px;height:160px;position:relative'
  document.body.append(value)
  containers.push(value)
  return value
}
async function eventually(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await condition())) {
    if (Date.now() > deadline) expect.fail('Submitted worker frame did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function create(mode: 'main' | 'webgpu' | 'webgl') {
  const appearance = { font: { family, size: 16 }, cursor: { blink: false } }
  if (mode === 'main') {
    const face = await new FontFace(family, `url(${JSON.stringify(fontUrl)})`).load()
    document.fonts.add(face)
    const terminal = await MainTerminal.create({
      appearance,
      runtime: { kind: 'owned', options: assets },
      rendererFactory: (options) => WebGlTerminalRenderer.create(options),
    })
    active.push(terminal)
    return terminal
  }
  const terminal = await WorkerTerminal.create({
    appearance,
    backend: mode,
    fonts: [{ family, source: { url: fontUrl } }],
  })
  active.push(terminal)
  return terminal
}

it('waits and destroys each public Window device once', async () => {
  const devices: DeviceLifecycleCounts[] = []
  const request = GPUAdapter.prototype.requestDevice
  const acquisition = vi
    .spyOn(GPUAdapter.prototype, 'requestDevice')
    .mockImplementation(async function (this: GPUAdapter, descriptor) {
      const device = await request.call(this, descriptor)
      devices.push(observeDevice(device, devices.length))
      return device
    })
  try {
    const face = await new FontFace(family, `url(${JSON.stringify(fontUrl)})`).load()
    document.fonts.add(face)
    const terminal = await MainTerminal.create({
      appearance: { font: { family, size: 16 }, cursor: { blink: false } },
      runtime: { kind: 'owned', options: assets },
    })
    active.push(terminal)
    await terminal.open(container())
    expect(terminal.diagnostics.rendererBackend).toBe('webgpu')
    await terminal.write('known-good lifecycle')
    await eventually(() => terminal.visibleLines()[0]?.includes('known-good lifecycle') === true)
    await terminal.dispose()
    await eventually(() => devices.some((value) => value.destroys > 0))
    console.info('Packaged Window device lifecycle', JSON.stringify(devices))
    expect(devices).toEqual([{ device: 0, waits: 1, destroys: 1 }])
  } finally {
    acquisition.mockRestore()
  }
})

it.each([
  'normal',
  'recovered',
  'held',
  'rejected-held',
  'retired-held',
  'replacement-held',
  'rejected',
  'setup-failed',
] as const)(
  'waits and destroys each public worker device once before closing (%s)',
  async (mode) => {
    const channel = new BroadcastChannel('packaged-worker-device-lifecycle')
    const observations: DeviceLifecycleObservation[] = []
    channel.onmessage = ({ data }: MessageEvent<DeviceLifecycleObservation>) =>
      observations.push(data)
    try {
      const url = new URL('./tests/device-lifecycle.worker.ts', import.meta.url)
      url.searchParams.set('lifecycle', mode)
      const terminal = await WorkerTerminal.create({
        assets,
        appearance: { font: { family, size: 16 }, cursor: { blink: false } },
        backend: 'webgpu',
        workerUrl: url,
        fonts: [{ family, source: { url: fontUrl } }],
      })
      active.push(terminal)
      if (mode === 'setup-failed') {
        await expect(terminal.open(container())).rejects.toBeInstanceOf(TerminalWorkerError)
      } else {
        await terminal.open(container())
        await terminal.write('known-good lifecycle')
        await eventually(
          () => terminal.visibleLines()[0]?.includes('known-good lifecycle') === true,
        )
      }
      const recovering =
        mode === 'recovered' || mode === 'retired-held' || mode === 'replacement-held'
      if (recovering) {
        const frame = terminal.submittedFrame!.frame
        channel.postMessage('lose')
        await eventually(() =>
          observations.some((value) => value.type === 'acquired' && value.device === 1),
        )
        if (mode !== 'replacement-held') {
          await eventually(() => terminal.submittedFrame!.frame > frame)
          await terminal.write('\r recovered lifecycle')
          await eventually(
            () => terminal.visibleLines()[0]?.includes('recovered lifecycle') === true,
          )
        }
      }
      const disposal = terminal.dispose()
      if (mode === 'replacement-held') {
        await eventually(() =>
          observations.some((value) => value.type === 'destroyed' && value.device === 0),
        )
        channel.postMessage('inspect')
        await eventually(() =>
          observations.some((value) => value.type === 'inspected' || value.type === 'completed'),
        )
        expect(observations.some((value) => value.type === 'completed')).toBe(false)
        expect(observations.find((value) => value.type === 'inspected')).toEqual({
          type: 'inspected',
          devices: [
            { device: 0, waits: 1, destroys: 1 },
            { device: 1, waits: 0, destroys: 0 },
          ],
        })
        channel.postMessage('acquire')
      }
      if (mode === 'retired-held') {
        await eventually(() =>
          observations.some((value) => value.type === 'destroyed' && value.device === 1),
        )
        channel.postMessage('inspect')
        await eventually(() =>
          observations.some((value) => value.type === 'inspected' || value.type === 'completed'),
        )
        console.info('Packaged worker pending retired device', JSON.stringify(observations))
        expect(observations.some((value) => value.type === 'completed')).toBe(false)
        expect(observations.find((value) => value.type === 'inspected')).toEqual({
          type: 'inspected',
          devices: [
            { device: 0, waits: 1, destroys: 0 },
            { device: 1, waits: 1, destroys: 1 },
          ],
        })
      }
      if (mode === 'held' || mode === 'rejected-held') {
        await eventually(() => observations.some((value) => value.type === 'waiting'))
        channel.postMessage('inspect')
        await eventually(() =>
          observations.some((value) => value.type === 'inspected' || value.type === 'completed'),
        )
        console.info('Packaged worker pending queue fence', JSON.stringify(observations))
        expect(observations.some((value) => value.type === 'completed')).toBe(false)
        expect(observations.find((value) => value.type === 'inspected')).toEqual({
          type: 'inspected',
          devices: [{ device: 0, waits: 1, destroys: 0 }],
        })
      }
      if (mode === 'held' || mode === 'rejected-held' || mode === 'retired-held')
        channel.postMessage('release')
      await disposal
      await terminal.dispose()
      await eventually(() => observations.some((value) => value.type === 'completed'))
      const completed = observations.find((value) => value.type === 'completed')!
      console.info('Packaged worker device lifecycle', mode, JSON.stringify(observations))
      const count = recovering ? 2 : 1
      expect(observations.filter((value) => value.type === 'acquired')).toHaveLength(count)
      expect(completed).toEqual({
        type: 'completed',
        devices: Array.from({ length: count }, (_, device) => ({ device, waits: 1, destroys: 1 })),
      })
    } finally {
      channel.postMessage('acquire')
      channel.postMessage('release')
      channel.close()
    }
  },
)

it.each(['normal', 'held', 'retired-held', 'replacement-held'] as const)(
  'bounds idle fatal worker shutdown (%s)',
  async (mode) => {
    const channel = new BroadcastChannel('packaged-worker-device-lifecycle')
    const observations: DeviceLifecycleObservation[] = []
    channel.onmessage = ({ data }: MessageEvent<DeviceLifecycleObservation>) =>
      observations.push(data)
    const url = new URL('./tests/device-lifecycle.worker.ts', import.meta.url)
    url.searchParams.set('lifecycle', mode)
    url.searchParams.set('clock', 'manual')
    const terminal = await WorkerTerminal.create({
      assets,
      appearance: { font: { family, size: 16 }, cursor: { blink: false } },
      backend: 'webgpu',
      workerUrl: url,
      fonts: [{ family, source: { url: fontUrl } }],
    })
    const errors: unknown[] = []
    terminal.on('error', ({ cause }) => errors.push(cause))
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const producer = new MessageChannel()
    const ready = new Promise<TerminalOutputReady>((resolve) => {
      producer.port1.onmessage = ({ data }: MessageEvent<TerminalOutputReady>) => {
        if (data.type === 'ready') resolve(data)
      }
      producer.port1.start()
    })
    try {
      await terminal.open(container())
      await terminal.attachOutputPort(producer.port2)
      const identity = await ready
      await terminal.write('known-good idle lifecycle')
      await eventually(() => terminal.visibleLines()[0]?.includes('known-good idle') === true)
      const recovering = mode === 'retired-held' || mode === 'replacement-held'
      if (recovering) {
        const frame = terminal.submittedFrame!.frame
        channel.postMessage('lose')
        await eventually(() =>
          observations.some((value) => value.type === 'acquired' && value.device === 1),
        )
        if (mode === 'retired-held') {
          await eventually(() => terminal.submittedFrame!.frame > frame)
          await terminal.write('\r recovered idle lifecycle')
        }
      }
      channel.postMessage('hold-layout')
      await eventually(() => observations.some((value) => value.type === 'layout-armed'))
      window.dispatchEvent(new Event('resize'))
      await eventually(() => observations.some((value) => value.type === 'layout-held'))
      expect(terminal.hasPendingFrame).toBe(true)
      channel.postMessage('release-layout')
      await eventually(() => !terminal.hasPendingFrame)
      expect(terminal.hasPendingFrame).toBe(false)
      expect(errors).toEqual([])
      terminate.mockClear()
      const bytes = new TextEncoder().encode('invalid producer sequence')
      producer.port1.postMessage({ ...identity, type: 'output', sequence: 2, data: bytes }, [
        bytes.buffer,
      ])
      if (mode === 'normal') {
        await eventually(() => errors.length > 0)
        await eventually(() => observations.some((value) => value.type === 'completed'))
        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatchObject({ code: 'protocol', operation: 'output' })
        expect(observations.find((value) => value.type === 'completed')).toEqual({
          type: 'completed',
          devices: [{ device: 0, waits: 1, destroys: 1 }],
        })
        expect(observations.filter((value) => value.type === 'warning')).toEqual([])
        expect(observations.filter((value) => value.type === 'deadline-armed')).toEqual([
          { type: 'deadline-armed', delay: 15_000 },
        ])
        expect(observations.filter((value) => value.type === 'deadline-cleared')).toEqual([
          { type: 'deadline-cleared', delay: 15_000 },
        ])
        expect(terminate).toHaveBeenCalled()
        return
      }
      const destroyedDevice = mode === 'retired-held' ? 1 : 0
      await eventually(() =>
        observations.some((value) =>
          mode === 'held'
            ? value.type === 'waiting'
            : value.type === 'destroyed' && value.device === destroyedDevice,
        ),
      )
      channel.postMessage('inspect')
      await eventually(() => observations.some((value) => value.type === 'inspected'))
      const devices = [{ device: 0, waits: 1, destroys: mode === 'replacement-held' ? 1 : 0 }]
      if (recovering)
        devices.push({
          device: 1,
          waits: mode === 'retired-held' ? 1 : 0,
          destroys: mode === 'retired-held' ? 1 : 0,
        })
      console.info('Packaged worker idle shutdown pending', mode, JSON.stringify(observations))
      expect(observations.find((value) => value.type === 'inspected')).toEqual({
        type: 'inspected',
        devices,
      })
      expect(terminal.hasPendingFrame).toBe(false)
      expect(errors).toEqual([])
      expect(terminate).not.toHaveBeenCalled()
      await eventually(() => observations.some((value) => value.type === 'deadline-armed'))
      expect(observations.filter((value) => value.type === 'deadline-armed')).toEqual([
        { type: 'deadline-armed', delay: 15_000 },
      ])
      channel.postMessage('deadline')
      await eventually(() => errors.length > 0)
      await eventually(() => observations.some((value) => value.type === 'abandoned'))
      console.info('Packaged worker idle shutdown expired', mode, JSON.stringify(observations))
      const internal = {
        deviceCount: recovering ? 2 : 1,
        reason: 'shutdown-deadline',
        timeoutMs: 15_000,
      }
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: 'timeout', operation: 'cleanup', internal })
      expect(observations.filter((value) => value.type === 'warning')).toEqual([
        {
          type: 'warning',
          value: expect.objectContaining({ level: 'warn', area: 'worker.shutdown', ...internal }),
        },
      ])
      expect(observations.find((value) => value.type === 'abandoned')).toEqual({
        type: 'abandoned',
        devices,
      })
      expect(observations.some((value) => value.type === 'completed')).toBe(false)
      expect(terminate).toHaveBeenCalled()
    } finally {
      channel.postMessage('acquire')
      channel.postMessage('release')
      channel.postMessage('release-layout')
      await terminal.dispose().catch(() => {})
      producer.port1.close()
      producer.port2.close()
      channel.close()
      terminate.mockRestore()
    }
  },
  10_000,
)

it.each(['release', 'deadline'] as const)(
  'joins initial device acquisition during fatal public worker shutdown (%s)',
  async (outcome) => {
    const channel = new BroadcastChannel('packaged-worker-device-lifecycle')
    const observations: DeviceLifecycleObservation[] = []
    channel.onmessage = ({ data }: MessageEvent<DeviceLifecycleObservation>) =>
      observations.push(data)
    const url = new URL('./tests/device-lifecycle.worker.ts', import.meta.url)
    url.searchParams.set('lifecycle', 'initial-held')
    if (outcome === 'deadline') url.searchParams.set('clock', 'manual')
    const worker = new Worker(url, { type: 'module' })
    const control = new MessageChannel()
    const messages: WorkerMessage[] = []
    control.port1.onmessage = ({ data }: MessageEvent<WorkerMessage>) => messages.push(data)
    control.port1.start()
    try {
      worker.postMessage(
        {
          type: 'initialize',
          terminal: 'acquisition-test',
          generation: 1,
          port: control.port2,
          assets,
          backend: 'webgpu',
          faces: [{ family, source: { url: fontUrl } }],
          appearance: { font: { family, size: 16 }, cursor: { blink: false } },
        },
        [control.port2],
      )
      await eventually(() => messages.some((value) => value.type === 'reply' && value.id === 0))
      const canvas = new OffscreenCanvas(480, 160)
      control.port1.postMessage(
        {
          type: 'request',
          terminal: 'acquisition-test',
          generation: 1,
          id: 1,
          control: 1,
          output: 0,
          command: 'open',
          args: [
            canvas,
            {
              identity: 1,
              width: 480,
              height: 160,
              pixelRatio: 1,
              padding: { left: 0, right: 0, top: 0, bottom: 0 },
              scrollbarWidth: 0,
              autoFit: true,
            },
          ],
        },
        [canvas],
      )
      await eventually(() => observations.some((value) => value.type === 'acquired'))
      control.port1.postMessage({
        type: 'request',
        terminal: 'acquisition-test',
        generation: 2,
        id: 2,
        control: 2,
        output: 0,
        command: 'geometry',
        args: [],
      })
      await eventually(() => observations.some((value) => value.type === 'interrupted'))
      channel.postMessage('inspect')
      await eventually(() =>
        observations.some((value) => value.type === 'inspected' || value.type === 'completed'),
      )
      console.info('Packaged worker pending initial acquisition', JSON.stringify(observations))
      expect(observations.some((value) => value.type === 'completed')).toBe(false)
      expect(observations.find((value) => value.type === 'inspected')).toEqual({
        type: 'inspected',
        devices: [{ device: 0, waits: 0, destroys: 0 }],
      })
      if (outcome === 'deadline') {
        await eventually(() => observations.some((value) => value.type === 'deadline-armed'))
        channel.postMessage('deadline')
        await eventually(() => messages.some((value) => value.type === 'fatal'))
        await eventually(() => observations.some((value) => value.type === 'closed'))
        const internal = { deviceCount: 1, reason: 'shutdown-deadline', timeoutMs: 15_000 }
        expect(messages.filter((value) => value.type === 'fatal')).toHaveLength(1)
        expect(messages.find((value) => value.type === 'fatal')).toMatchObject({
          failure: { code: 'timeout', operation: 'cleanup', internal },
        })
        expect(observations.filter((value) => value.type === 'warning')).toEqual([
          {
            type: 'warning',
            value: expect.objectContaining({ level: 'warn', area: 'worker.shutdown', ...internal }),
          },
        ])
        expect(observations.find((value) => value.type === 'abandoned')).toEqual({
          type: 'abandoned',
          devices: [{ device: 0, waits: 0, destroys: 0 }],
        })
        expect(observations.some((value) => value.type === 'completed')).toBe(false)
        return
      }
      channel.postMessage('acquire')
      await eventually(() => messages.some((value) => value.type === 'fatal'))
      await eventually(() => observations.some((value) => value.type === 'completed'))
      console.info('Packaged worker fatal acquisition lifecycle', JSON.stringify(observations))
      expect(messages.find((value) => value.type === 'fatal')).toMatchObject({
        failure: { code: 'protocol', operation: 'request' },
      })
      expect(observations.find((value) => value.type === 'completed')).toEqual({
        type: 'completed',
        devices: [{ device: 0, waits: 1, destroys: 1 }],
      })
    } finally {
      channel.postMessage('acquire')
      channel.postMessage('release')
      worker.terminate()
      control.port1.close()
      control.port2.close()
      channel.close()
    }
  },
  10_000,
)

it('rejects unfinished worker cleanup at the shared shutdown deadline', async () => {
  const channel = new BroadcastChannel('packaged-worker-device-lifecycle')
  const observations: DeviceLifecycleObservation[] = []
  channel.onmessage = ({ data }: MessageEvent<DeviceLifecycleObservation>) =>
    observations.push(data)
  const url = new URL('./tests/device-lifecycle.worker.ts', import.meta.url)
  url.searchParams.set('lifecycle', 'held')
  const terminal = await WorkerTerminal.create({
    assets,
    appearance: { font: { family, size: 16 }, cursor: { blink: false } },
    backend: 'webgpu',
    workerUrl: url,
    fonts: [{ family, source: { url: fontUrl } }],
  })
  const terminate = vi.spyOn(Worker.prototype, 'terminate')
  try {
    await terminal.open(container())
    await terminal.write('known-good lifecycle')
    await eventually(() => terminal.visibleLines()[0]?.includes('known-good lifecycle') === true)
    const disposal = terminal.dispose().then(
      () => undefined,
      (cause: unknown) => cause,
    )
    await eventually(() => observations.some((value) => value.type === 'waiting'))
    channel.postMessage('inspect')
    await eventually(() => observations.some((value) => value.type === 'inspected'))
    expect(observations.find((value) => value.type === 'inspected')).toEqual({
      type: 'inspected',
      devices: [{ device: 0, waits: 1, destroys: 0 }],
    })
    expect(await disposal).toMatchObject({
      code: 'timeout',
      operation: expect.stringMatching(/^(dispose|cleanup)$/),
    })
    expect(terminate).toHaveBeenCalled()
    expect(observations.some((value) => value.type === 'completed')).toBe(false)
  } finally {
    channel.postMessage('release')
    await terminal.dispose().catch(() => {})
    channel.close()
    terminate.mockRestore()
  }
}, 20_000)

it('reacquires a live device and repaints after public worker device loss', async () => {
  const channel = new BroadcastChannel('packaged-worker-device-loss')
  const observations: DeviceObservation[] = []
  channel.onmessage = ({ data }: MessageEvent<DeviceObservation>) => observations.push(data)
  try {
    const terminal = await WorkerTerminal.create({
      assets,
      appearance: { font: { family, size: 16 }, cursor: { blink: false } },
      backend: 'webgpu',
      workerUrl: new URL('./tests/device-loss.worker.ts', import.meta.url),
      fonts: [{ family, source: { url: fontUrl } }],
    })
    active.push(terminal)
    await terminal.open(container())
    await eventually(() => observations.some((value) => value.type === 'acquired'))
    await terminal.write('\x1b[?25l\x1b[41m known-good worker \x1b[0m')
    await eventually(() => terminal.visibleLines()[0]?.includes('known-good worker') === true)
    channel.postMessage('capture')
    await eventually(() => observations.some((value) => value.type === 'armed'))
    await terminal.refresh(0, terminal.submittedFrame!.grid.rows - 1)
    await eventually(() => observations.some((value) => value.type === 'pixels'))
    const before = observations.find((value) => value.type === 'pixels')!
    expect(before.type).toBe('pixels')
    if (before.type !== 'pixels') return
    expect(before.pixels.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true)
    expect(new Set(before.pixels.slice(0, 3)).size).toBeGreaterThan(1)
    const frame = terminal.submittedFrame!.frame
    channel.postMessage('destroy')
    await eventually(() => observations.some((value) => value.type === 'lost'))
    await eventually(() =>
      observations.some((value) => value.type === 'acquired' && value.device === 1),
    )
    await eventually(() =>
      observations.some((value) => value.type === 'pixels' && value.device === 1),
    )
    const after = observations.find((value) => value.type === 'pixels' && value.device === 1)!
    if (after.type !== 'pixels') return
    expect(after.pixels).toEqual(before.pixels)
    await eventually(() => terminal.submittedFrame!.frame > frame)
    await terminal.write('\r recovered worker')
    await eventually(() => terminal.visibleLines()[0]?.includes('recovered worker') === true)
    expect(observations.filter((value) => value.type === 'acquired')).toHaveLength(2)
    await page.screenshot({
      element: terminal.element!,
      path: '../../.artifacts/packaged-worker-device-recovered.png',
      scale: 'css',
    })
  } finally {
    console.info(
      'Packaged worker device recovery',
      JSON.stringify({
        browser: navigator.userAgent,
        observations: observations.map((value) =>
          value.type === 'pixels'
            ? { type: value.type, device: value.device, pixelBytes: value.pixels.length }
            : value,
        ),
      }),
    )
    channel.close()
  }
}, 15_000)

describe.each(['main', 'webgl', 'webgpu'] as const)('%s shared await-style terminal', (mode) => {
  it('runs real native output, fitted layout, input, reset and captures through the packaged entry', async () => {
    const terminal = await create(mode)
    const root = container()
    const events: string[] = []
    terminal.on('title', (title) => events.push(title))
    await terminal.open(root)
    const bytes = new TextEncoder().encode('packaged worker\r\n\x1b]2;ordered-title\x07')
    const result = terminal.write(bytes)
    expect(result instanceof Promise).toBe(mode !== 'main')
    bytes.fill(0)
    await result
    expect(bytes.buffer.byteLength).toBeGreaterThan(0)
    expect(events).toEqual(['ordered-title'])
    await eventually(() => terminal.visibleLines()[0]?.trimEnd() === 'packaged worker')
    const summary = terminal.submittedFrame!
    expect(Object.isFrozen(summary)).toBe(true)
    expect(Object.isFrozen(summary.grid)).toBe(true)
    expect(Object.isFrozen(summary.rows)).toBe(true)
    expect(summary.font.settings.family).toBe(family)
    expect(summary.grid.cellWidth).toBe(summary.font.cssCellWidth)
    expect(summary.grid.cellHeight).toBe(summary.font.cssCellHeight)
    expect(summary.grid.columns).toBeGreaterThan(1)
    await eventually(async () => (await terminal.frameSnapshot()) !== undefined)
    let capture: string | undefined
    await eventually(async () => {
      capture = await terminal.captureViewport()
      return capture !== undefined
    })
    expect(JSON.parse(capture!).version).toBe(1)
    expect((await terminal.readLines(0, 1))[0]?.text).toContain('packaged worker')
    expect(
      Array.from(
        await terminal.key({ action: 'press', code: 'KeyA', composing: false, text: 'a' }),
      ),
    ).toEqual([97])
    await terminal.write('\x1b[?2004h\x1b[?1004h')
    expect(new TextDecoder().decode(await terminal.paste('paste'))).toBe('\x1b[200~paste\x1b[201~')
    const output: string[] = []
    terminal.onData((data) => output.push(new TextDecoder().decode(data)))
    terminal.focus()
    await eventually(() => output.includes('\x1b[I'))
    terminal.blur()
    await eventually(() => output.includes('\x1b[O'))
    terminal.textarea!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true, cancelable: true }),
    )
    await eventually(() => output.includes('b'))
    terminal.textarea!.value = 'text input'
    terminal.textarea!.dispatchEvent(
      new InputEvent('input', { data: 'text input', inputType: 'insertText', bubbles: true }),
    )
    await eventually(() => output.includes('text input'))
    const oldLayout = terminal.submittedFrame!.layout
    root.style.width = '320px'
    await eventually(
      () =>
        terminal.submittedFrame!.layout > oldLayout &&
        terminal.submittedFrame!.grid.columns < summary.grid.columns,
    )
    await terminal.setFont({ size: 18 })
    await eventually(() => terminal.submittedFrame!.font.settings.size === 18)
    const fitted = terminal.submittedFrame!
    expect(fitted.grid.cellWidth).toBe(fitted.font.cssCellWidth)
    expect(fitted.grid.cellHeight).toBe(fitted.font.cssCellHeight)
    await page.screenshot({
      element: terminal.element!,
      path: `../../.artifacts/packaged-worker-${mode}.png`,
      scale: 'css',
    })
    await terminal.reset()
    await eventually(() => terminal.visibleLines().every((line) => line.trim() === ''))
  }, 25_000)
})

it.each(['webgl', 'webgpu'] as const)(
  '%s settles authority while page animation frames are suspended',
  async (backend) => {
    const terminal = await create(backend)
    await terminal.open(container())
    const request = window.requestAnimationFrame
    window.requestAnimationFrame = () => 0
    try {
      await terminal.write('message-driven')
      expect((await terminal.readLines(0, 1))[0]?.text).toContain('message-driven')
      expect(await terminal.sendInput('x')).toEqual(new Uint8Array([120]))
      await terminal.setFont({ size: 20 })
      expect(terminal.appearance.font.size).toBe(20)
      const disposal = terminal.dispose()
      expect(terminal.lifecycle).toBe('disposed')
      expect(terminal.element).toBeUndefined()
      await disposal
    } finally {
      window.requestAnimationFrame = request
    }
  },
  20_000,
)

it('processes transferred producer output before an explicit control fence and actor disposal', async () => {
  const terminal = await WorkerTerminal.create({
    assets,
    backend: 'webgl',
    workerUrl,
    fonts: [{ family, source: { url: fontUrl } }],
  })
  active.push(terminal)
  await terminal.open(container())
  const channel = new MessageChannel()
  const ready = new Promise<TerminalOutputReady>((resolve) => {
    channel.port1.onmessage = ({ data }: MessageEvent<TerminalOutputReady>) => {
      if (data.type === 'ready') resolve(data)
    }
    channel.port1.start()
  })
  await terminal.attachOutputPort(channel.port2)
  const identity = await ready
  const buffer = new TextEncoder().encode('direct producer')
  const message: TerminalOutputMessage = { ...identity, type: 'output', sequence: 1, data: buffer }
  const fence = terminal.fenceOutput(1)
  const layout = terminal.setFont({ size: 18 })
  const read = terminal.readLines(0, 1)
  channel.port1.postMessage(message, [buffer.buffer])
  expect(buffer.byteLength).toBe(0)
  await fence
  await layout
  expect((await read)[0]?.text).toContain('direct producer')
  expect(terminal.appearance.font.size).toBe(18)
  const secondFence = terminal.fenceOutput(2)
  const rejection = expect(secondFence).rejects.toMatchObject({ code: 'disposed' })
  const disposal = terminal.dispose()
  await rejection
  const tail = new TextEncoder().encode(' disposal fence')
  channel.port1.postMessage({ ...identity, type: 'output', sequence: 2, data: tail }, [tail.buffer])
  await disposal
  channel.port1.close()
}, 20_000)

it('rejects pending authority at host disposal and awaits worker cleanup', async () => {
  const terminal = await WorkerTerminal.create({
    assets,
    backend: 'webgl',
    workerUrl,
    fonts: [{ family, source: { url: fontUrl } }],
  })
  active.push(terminal)
  await terminal.open(container())
  const pending = terminal.write('pending')
  const rejection = expect(pending).rejects.toMatchObject({ code: 'disposed' })
  const disposal = terminal.dispose()
  expect(terminal.lifecycle).toBe('disposed')
  await rejection
  await disposal
})

it('fails missing explicit fonts with a structured startup error', async () => {
  await expect(
    WorkerTerminal.create({ assets, backend: 'webgl', workerUrl, fonts: [] }),
  ).rejects.toBeInstanceOf(TerminalWorkerError)
})

it('fails an explicit unavailable worker backend without falling back to the page', async () => {
  const terminal = await WorkerTerminal.create({
    assets,
    backend: 'webgpu',
    fonts: [{ family, source: { url: fontUrl } }],
    workerUrl: new URL('./tests/capability.worker.ts', import.meta.url),
  })
  active.push(terminal)
  await expect(terminal.open(container())).rejects.toMatchObject({
    code: 'capability',
    operation: 'renderer.webgpu',
  })
  expect(terminal.lifecycle).toBe('disposed')
})

it.each(['generation', 'control'] as const)(
  'rejects a stale %s envelope in the real packaged actor',
  async (field) => {
    const worker = new Worker(workerUrl, { type: 'module' })
    const channel = new MessageChannel()
    const next = () =>
      new Promise<import('./protocol.js').WorkerMessage>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new DOMException('Actor reply timed out', 'TimeoutError')),
          5_000,
        )
        channel.port1.onmessage = ({ data }) => {
          clearTimeout(timeout)
          resolve(data)
        }
        channel.port1.onmessageerror = () => {
          clearTimeout(timeout)
          reject(new DOMException('Actor reply cannot be decoded', 'DataCloneError'))
        }
      })
    try {
      const startup = next()
      channel.port1.start()
      worker.postMessage(
        {
          type: 'initialize',
          terminal: 'protocol-test',
          generation: 1,
          port: channel.port2,
          assets,
          backend: 'webgl',
          faces: [{ family, source: { url: fontUrl } }],
          appearance: { font: { family } },
        },
        [channel.port2],
      )
      expect((await startup).type).toBe('reply')
      const fatal = next()
      channel.port1.postMessage({
        type: 'request',
        terminal: 'protocol-test',
        generation: field === 'generation' ? 0 : 1,
        id: 1,
        control: field === 'control' ? 2 : 1,
        output: 0,
        command: 'readLines',
        args: [0, 1],
      })
      expect(await fatal).toMatchObject({
        type: 'fatal',
        failure: { code: 'protocol', operation: 'request' },
      })
    } finally {
      worker.terminate()
      channel.port1.close()
      channel.port2.close()
    }
  },
)

it.each(['webgl', 'webgpu'] as const)(
  '%s cancels opening authority explicitly',
  async (backend) => {
    const terminal = await create(backend)
    const root = container()
    const opening = terminal.open(root)
    expect(terminal.lifecycle).toBe('opening')
    const cancelled = expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    const disposal = terminal.dispose()
    await cancelled
    await disposal
    expect(terminal.lifecycle).toBe('disposed')
    expect(terminal.element).toBeUndefined()
    expect(root.children).toHaveLength(0)
    expect(() => terminal.geometry()).toThrow('disposed')
  },
)

it('invalidates the host after a producer sequence error', async () => {
  const terminal = await create('webgl')
  await terminal.open(container())
  const errors: unknown[] = []
  terminal.on('error', (error) => errors.push(error.cause))
  const channel = new MessageChannel()
  try {
    const ready = new Promise<TerminalOutputReady>((resolve) => {
      channel.port1.onmessage = ({ data }: MessageEvent<TerminalOutputReady>) => {
        if (data.type === 'ready') resolve(data)
      }
      channel.port1.start()
    })
    await terminal.attachOutputPort(channel.port2)
    const identity = await ready
    channel.port1.postMessage({
      ...identity,
      type: 'output',
      sequence: 2,
      data: new Uint8Array([120]),
    })
    await eventually(() => terminal.lifecycle === 'disposed')
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'protocol', operation: 'output' }),
    )
    await terminal.dispose()
  } finally {
    channel.port1.close()
  }
})

it('owns explicit font bytes and selects supported WebGL when auto has no WebGPU', async () => {
  const bytes = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer())
  const byteFamily = 'WorkerByteFont'
  const terminal = await WorkerTerminal.create({
    assets,
    fonts: [{ family: byteFamily, source: { bytes }, descriptors: { weight: '400' } }],
    workerUrl: new URL('./tests/capability.worker.ts', import.meta.url),
  })
  active.push(terminal)
  expect(bytes.byteLength).toBeGreaterThan(0)
  bytes.fill(0)
  await terminal.open(container())
  await terminal.write('owned font bytes')
  await eventually(() => terminal.visibleLines()[0]?.trimEnd() === 'owned font bytes')
  expect(terminal.diagnostics.rendererBackend).toBe('webgl2')
  expect(terminal.submittedFrame?.font.settings.family).toBe(byteFamily)
  expect(Array.from(document.fonts).some((face) => face.family === byteFamily)).toBe(false)
})

it('forwards release after a pending press when host input becomes disabled', async () => {
  let disabled = false
  const terminal = await WorkerTerminal.create({
    backend: 'webgl',
    fonts: [{ family, source: { url: fontUrl } }],
    inputHooks: { inputDisabled: () => disabled },
  })
  active.push(terminal)
  await terminal.open(container())
  await terminal.write('\x1b[>11u')
  const output: string[] = []
  terminal.onData((data) => output.push(new TextDecoder().decode(data)))
  terminal.textarea!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }),
  )
  disabled = true
  terminal.textarea!.dispatchEvent(
    new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }),
  )
  await terminal.readLines(0, 1)
  expect(output).toEqual(['\x1b[97u', '\x1b[97;1:3u'])
})

describe.each(['main', 'webgl', 'webgpu'] as const)('%s review correction parity', (mode) => {
  it('delivers the initial fitted resize to pre-open subscribers after opening', async () => {
    const terminal = await create(mode)
    const initial = terminal.appearance.grid
    const events: { cols: number; rows: number; lifecycle: string }[] = []
    terminal.onResize((grid) => events.push({ ...grid, lifecycle: terminal.lifecycle }))
    await terminal.open(container())
    await eventually(
      () => !!terminal.submittedFrame && terminal.appearance.grid.columns !== initial.columns,
    )
    const grid = terminal.appearance.grid
    expect(events[0]).toEqual({ cols: grid.columns, rows: grid.rows, lifecycle: 'open' })
    expect(events).toHaveLength(1)
  })

  it('retains the pre-open inactive cursor choice in the real submitted renderer', async () => {
    const terminal = await create(mode)
    await terminal.setCursorInactiveStyle('none')
    await terminal.open(container())
    await terminal.setTheme({
      ...terminal.appearance.theme,
      background: { r: 0, g: 0, b: 0 },
      foreground: { r: 255, g: 255, b: 255 },
      cursor: { r: 255, g: 0, b: 0 },
    })
    await eventually(() => terminal.submittedFrame?.theme.cursor.r === 255)
    expect(terminal.submittedFrame?.cursor.visible).toBe(true)
    expect(terminal.submittedFrame?.paintedCursor?.visible).toBe(false)
    expect(await terminal.setCursorInactiveStyle('block')).toBe(true)
    await eventually(() => terminal.submittedFrame?.paintedCursor?.visible === true)
    await page.screenshot({
      element: terminal.element!,
      path: `../../.artifacts/review-cursor-${mode}.png`,
      scale: 'css',
    })
  })

  it('reports only changes to retained inactive cursor settings before and after open', async () => {
    const terminal = await create(mode)
    expect(await terminal.setCursorInactiveStyle(undefined)).toBe(false)
    expect(await terminal.setCursorInactiveStyle('none')).toBe(true)
    expect(await terminal.setCursorInactiveStyle('none')).toBe(false)
    await terminal.open(container())
    expect(await terminal.setCursorInactiveStyle('none')).toBe(false)
    expect(await terminal.setCursorInactiveStyle('block')).toBe(true)
    expect(await terminal.setCursorInactiveStyle('block')).toBe(false)
    expect(await terminal.setCursorInactiveStyle(undefined)).toBe(true)
  })

  it.each(['display', 'width', 'height'] as const)(
    'retains native grid and content while %s is unmeasurable',
    async (dimension) => {
      const terminal = await create(mode)
      const root = container()
      await terminal.open(root)
      await terminal.write('preserved native content')
      await eventually(() => terminal.visibleLines()[0]?.trimEnd() === 'preserved native content')
      const grid = terminal.appearance.grid
      const resized: { cols: number; rows: number }[] = []
      terminal.onResize((value) => resized.push(value))
      const hidden = new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => {
          if (terminal.element!.clientWidth > 0 && terminal.element!.clientHeight > 0) return
          observer.disconnect()
          resolve()
        })
        observer.observe(terminal.element!)
      })
      if (dimension === 'display') root.style.display = 'none'
      if (dimension === 'width') root.style.width = '0px'
      if (dimension === 'height') root.style.height = '0px'
      await hidden
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      await terminal.readLines(0, 1)
      expect(terminal.appearance.grid).toEqual(grid)
      expect(resized).toEqual([])
      await terminal.setFont({ size: 20 })
      expect(terminal.appearance.grid).toEqual(grid)
      expect(resized).toEqual([])
      expect((await terminal.readLines(0, 1))[0]?.text).toContain('preserved native content')
      root.style.display = ''
      root.style.width = '320px'
      root.style.height = '120px'
      await eventually(
        () =>
          terminal.appearance.grid.columns < grid.columns &&
          terminal.appearance.grid.rows < grid.rows,
      )
      await eventually(() => terminal.visibleLines()[0]?.trimEnd() === 'preserved native content')
      expect(resized).toEqual([
        { cols: terminal.appearance.grid.columns, rows: terminal.appearance.grid.rows },
      ])
    },
  )

  it('opens an initially hidden host without resizing native state and fits on reveal', async () => {
    const terminal = await create(mode)
    const root = container()
    root.style.display = 'none'
    const grid = terminal.appearance.grid
    const resized: { cols: number; rows: number }[] = []
    terminal.onResize((value) => resized.push(value))
    await terminal.open(root)
    await terminal.readLines(0, 1)
    expect(terminal.appearance.grid.columns).toBe(grid.columns)
    expect(terminal.appearance.grid.rows).toBe(grid.rows)
    expect(resized).toEqual([])
    root.style.display = ''
    await eventually(() => terminal.appearance.grid.columns < grid.columns)
    await eventually(() => !!terminal.submittedFrame)
    expect(resized).toEqual([
      { cols: terminal.appearance.grid.columns, rows: terminal.appearance.grid.rows },
    ])
  })
})

it.each(['pending', 'current', 'older'] as const)(
  'review correction preserves release ownership with %s key ACKs',
  async (ack) => {
    let disabled = false
    const terminal = await WorkerTerminal.create({
      backend: 'webgl',
      fonts: [{ family, source: { url: fontUrl } }],
      inputHooks: { inputDisabled: () => disabled },
    })
    active.push(terminal)
    await terminal.open(container())
    await terminal.write('\x1b[>11u')
    const output: string[] = []
    terminal.onData((data) => output.push(new TextDecoder().decode(data)))
    const send = (type: 'keydown' | 'keyup') =>
      terminal.textarea!.dispatchEvent(
        new KeyboardEvent(type, { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }),
      )
    if (ack !== 'older') {
      send('keydown')
      if (ack === 'current') await terminal.readLines(0, 1)
      disabled = true
      send('keyup')
      await terminal.readLines(0, 1)
      expect(output).toEqual(['\x1b[97u', '\x1b[97;1:3u'])
      return
    }
    const channel = new MessageChannel()
    try {
      const ready = new Promise<TerminalOutputReady>((resolve) => {
        channel.port1.onmessage = ({ data }) => {
          if (data.type === 'ready') resolve(data)
        }
        channel.port1.start()
      })
      await terminal.attachOutputPort(channel.port2)
      const identity = await ready
      const firstFence = terminal.fenceOutput(1)
      send('keydown')
      send('keyup')
      const olderAck = terminal.readLines(0, 1)
      const secondFence = terminal.fenceOutput(2)
      send('keydown')
      channel.port1.postMessage({
        ...identity,
        type: 'output',
        sequence: 1,
        data: new Uint8Array(),
      })
      await firstFence
      await olderAck
      disabled = true
      send('keyup')
      channel.port1.postMessage({
        ...identity,
        type: 'output',
        sequence: 2,
        data: new Uint8Array(),
      })
      await secondFence
      await terminal.readLines(0, 1)
      expect(output).toEqual(['\x1b[97u', '\x1b[97;1:3u', '\x1b[97u', '\x1b[97;1:3u'])
    } finally {
      channel.port1.close()
    }
  },
)

it.each(['older-empty', 'current-empty', 'released', 'reset', 'dispose'] as const)(
  'review correction ignores obsolete asynchronous press ACK ownership: %s',
  async (lifecycle) => {
    let disabled = false
    const actions: string[] = []
    const errors: unknown[] = []
    const pending: ((bytes: Uint8Array) => void)[] = []
    const textarea = document.createElement('textarea')
    container().append(textarea)
    const controller = createDomInputController({
      textarea,
      platform: 'linux',
      signal: new AbortController().signal,
      hooks: { inputDisabled: () => disabled },
      onError: (cause) => errors.push(cause),
      encoding: {
        key: (input) => {
          actions.push(input.action)
          return new Promise((resolve) => pending.push(resolve))
        },
        paste: async () => new Uint8Array(),
        sendInput: async () => new Uint8Array(),
      },
    })
    const send = (type: 'keydown' | 'keyup') =>
      textarea.dispatchEvent(
        new KeyboardEvent(type, { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }),
      )
    try {
      send('keydown')
      if (lifecycle === 'older-empty') {
        send('keyup')
        send('keydown')
      }
      if (lifecycle === 'released') send('keyup')
      if (lifecycle === 'reset') controller.resetTransientState()
      if (lifecycle === 'dispose') controller.dispose()
      const empty = lifecycle === 'older-empty' || lifecycle === 'current-empty'
      pending[0]!(empty ? new Uint8Array() : new Uint8Array([97]))
      await Promise.resolve()
      disabled = true
      send('keyup')
      let expected = ['press']
      if (lifecycle === 'older-empty') expected = ['press', 'release', 'press', 'release']
      if (lifecycle === 'released') expected = ['press', 'release']
      expect(actions).toEqual(expected)
      expect(errors).toEqual([])
    } finally {
      controller.dispose()
    }
  },
)

describe.each(['main', 'webgl', 'webgpu'] as const)('%s actual-owner integration', (mode) => {
  it('measures readonly text with atomic live geometry through the packaged entry', async () => {
    const terminal = await create(mode)
    await terminal.open(container())
    await terminal.write('\x1b[?2027h')
    const initial = terminal.geometry()
    expect(initial instanceof Promise).toBe(mode !== 'main')
    expect((await initial).cursor).toMatchObject({ x: 0, y: 0 })
    const texts = Object.freeze(['abc', '中', '\u2764\ufe0f', 'e\u0301'])
    const measured = terminal.measureTexts(texts)
    expect(measured instanceof Promise).toBe(mode !== 'main')
    const batch = await measured
    expect(batch.texts.map((text) => text.cells)).toEqual([3, 2, 2, 1])
    expect(batch.geometry).toEqual(await terminal.geometry())
    expect(Object.isFrozen(batch)).toBe(true)
    expect(Object.isFrozen(batch.texts)).toBe(true)
    expect(Object.isFrozen(batch.geometry.cursor)).toBe(true)
    expect(await terminal.measure('中')).toBe(2)
    await terminal.write('\x1b[?2027l')
    const legacy = await terminal.measureTexts(texts)
    expect(legacy.geometry.graphemeClustering).toBe(false)
    expect(legacy.texts[2]?.cells).toBe(1)
    await terminal.write('\x1b[?2027h')
    expect(await terminal.measure('\u2764\ufe0f')).toBe(2)
    expect(Array.isArray(terminal.visibleLines())).toBe(true)
  })

  it('captures atomic prompt geometry before public observer reentry', async () => {
    const terminal = await create(mode)
    await terminal.open(container())
    const order: string[] = []
    let reentry: ReturnType<TerminalApi['write']> | undefined
    let observed: ReturnType<TerminalApi['geometry']> | undefined
    terminal.on('title', () => {
      order.push('observer')
      observed = terminal.geometry()
      reentry = terminal.write('later')
    })
    const bytes = new TextEncoder().encode('\x1b[32m中> \x1b[0m\x1b]0;prompt\x07')
    const operation = terminal.writeAndReadGeometry(bytes)
    expect(operation instanceof Promise).toBe(mode !== 'main')
    bytes.fill(0)
    const origin = await operation
    order.push('return')
    expect(order).toEqual(['observer', 'return'])
    expect(bytes.buffer.byteLength).toBeGreaterThan(0)
    expect(origin.cursor).toMatchObject({ x: 4, y: 0, pendingWrap: false })
    expect((await observed)?.cursor.x).toBe(4)
    await reentry
    const later = await terminal.geometry()
    expect(later.cursor.x).toBe(9)
    expect(origin.revision).toBeLessThan(later.revision)
    expect(Object.isFrozen(origin)).toBe(true)
    expect(Object.isFrozen(origin.cursor)).toBe(true)
  })
})

describe.each(['main', 'webgl', 'webgpu'] as const)('%s review atomic host', (mode) => {
  it.each(['created', 'opening'] as const)('rejects atomic output while %s', async (lifecycle) => {
    const terminal = await create(mode)
    const initial = await terminal.geometry()
    const opening = lifecycle === 'opening' ? terminal.open(container()) : undefined
    expect(terminal.lifecycle).toBe(lifecycle)
    expect(() => terminal.write('ordinary')).toThrow(`lifecycle is ${lifecycle}`)
    let failure: unknown
    try {
      await terminal.writeAndReadGeometry('x')
    } catch (cause) {
      failure = cause
    }
    await opening
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(`lifecycle is ${lifecycle}`)
    const after = await terminal.geometry()
    expect(after.cursor).toMatchObject({ x: 0, y: 0 })
    if (lifecycle === 'created') expect(after).toEqual(initial)
  })

  it('announces atomic output through the enabled accessibility live region', async () => {
    const terminal = await create(mode)
    const root = container()
    await terminal.open(root)
    const mirror = root.querySelector('[role="list"][aria-label="Terminal screen"]')!
    const live = root.querySelector('[aria-live="polite"]')!
    expect(mirror).toBeInstanceOf(HTMLElement)
    expect(live).toBeInstanceOf(HTMLElement)
    await eventually(() => mirror.children.length > 0)
    await terminal.write('ordinary ')
    await eventually(() => live.textContent === 'ordinary')
    expect(live.children).toHaveLength(1)
    const operation = terminal.writeAndReadGeometry('atomic prompt')
    expect(operation instanceof Promise).toBe(mode !== 'main')
    expect((await operation).cursor).toMatchObject({ x: 22, y: 0 })
    await eventually(() => mirror.textContent?.includes('ordinary atomic prompt') === true)
    expect(live.children).toHaveLength(2)
    expect(live.children[1]?.textContent).toBe(' atomic prompt')
    await page.screenshot({
      element: terminal.element!,
      path: `../../.artifacts/review-atomic-host-${mode}.png`,
      scale: 'css',
    })
  })

  it('honors disposal reentry before atomic completion and tears down host output', async () => {
    const terminal = await create(mode)
    const root = container()
    await terminal.open(root)
    const errors: unknown[] = []
    const events: string[] = []
    let disposal: ReturnType<TerminalApi['dispose']> | undefined
    terminal.on('error', (error) => errors.push(error))
    terminal.on('title', (title) => {
      events.push(title)
      disposal = terminal.dispose()
    })
    const operation = terminal.writeAndReadGeometry('中> \x1b]0;disposed-prompt\x07')
    expect(operation instanceof Promise).toBe(mode !== 'main')
    if (mode === 'main') {
      expect((await operation).cursor).toMatchObject({ x: 4, y: 0 })
    } else {
      await expect(operation).rejects.toMatchObject({ code: 'disposed' })
    }
    await disposal
    expect(events).toEqual(['disposed-prompt'])
    expect(errors).toEqual([])
    expect(terminal.lifecycle).toBe('disposed')
    expect(terminal.element).toBeUndefined()
    expect(root.children).toHaveLength(0)
    expect(() => terminal.geometry()).toThrow('disposed')
    expect(() => terminal.writeAndReadGeometry('late')).toThrow('disposed')
  })
})

it('preserves default worker browser paste keys and native clipboard encoding', async () => {
  const terminal = await create('webgl')
  await terminal.open(container())
  await terminal.write('\x1b[?2004h')
  const output: string[] = []
  terminal.onData((bytes) => output.push(new TextDecoder().decode(bytes)))
  const textarea = terminal.textarea!
  const modifier = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
  const send = (type: 'keydown' | 'keyup', repeat = false) => {
    const event = new KeyboardEvent(type, {
      code: 'KeyV',
      key: 'v',
      repeat,
      ...modifier,
      bubbles: true,
      cancelable: true,
    })
    textarea.dispatchEvent(event)
    return event
  }
  expect(send('keydown').defaultPrevented).toBe(false)
  expect(send('keydown', true).defaultPrevented).toBe(true)
  expect(send('keyup').defaultPrevented).toBe(false)
  await terminal.readLines(0, 1)
  expect(output).toEqual([])
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', 'worker clip')
  const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
  textarea.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  await eventually(() => output.length === 1)
  expect(output).toEqual(['\x1b[200~worker clip\x1b[201~'])
})

it('rejects JavaScript worker hotkeys attachment before starting an asynchronous lease', async () => {
  const terminal = await create('webgl')
  let failure: unknown
  try {
    Reflect.apply(attachTerminalHotkeys, undefined, [terminal])
  } catch (cause) {
    failure = cause
  }
  expect(failure).toMatchObject({ code: 'capability', operation: 'inputModes' })
  let callbacks = 0
  const connection = terminal.connectInput(() => {
    callbacks++
    return 'pass'
  })
  expect(connection instanceof Promise).toBe(true)
  await expect(connection).rejects.toMatchObject({ code: 'capability', operation: 'connectInput' })
  expect(callbacks).toBe(0)
  let setup = 0
  const general = terminal.use({
    name: 'worker general API observation control',
    setup: () => {
      setup++
      return {}
    },
  })
  expect(general instanceof Promise).toBe(true)
  const handle = await general
  expect(setup).toBe(1)
  handle.dispose()
})

it('keeps finite input ownership and immediate native mode access on the synchronous host', async () => {
  const terminal = await create('webgl')
  let setup = 0
  const registration = terminal.connectInput(() => {
    setup++
    return 'pass'
  })
  expect(registration instanceof Promise).toBe(true)
  await expect(registration).rejects.toMatchObject({
    code: 'capability',
    operation: 'connectInput',
  })
  expect(setup).toBe(0)
  try {
    terminal.inputModes
    expect.fail('Worker modes require native authority')
  } catch (cause) {
    expect(cause).toMatchObject({ code: 'capability', operation: 'inputModes' })
  }
  await terminal.open(container())
  await terminal.write('worker authority retained')
  expect((await terminal.readLines(0, 1))[0]?.text).toContain('worker authority retained')
  await terminal.dispose()
  const disposed = terminal.connectInput(() => {
    setup++
    return 'pass'
  })
  expect(disposed instanceof Promise).toBe(true)
  await expect(disposed).rejects.toThrow('disposed')
  expect(setup).toBe(0)
})

it('rejects an unsupported Canvas worker backend with a structured capability failure', async () => {
  // JavaScript callers can supply a backend outside the declaration union.
  await expect(
    WorkerTerminal.create({
      assets,
      backend: 'canvas' as 'webgl',
      workerUrl,
      fonts: [{ family, source: { url: fontUrl } }],
    }),
  ).rejects.toMatchObject({ code: 'capability', operation: 'backend' })
})

describe.each(['webgl', 'webgpu'] as const)('%s ordered output accessibility', (backend) => {
  it.each(
    (['write', 'writeln', 'writeAndReadGeometry'] as const).flatMap((operation) => [
      { operation, following: false, label: 'single output' },
      { operation, following: true, label: 'queued outputs' },
    ]),
  )(
    '$operation retains output intent across a pre-output refresh submission for $label',
    async ({ operation, following }) => {
      const terminal = await WorkerTerminal.create({
        appearance: { font: { family, size: 16 }, cursor: { blink: false } },
        backend,
        fonts: [{ family, source: { url: fontUrl } }],
        workerUrl: new URL('./tests/output-frame-order.worker.ts', import.meta.url),
      })
      active.push(terminal)
      const root = container()
      await terminal.open(root)
      const mirror = root.querySelector('[role="list"][aria-label="Terminal screen"]')!
      const live = root.querySelector('[aria-live="polite"]')!
      await eventually(() => mirror.children.length > 0)
      const before = terminal.submittedFrame!
      const frames: { frame: number; revision: number; text: string; live: string }[] = []
      terminal.onFrame(() => {
        const summary = terminal.submittedFrame!
        frames.push({
          frame: summary.frame,
          revision: summary.nativeRevision,
          text: mirror.textContent ?? '',
          live: live.textContent ?? '',
        })
      })
      const refresh = terminal.refresh(0, before.grid.rows - 1)
      const write = terminal[operation]('ordered output')
      const next = following ? terminal.write(' tail') : undefined
      await Promise.all([refresh, write, next])
      const native = await terminal.readLines(0, 1)
      const geometry = await terminal.geometry()
      const expected = following ? 'ordered output tail' : 'ordered output'
      await eventually(() => mirror.textContent === expected)
      expect(native[0]?.text).toContain('ordered output')
      expect(geometry.revision).toBeGreaterThan(before.nativeRevision)
      expect(frames).toContainEqual({
        frame: expect.any(Number),
        revision: before.nativeRevision,
        text: '',
        live: '',
      })
      expect(live.textContent, JSON.stringify({ native, geometry, frames })).toBe(expected)
      expect(live.children).toHaveLength(following ? 2 : 1)
      expect(live.children[0]?.textContent).toBe('ordered output')
      if (following) expect(live.children[1]?.textContent).toBe(' tail')
    },
  )
})

describe.each(['webgl', 'webgpu'] as const)('%s producer output accessibility', (backend) => {
  it.each(['mixed', 'fenced', 'unfenced'] as const)(
    'announces %s producer output once per submitted advance',
    async (ordering) => {
      const terminal = await WorkerTerminal.create({
        appearance: { font: { family, size: 16 }, cursor: { blink: false } },
        backend,
        fonts: [{ family, source: { url: fontUrl } }],
        workerUrl:
          ordering === 'unfenced'
            ? workerUrl
            : new URL('./tests/output-frame-order.worker.ts', import.meta.url),
      })
      active.push(terminal)
      const root = container()
      await terminal.open(root)
      const mirror = root.querySelector('[role="list"][aria-label="Terminal screen"]')!
      const live = root.querySelector('[aria-live="polite"]')!
      await eventually(() => mirror.children.length > 0)
      const frames: { frame: number; text: string; live: string }[] = []
      terminal.onFrame(() => {
        frames.push({
          frame: terminal.submittedFrame!.frame,
          text: mirror.textContent ?? '',
          live: live.textContent ?? '',
        })
      })
      const channel = new MessageChannel()
      let acknowledge: () => void = () => {}
      const acknowledged = new Promise<void>((resolve) => {
        acknowledge = resolve
      })
      const ready = new Promise<TerminalOutputReady>((resolve) => {
        channel.port1.onmessage = ({
          data,
        }: MessageEvent<TerminalOutputReady | TerminalOutputAck>) => {
          if (data.type === 'ready') resolve(data)
          if (data.type === 'output-ack' && data.sequence === 1) acknowledge()
        }
        channel.port1.start()
      })
      try {
        await terminal.attachOutputPort(channel.port2)
        const identity = await ready
        const bytes = new TextEncoder().encode('producer')
        const output: TerminalOutputMessage = {
          ...identity,
          type: 'output',
          sequence: 1,
          data: bytes,
        }
        channel.port1.postMessage(output, [bytes.buffer])
        await acknowledged
        if (ordering === 'mixed') await terminal.write(' tail')
        if (ordering === 'fenced') await terminal.fenceOutput(1)
        const expected = ordering === 'mixed' ? 'producer tail' : 'producer'
        await eventually(() => mirror.textContent === expected)
        const native = await terminal.readLines(0, 1)
        expect(native[0]?.text).toContain(expected)
        expect(live.textContent, JSON.stringify({ ordering, native, frames })).toBe(expected)
        expect(live.children).toHaveLength(ordering === 'mixed' ? 2 : 1)
        expect(live.children[0]?.textContent).toBe('producer')
        if (ordering === 'mixed') {
          expect(live.children[1]?.textContent).toBe(' tail')
          expect(frames).toContainEqual({
            frame: expect.any(Number),
            text: 'producer',
            live: 'producer',
          })
        }
        const before = terminal.submittedFrame!.frame
        const refresh = terminal.refresh(0, terminal.submittedFrame!.grid.rows - 1)
        await Promise.all([refresh, terminal.fenceOutput(1)])
        await eventually(() => terminal.submittedFrame!.frame > before)
        expect(live.textContent, JSON.stringify(frames)).toBe(expected)
        expect(live.children).toHaveLength(ordering === 'mixed' ? 2 : 1)
        const next = new TextEncoder().encode(' next')
        channel.port1.postMessage({ ...identity, type: 'output', sequence: 2, data: next }, [
          next.buffer,
        ])
        await eventually(() => mirror.textContent === `${expected} next`)
        expect(live.children).toHaveLength(ordering === 'mixed' ? 3 : 2)
        expect(live.lastElementChild?.textContent).toBe(' next')
        if (ordering === 'mixed')
          await page.screenshot({
            element: terminal.element!,
            path: `../../.artifacts/review-producer-output-${backend}.png`,
            scale: 'css',
          })
      } finally {
        channel.port1.close()
      }
    },
  )
})

it.each([1, 2])('commits worker canvas CSS geometry at pixel ratio %s', async (ratio) => {
  vi.stubGlobal('devicePixelRatio', ratio)
  try {
    const terminal = await create('webgl')
    await terminal.open(container())
    await terminal.write('geometry')
    await eventually(() => !!terminal.submittedFrame)
    const summary = terminal.submittedFrame!
    expect(summary.font.pixelRatio).toBe(ratio)
    const canvas = terminal.canvas!
    const rect = canvas.getBoundingClientRect()
    expect(rect.width).toBeCloseTo(
      summary.grid.columns * summary.font.cssCellWidth +
        summary.padding.left +
        summary.padding.right,
    )
    expect(rect.height).toBeCloseTo(
      summary.grid.rows * summary.font.cssCellHeight + summary.padding.top + summary.padding.bottom,
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

function spyOnStyleSetter(style: CSSStyleDeclaration, property: 'width' | 'height') {
  const setter = vi.spyOn(style, property, 'set')
  // CSS named properties need their native CSSOM reads and writes preserved by the observer.
  Object.defineProperty(style, property, {
    configurable: true,
    get: () => style.getPropertyValue(property),
    set: setter.mockImplementation((value: string) => style.setProperty(property, value)),
  })
  return setter
}

it.each([1.5, 2.25])(
  'keeps repeated fractional geometry quiet and commits real layout changes at ratio %s',
  async (ratio) => {
    vi.stubGlobal('devicePixelRatio', ratio)
    let widthSetter: ReturnType<typeof vi.spyOn> | undefined
    let heightSetter: ReturnType<typeof vi.spyOn> | undefined
    try {
      const terminal = await create('webgl')
      const host = container()
      await terminal.open(host)
      await terminal.setFont({ size: 18 })
      await terminal.write('fractional geometry')
      await eventually(() => terminal.submittedFrame?.font.settings.size === 18)
      const canvas = terminal.canvas!
      const initial = terminal.submittedFrame!
      expect(
        canvas.style.width !== `${initial.grid.columns * initial.font.cssCellWidth}px` ||
          canvas.style.height !== `${initial.grid.rows * initial.font.cssCellHeight}px`,
      ).toBe(true)
      widthSetter = spyOnStyleSetter(canvas.style, 'width')
      heightSetter = spyOnStyleSetter(canvas.style, 'height')
      const before = terminal.submittedFrame!.frame
      await terminal.refresh(0, terminal.submittedFrame!.grid.rows - 1)
      await eventually(() => terminal.submittedFrame!.frame > before)
      expect(widthSetter).not.toHaveBeenCalled()
      expect(heightSetter).not.toHaveBeenCalled()
      await terminal.setFont({ size: 20 })
      await eventually(() => terminal.submittedFrame!.font.settings.size === 20)
      expect(widthSetter.mock.calls.length + heightSetter.mock.calls.length).toBeGreaterThan(0)
      widthSetter.mockClear()
      heightSetter.mockClear()
      const columns = terminal.submittedFrame!.grid.columns
      host.style.width = '400px'
      host.style.height = '220px'
      await eventually(() => {
        const frame = terminal.submittedFrame!
        const bounds = canvas.getBoundingClientRect()
        const width =
          frame.grid.columns * frame.font.cssCellWidth + frame.padding.left + frame.padding.right
        const height =
          frame.grid.rows * frame.font.cssCellHeight + frame.padding.top + frame.padding.bottom
        return (
          frame.grid.columns !== columns &&
          Math.abs(bounds.width - width) < 0.05 &&
          Math.abs(bounds.height - height) < 0.05
        )
      })
      expect(widthSetter.mock.calls.length + heightSetter.mock.calls.length).toBeGreaterThan(0)
      const summary = terminal.submittedFrame!
      const rect = canvas.getBoundingClientRect()
      expect(rect.width).toBeCloseTo(
        summary.grid.columns * summary.font.cssCellWidth +
          summary.padding.left +
          summary.padding.right,
        1,
      )
      expect(rect.height).toBeCloseTo(
        summary.grid.rows * summary.font.cssCellHeight +
          summary.padding.top +
          summary.padding.bottom,
        1,
      )
    } finally {
      widthSetter?.mockRestore()
      heightSetter?.mockRestore()
      vi.unstubAllGlobals()
    }
  },
)
