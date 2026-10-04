import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { Terminal as MainTerminal, attachTerminalHotkeys } from '../../dist/index.js'
import { Terminal as WorkerTerminal, TerminalWorkerError } from '../../dist/worker/index.js'
import type { TerminalApi } from '../../dist/dom/terminal-api.js'
import { WebGlTerminalRenderer } from '../../dist/render/webgl/renderer.js'
import { createDomInputController } from '../../dist/dom/input.js'
import type { TerminalOutputReady, TerminalOutputMessage, TerminalOutputAck } from './protocol.js'

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
