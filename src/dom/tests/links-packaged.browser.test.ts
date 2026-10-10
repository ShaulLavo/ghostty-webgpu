import { testFontUrl } from '../../tests/fonts.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProvidedLink } from '../../term/links.js'
import type {
  WorkerInitialize,
  WorkerMessage,
  WorkerRequest,
  TerminalOutputReady,
} from '../../worker/protocol.js'
import type { NativeLinkSnapshot } from '../../term/link-snapshot.js'
import { page } from 'vitest/browser'
import { Terminal as MainTerminal } from '../../../dist/index.js'
import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'
import type { TerminalApi } from '../../../dist/dom/terminal-api.js'
import { WebGlTerminalRenderer } from '../../../dist/render/webgl/renderer.js'

const family = 'PackagedLinksTest'
const fontUrl = testFontUrl
const assets = {
  wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
  bridge: new URL('../../../bridge.wasm', import.meta.url).href,
}
const terminals: TerminalApi[] = []
const roots: HTMLElement[] = []
const faces: FontFace[] = []

afterEach(async () => {
  for (const terminal of terminals.splice(0)) await terminal.dispose()
  for (const root of roots.splice(0)) root.remove()
  for (const face of faces.splice(0)) document.fonts.delete(face)
  vi.restoreAllMocks()
})

async function create(mode: 'main' | 'worker', activateUri: (uri: string) => void) {
  const options = {
    appearance: { font: { family, size: 16 }, cursor: { blink: false } },
    links: { activateUri },
  }
  if (mode === 'worker') {
    const terminal = await WorkerTerminal.create({
      ...options,
      assets,
      backend: 'webgl',
      fonts: [{ family, source: { url: fontUrl } }],
    })
    terminals.push(terminal)
    return terminal
  }
  const face = await new FontFace(family, `url(${JSON.stringify(fontUrl)})`).load()
  document.fonts.add(face)
  faces.push(face)
  const terminal = await MainTerminal.create({
    ...options,
    runtime: { kind: 'owned', options: assets },
    rendererFactory: (input) => WebGlTerminalRenderer.create(input),
  })
  terminals.push(terminal)
  return terminal
}

async function open(mode: 'main' | 'worker', activateUri: (uri: string) => void) {
  const terminal = await create(mode, activateUri)
  const root = document.createElement('div')
  root.style.cssText = 'width:480px;height:120px;position:relative;background:#151515'
  document.body.append(root)
  roots.push(root)
  await terminal.open(root)
  return { root, terminal }
}

describe.each(['main', 'worker'] as const)('packaged links %s', (mode) => {
  it('delivers a native OSC8 URI absent from rendered text to the host', async () => {
    const activations: string[] = []
    const { root, terminal } = await open(mode, (uri) => activations.push(uri))
    await terminal.write('\x1b]8;;https://native-only.test/owned\x07Native label\x1b]8;;\x07')
    await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('Native label')
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    const overlay = root.querySelector<HTMLElement>('[role="link"]')!
    expect(overlay.getAttribute('aria-label')).toBe('Native label')
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect.poll(() => activations).toEqual(['https://native-only.test/owned'])
    await page.screenshot({ element: root, path: `.artifacts/packaged-links-${mode}.png` })
  }, 20_000)

  it('registers, discovers and activates a provider closure held on the host', async () => {
    const { root, terminal } = await open(mode, () => {})
    let activated = 0
    const registration = terminal.registerLinkProvider({
      provideLinks: (line, row) =>
        row === 0 && line.cells[0]?.text === 'H'
          ? [
              {
                range: { start: 0, end: 9 },
                activate: () => {
                  activated += 1
                },
              },
            ]
          : [],
    })
    expect(typeof registration.token).toBe('symbol')
    await terminal.write('Host label')
    await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('Host label')
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    const overlay = root.querySelector<HTMLElement>('[role="link"]')!
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect.poll(() => activated).toBe(1)
    registration.dispose()
    await expect(terminal.focusNextLink()).resolves.toBe(false)
  }, 20_000)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function move(terminal: TerminalApi, column = 0) {
  const canvas = terminal.canvas!
  const summary = terminal.submittedFrame!
  const bounds = canvas.getBoundingClientRect()
  canvas.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      clientX: bounds.left + summary.padding.left + (column + 0.5) * summary.grid.cellWidth,
      clientY: bounds.top + summary.padding.top + 0.5 * summary.grid.cellHeight,
    }),
  )
}

async function writeLabel(terminal: TerminalApi, text = 'Host label') {
  await terminal.write(`\r${text}`)
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe(text)
}

function linkRequests(calls: readonly (readonly unknown[])[]) {
  return calls
    .map(([message]) => message as WorkerRequest)
    .filter(
      (message) =>
        message.type === 'request' &&
        (message.command === 'resolveLinkDiscovery' || message.command === 'resolveLinkSnapshot'),
    )
}

describe.each(['main', 'worker'] as const)('packaged links lifecycle %s', (mode) => {
  it('hovers and activates a built-in URL through the shared DOM host', async () => {
    const uris: string[] = []
    const { root, terminal } = await open(mode, (uri) => uris.push(uri))
    await writeLabel(terminal, 'https://built-in.test/path')
    move(terminal, 2)
    await expect
      .poll(() => root.querySelector('[role="link"]')?.getAttribute('aria-label'))
      .toBe('https://built-in.test/path')
    const overlay = root.querySelector<HTMLElement>('[role="link"]')!
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect.poll(() => uris).toEqual(['https://built-in.test/path'])
  }, 20_000)

  it('keeps extension contribution callbacks on the host through disposal', async () => {
    const { root, terminal } = await open(mode, () => {})
    let activations = 0
    const extension = await terminal.use({
      name: 'packaged-host-link',
      setup: () => ({
        links: {
          provideLinks: (_line, row) =>
            row === 0
              ? [
                  {
                    range: { start: 0, end: 9 },
                    activate: () => {
                      activations += 1
                    },
                  },
                ]
              : [],
        },
      }),
    })
    await writeLabel(terminal)
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    root
      .querySelector<HTMLElement>('[role="link"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect.poll(() => activations).toBe(1)
    extension.dispose()
    await expect(terminal.focusNextLink()).resolves.toBe(false)
  }, 20_000)

  it.each(['revision', 'layout'] as const)(
    'stops before provider B after provider A awaits across a submitted %s change',
    async (field) => {
      const { root, terminal } = await open(mode, () => {})
      const pending = deferred<readonly ProvidedLink<Event>[]>()
      let callsA = 0
      let callsB = 0
      terminal.registerLinkProvider({
        provideLinks: () => {
          callsA += 1
          return pending.promise
        },
      })
      terminal.registerLinkProvider({
        provideLinks: () => {
          callsB += 1
          return []
        },
      })
      await writeLabel(terminal)
      const discovery = terminal.focusNextLink()
      await expect.poll(() => callsA).toBe(1)
      const old = terminal.submittedFrame!
      if (field === 'revision') await writeLabel(terminal, 'Next label')
      if (field === 'layout') {
        root.style.width = '560px'
        await expect.poll(() => terminal.submittedFrame?.layout).not.toBe(old.layout)
      }
      pending.resolve([])
      await expect(discovery).resolves.toBe(false)
      expect(callsB).toBe(0)
      expect(root.querySelector('[role="link"]')).toBeNull()
      expect(terminal.hasPendingLinkResolution).toBe(false)
    },
    20_000,
  )

  it('cancels pending hover before later providers or activation', async () => {
    const { root, terminal } = await open(mode, () => {})
    const pending = deferred<readonly ProvidedLink<Event>[]>()
    let callsA = 0
    let callsB = 0
    let activations = 0
    terminal.registerLinkProvider({
      provideLinks: () => {
        callsA += 1
        return pending.promise
      },
    })
    terminal.registerLinkProvider({
      provideLinks: () => {
        callsB += 1
        return []
      },
    })
    await writeLabel(terminal)
    move(terminal)
    await expect.poll(() => callsA).toBe(1)
    terminal.canvas!.dispatchEvent(new PointerEvent('pointerleave'))
    pending.resolve([
      {
        range: { start: 0, end: 9 },
        activate: () => {
          activations += 1
        },
      },
    ])
    await expect.poll(() => terminal.hasPendingLinkResolution).toBe(false)
    await Promise.resolve()
    expect(callsB).toBe(0)
    expect(activations).toBe(0)
    expect(root.querySelector('[role="link"]')).toBeNull()
  }, 20_000)

  it('drops a disposed pending discovery before later providers', async () => {
    const { root, terminal } = await open(mode, () => {})
    const pending = deferred<readonly ProvidedLink<Event>[]>()
    let callsA = 0
    let callsB = 0
    terminal.registerLinkProvider({
      provideLinks: () => {
        callsA += 1
        return pending.promise
      },
    })
    terminal.registerLinkProvider({
      provideLinks: () => {
        callsB += 1
        return []
      },
    })
    await writeLabel(terminal)
    const discovery = terminal.focusNextLink()
    await expect.poll(() => callsA).toBe(1)
    await terminal.dispose()
    pending.resolve([])
    await expect(discovery).resolves.toBe(false)
    expect(callsB).toBe(0)
    expect(root.querySelector('[role="link"]')).toBeNull()
  }, 20_000)

  it('keeps a newer discovery current when an obsolete provider finishes', async () => {
    const { root, terminal } = await open(mode, () => {})
    const pending = deferred<readonly ProvidedLink<Event>[]>()
    let callsA = 0
    let callsB = 0
    terminal.registerLinkProvider({
      provideLinks: () => {
        callsA += 1
        return callsA === 1 ? pending.promise : []
      },
    })
    terminal.registerLinkProvider({
      provideLinks: (_line, row) => {
        callsB += 1
        return row === 0 ? [{ range: { start: 0, end: 9 }, activate: () => {} }] : []
      },
    })
    await writeLabel(terminal)
    const layout = terminal.submittedFrame!.layout
    if (mode === 'worker') window.dispatchEvent(new Event('resize'))
    const obsolete = terminal.focusNextLink()
    await expect.poll(() => callsA).toBe(1)
    expect(terminal.submittedFrame!.layout).toBe(layout)
    await writeLabel(terminal, 'Next label')
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    expect(callsB).toBe(1)
    pending.resolve([])
    await expect(obsolete).resolves.toBe(false)
    expect(callsB).toBe(1)
    expect(root.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe('Next label')
  }, 20_000)
})

describe('packaged worker link authority transport', () => {
  it('rejects discovery from the old viewport when host dimensions change', async () => {
    const { root, terminal } = await open('worker', () => {})
    let calls = 0
    const errors: string[] = []
    terminal.on('error', ({ operation }) => errors.push(operation))
    terminal.registerLinkProvider({
      provideLinks: (_line, row) => {
        calls += 1
        return row === 0 ? [{ range: { start: 0, end: 9 }, activate: () => {} }] : []
      },
    })
    await writeLabel(terminal)
    const before = terminal.submittedFrame!
    root.style.width = '560px'
    const reply = deferred<Extract<WorkerMessage, { type: 'reply' }>>()
    const original = MessagePort.prototype.postMessage
    const transport = vi.spyOn(MessagePort.prototype, 'postMessage').mockImplementation(function (
      this: MessagePort,
      message: unknown,
      options?: StructuredSerializeOptions,
    ) {
      const request = message as WorkerRequest
      if (request.type === 'request' && request.command === 'resolveLinkDiscovery') {
        const observe = ({ data }: MessageEvent<WorkerMessage>) => {
          if (data.type !== 'reply' || data.id !== request.id) return
          this.removeEventListener('message', observe)
          reply.resolve(data)
        }
        this.addEventListener('message', observe)
      }
      original.call(this, message, options)
    })
    window.dispatchEvent(new Event('resize'))
    await expect(terminal.focusNextLink()).resolves.toBe(false)
    expect(calls).toBe(0)
    expect(errors).toEqual([])
    const native = await reply.promise
    expect(native.failure).toBeUndefined()
    expect(native.result).toBeUndefined()
    expect(native.state.revision).toBeGreaterThan(before.nativeRevision)
    const requests = linkRequests(transport.mock.calls)
    expect(requests).toHaveLength(1)
    const request = requests.find((request) => request.command === 'resolveLinkDiscovery')
    expect(request?.args[0].projection.layout).toBe(before.layout)
    await expect.poll(() => terminal.submittedFrame?.layout).not.toBe(before.layout)
    expect(terminal.submittedFrame!.grid.columns).toBeGreaterThan(before.grid.columns)
    expect(terminal.submittedFrame!.nativeRevision).toBeGreaterThan(before.nativeRevision)
    expect(root.querySelector('[role="link"]')).toBeNull()
    transport.mockRestore()
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    expect(calls).toBe(1)
    expect(root.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe('Host label')
  }, 20_000)

  it('sends one discovery batch and excludes host callbacks from initialization', async () => {
    const initialize = vi.spyOn(Worker.prototype, 'postMessage')
    const transport = vi.spyOn(MessagePort.prototype, 'postMessage')
    const { terminal } = await open('worker', () => {})
    terminal.registerLinkProvider({ provideLinks: () => [] })
    await writeLabel(terminal, 'No matching links in this entire visible grid')
    transport.mockClear()
    await expect(terminal.focusNextLink()).resolves.toBe(false)
    const requests = linkRequests(transport.mock.calls)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.command).toBe('resolveLinkDiscovery')
    const payload = initialize.mock.calls
      .map(([message]) => message as WorkerInitialize)
      .find((message) => message.type === 'initialize')!
    expect(Object.keys(payload).sort()).toEqual([
      'appearance',
      'assets',
      'backend',
      'faces',
      'generation',
      'port',
      'terminal',
      'type',
    ])
  }, 20_000)

  it.each(['generation', 'layout', 'revision'] as const)(
    'rejects a stale %s in the actual native actor',
    async (field) => {
      const { root, terminal } = await open('worker', () => {})
      let calls = 0
      terminal.registerLinkProvider({
        provideLinks: () => {
          calls += 1
          return []
        },
      })
      await writeLabel(terminal)
      const original = MessagePort.prototype.postMessage
      let altered = false
      const transport = vi.spyOn(MessagePort.prototype, 'postMessage').mockImplementation(function (
        this: MessagePort,
        message: unknown,
        options?: StructuredSerializeOptions,
      ) {
        const request = message as WorkerRequest
        if (request.type === 'request' && request.command === 'resolveLinkDiscovery') {
          altered = true
          const input = request.args[0]
          message = {
            ...request,
            args: [
              {
                ...input,
                projection: {
                  ...input.projection,
                  [field]: input.projection[field] + 1,
                },
              },
            ],
          }
        }
        original.call(this, message, options)
      })
      await expect(terminal.focusNextLink()).resolves.toBe(false)
      expect(altered).toBe(true)
      expect(calls).toBe(0)
      expect(root.querySelector('[role="link"]')).toBeNull()
      transport.mockRestore()
      await expect(terminal.focusNextLink()).resolves.toBe(false)
      expect(calls).toBeGreaterThan(0)
    },
    20_000,
  )

  it('discovers native OSC8 metadata in direct producer output', async () => {
    const uris: string[] = []
    const { root, terminal } = await open('worker', (uri) => uris.push(uri))
    const channel = new MessageChannel()
    const ready = deferred<TerminalOutputReady>()
    channel.port1.onmessage = ({ data }: MessageEvent<TerminalOutputReady>) => {
      if (data.type === 'ready') ready.resolve(data)
    }
    try {
      await terminal.attachOutputPort(channel.port2)
      const identity = await ready.promise
      const data = new TextEncoder().encode(
        '\x1b]8;;https://producer-native.test/owned\x07Producer label\x1b]8;;\x07',
      )
      channel.port1.postMessage({ ...identity, type: 'output', sequence: 1, data }, [data.buffer])
      await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('Producer label')
      await expect(terminal.focusNextLink()).resolves.toBe(true)
      root
        .querySelector<HTMLElement>('[role="link"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await expect.poll(() => uris).toEqual(['https://producer-native.test/owned'])
    } finally {
      channel.port1.close()
    }
  }, 20_000)
})

describe.each(['main', 'worker'] as const)('packaged provider failures %s', (mode) => {
  it('delivers current provider errors through terminal diagnostics while continuing discovery', async () => {
    const { terminal } = await open(mode, () => {})
    const operations: string[] = []
    terminal.on('error', ({ operation }) => operations.push(operation))
    terminal.registerLinkProvider({
      provideLinks: () => Promise.reject(new DOMException('Fixture rejection', 'AbortError')),
    })
    terminal.registerLinkProvider({
      provideLinks: () => [{ range: { start: 0, end: 9 }, activate: () => {} }],
    })
    await writeLabel(terminal)
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    expect(operations).toEqual(['link.provide'])
  }, 20_000)
})

it('captures owned native OSC8 cell metadata for one packaged worker hover', async () => {
  const { root, terminal } = await open('worker', () => {})
  await terminal.write('\x1b]8;;https://snapshot-native.test/owned\x07Host label\x1b]8;;\x07')
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('Host label')
  const original = MessagePort.prototype.postMessage
  const captured = deferred<NativeLinkSnapshot>()
  const transport = vi.spyOn(MessagePort.prototype, 'postMessage').mockImplementation(function (
    this: MessagePort,
    message: unknown,
    options?: StructuredSerializeOptions,
  ) {
    const request = message as WorkerRequest
    if (request.type === 'request' && request.command === 'resolveLinkSnapshot') {
      const observe = ({ data }: MessageEvent<WorkerMessage>) => {
        if (data.type !== 'reply' || data.id !== request.id) return
        this.removeEventListener('message', observe)
        captured.resolve(data.result as NativeLinkSnapshot)
      }
      this.addEventListener('message', observe)
    }
    original.call(this, message, options)
  })
  move(terminal, 3)
  await expect
    .poll(() => root.querySelector('[role="link"]')?.getAttribute('aria-label'))
    .toBe('Host label')
  const snapshot = await captured.promise
  expect(snapshot.osc8Uri).toBe('https://snapshot-native.test/owned')
  expect(snapshot.osc8Range).toEqual({ start: 0, end: 9 })
  expect(
    snapshot.line
      .slice(0, 10)
      .map((cell) => cell.text)
      .join(''),
  ).toBe('Host label')
  const requests = linkRequests(transport.mock.calls)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.command).toBe('resolveLinkSnapshot')
  expect(snapshot.projection.revision).toBe(terminal.submittedFrame!.nativeRevision)
  transport.mockRestore()
  terminal.canvas!.dispatchEvent(new PointerEvent('pointerleave'))
  await writeLabel(terminal, 'Next label')
  expect(
    snapshot.line
      .slice(0, 10)
      .map((cell) => cell.text)
      .join(''),
  ).toBe('Host label')
  expect(snapshot.osc8Uri).toBe('https://snapshot-native.test/owned')
}, 20_000)

it('disposes while native keyboard authority is pending without running providers', async () => {
  const { root, terminal } = await open('worker', () => {})
  let providers = 0
  terminal.registerLinkProvider({
    provideLinks: () => {
      providers += 1
      return []
    },
  })
  await writeLabel(terminal)
  const transport = vi.spyOn(MessagePort.prototype, 'postMessage')
  const discovery = terminal.focusNextLink()
  expect(linkRequests(transport.mock.calls).map((request) => request.command)).toEqual([
    'resolveLinkDiscovery',
  ])
  await terminal.dispose()
  await expect(discovery).resolves.toBe(false)
  expect(providers).toBe(0)
  expect(root.querySelector('[role="link"]')).toBeNull()
}, 20_000)

describe.each(['main', 'worker'] as const)('packaged old activation %s', (mode) => {
  it('rejects activation of a saved overlay after native revision changes', async () => {
    const { root, terminal } = await open(mode, () => {})
    let activations = 0
    terminal.registerLinkProvider({
      provideLinks: () => [
        {
          range: { start: 0, end: 9 },
          activate: () => {
            activations += 1
          },
        },
      ],
    })
    await writeLabel(terminal)
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    const old = root.querySelector<HTMLElement>('[role="link"]')!
    await writeLabel(terminal, 'Next label')
    old.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
    expect(activations).toBe(0)
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    root
      .querySelector<HTMLElement>('[role="link"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect.poll(() => activations).toBe(1)
  }, 20_000)
})
