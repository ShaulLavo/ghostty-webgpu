import { afterEach, describe, expect, it } from 'vitest'
import { KeyAction, KeyModifier, MouseAction, MouseButton, PhysicalKey } from '../../core/abi.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { SelectionDragEvent, SelectionPressEvent } from '../../core/selection.js'
import { defaultRendererTheme } from '../../render/instances/types.js'
import { EventEmitter } from '../events.js'
import { createLinkLineSnapshot, LinkResolver } from '../links.js'
import type { LinkCell, LinkResolverError, ProvidedLink } from '../links.js'
import {
  isSupportedTerminalKeyCode,
  normalizeTerminalKeyInput,
  normalizeTerminalMouseInput,
  TerminalSession,
} from '../session.js'
import type {
  TerminalClipboardWrite,
  TerminalGrid,
  TerminalMouseEvent,
  TerminalMouseState,
  TerminalScrollEvent,
  TerminalSessionOptions,
  TerminalTheme,
} from '../types.js'

const decoder = new TextDecoder()
const cellHeight = 20
const cellWidth = 10

const sessions: TerminalSession<unknown>[] = []
const runtimes: GhosttyRuntime[] = []

afterEach(() => {
  for (const session of sessions.splice(0).reverse()) session.dispose()
  for (const runtime of runtimes.splice(0).reverse()) runtime.dispose()
})

async function createSession<TEvent = unknown>(
  options: TerminalSessionOptions<TEvent> = {},
): Promise<TerminalSession<TEvent>> {
  const session = await TerminalSession.create(options)
  sessions.push(session as TerminalSession<unknown>)
  return session
}

function grid(overrides: Partial<TerminalGrid> = {}): TerminalGrid {
  return {
    cellHeight,
    cellWidth,
    columns: 8,
    pixelRatio: 1,
    rows: 3,
    ...overrides,
  }
}

function keyA() {
  return {
    action: 'press' as const,
    code: 'KeyA',
    composing: false,
    text: 'a',
  }
}

function mouseState(overrides: Partial<TerminalMouseState> = {}): TerminalMouseState {
  return {
    anyButtonPressed: false,
    geometry: {
      cellHeight: 16,
      cellWidth: 8,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      screenHeight: 384,
      screenWidth: 640,
    },
    ...overrides,
  }
}

function mouseEvent(overrides: Partial<TerminalMouseEvent> = {}): TerminalMouseEvent {
  return {
    action: 'press',
    button: 'left',
    x: 0,
    y: 0,
    ...overrides,
  }
}

function pressEvent(x: number, y: number): SelectionPressEvent {
  return {
    position: { x: x * cellWidth + 1, y: y * cellHeight + cellHeight / 2 },
    repeatDistance: 12,
    repeatIntervalNanoseconds: 500_000_000n,
    timeNanoseconds: 1_000_000_000n,
    viewport: { x, y },
  }
}

function dragEvent(columns: number, x: number, y: number): SelectionDragEvent {
  return {
    geometry: {
      cellWidth,
      columns,
      paddingLeft: 0,
      screenHeight: 3 * cellHeight,
    },
    position: { x: x * cellWidth + 9, y: y * cellHeight + cellHeight / 2 },
    viewport: { x, y },
  }
}

function textCells(value: string) {
  return Array.from(value, (text) => ({ text }))
}

function cells(value: string): LinkCell[] {
  return Array.from(value, (text) => ({ text }))
}

function deferred<T>() {
  let resolveValue: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve
  })
  return { promise, resolve: resolveValue }
}

async function flushPromiseRejections(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function expectScroll(event: TerminalScrollEvent, expected: TerminalScrollEvent): void {
  expect(event).toEqual(expected)
}

describe('terminal input normalization', () => {
  it('maps W3C codes, semantic actions, modifier sides, locks, and buttons', () => {
    const key = normalizeTerminalKeyInput({
      action: 'release',
      code: 'ControlRight',
      composing: false,
      consumedModifiers: { alt: 'left', super: 'right' },
      modifiers: { capsLock: true, control: 'right', shift: 'unknown' },
      text: '',
    })
    expect(key).toEqual({
      action: KeyAction.Release,
      composing: false,
      consumedModifiers: KeyModifier.Alt | KeyModifier.Super | KeyModifier.SuperSide,
      key: PhysicalKey.ControlRight,
      modifiers:
        KeyModifier.CapsLock | KeyModifier.Control | KeyModifier.ControlSide | KeyModifier.Shift,
      text: '',
      unshiftedCodepoint: 0,
    })

    expect(normalizeTerminalKeyInput(keyA()).unshiftedCodepoint).toBe(0x61)
    expect(normalizeTerminalKeyInput({ ...keyA(), code: 'FutureVendorKey' }).key).toBe(
      PhysicalKey.Unidentified,
    )
    expect(normalizeTerminalKeyInput({ ...keyA(), code: 'F24' }).key).toBe(PhysicalKey.F24)
    expect(normalizeTerminalKeyInput({ ...keyA(), code: 'NumpadMemorySubtract' }).key).toBe(
      PhysicalKey.NumpadMemorySubtract,
    )
    expect(normalizeTerminalKeyInput({ ...keyA(), code: 'AudioVolumeUp' }).key).toBe(
      PhysicalKey.AudioVolumeUp,
    )
    expect(normalizeTerminalKeyInput({ ...keyA(), code: 'Paste' }).key).toBe(PhysicalKey.Paste)
    expect(isSupportedTerminalKeyCode('KeyA')).toBe(true)
    expect(isSupportedTerminalKeyCode('NumpadMemorySubtract')).toBe(true)
    expect(isSupportedTerminalKeyCode('')).toBe(false)
    expect(isSupportedTerminalKeyCode('Unidentified')).toBe(false)
    expect(isSupportedTerminalKeyCode('FutureVendorKey')).toBe(false)

    expect(
      normalizeTerminalMouseInput({
        event: {
          action: 'motion',
          button: 'eleven',
          modifiers: { numLock: true, super: 'right' },
          x: 4,
          y: 5,
        },
        state: mouseState(),
      }).event,
    ).toEqual({
      action: MouseAction.Motion,
      button: MouseButton.Eleven,
      modifiers: KeyModifier.NumLock | KeyModifier.Super | KeyModifier.SuperSide,
      x: 4,
      y: 5,
    })
  })
})

describe('link line snapshots', () => {
  it('maps combining, wide, continuation, surrogate, and blank cells exactly', () => {
    const first = { text: 'e\u0301' }
    const snapshot = createLinkLineSnapshot([
      first,
      { text: '界' },
      { continuation: true, text: '' },
      { text: '🙂' },
      { text: '' },
      { text: 'x' },
    ])
    first.text = 'changed'

    expect(snapshot.cells).toHaveLength(6)
    expect(snapshot.cells[0]?.text).toBe('e\u0301')
    expect(snapshot.text).toBe('e\u0301界🙂 x')
    expect(snapshot.textStartByCell).toEqual([0, 2, 3, 3, 5, 6])
    expect(snapshot.textEndByCell).toEqual([2, 3, 3, 5, 6, 7])
    expect(snapshot.startCellByTextBoundary).toEqual([0, 0, 1, 3, 3, 4, 5, undefined])
    expect(snapshot.endCellByTextBoundary).toEqual([undefined, 0, 0, 2, 3, 3, 4, 5])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.cells)).toBe(true)
    expect(Object.isFrozen(snapshot.cells[0])).toBe(true)
  })
})

describe('LinkResolver precedence and ranges', () => {
  it('passes providers a frozen copy instead of caller-owned cells', async () => {
    const resolver = new LinkResolver()
    const first = { text: 'a' }
    const input = [first, { text: 'b' }, { text: 'c' }]
    let receivedText = ''
    resolver.registerProvider({
      provideLinks: (line, row) => {
        receivedText = line.text
        expect(row).toBe(0)
        expect(Object.isFrozen(line)).toBe(true)
        expect(Object.isFrozen(line.cells)).toBe(true)
        expect(() => (line.cells as LinkCell[]).push({ text: 'x' })).toThrow()
        return undefined
      },
    })

    const pending = resolver.resolve({ column: 1, line: input, row: 0 })
    first.text = 'changed'
    input.push({ text: 'd' })
    await pending

    expect(receivedText).toBe('abc')
  })

  it('resolves a native OSC 8 URI before providers using only the clicked cell', async () => {
    const activatedUris: string[] = []
    const resolver = new LinkResolver<{ ctrlKey: boolean }>({
      activateUri: (uri, event) => {
        if (event.ctrlKey) activatedUris.push(uri)
      },
    })
    let providerCalls = 0
    resolver.registerProvider({
      provideLinks: () => {
        providerCalls += 1
        return [{ activate: () => {}, range: { end: 25, start: 6 } }]
      },
    })

    const resolution = await resolver.resolve({
      column: 10,
      line: cells('visit https://example.test now'),
      osc8Uri: 'https://osc8.test',
      row: 0,
    })

    expect(resolution.hit).toEqual({
      range: { end: 10, start: 10 },
      row: 0,
      source: 'osc8',
      text: 's',
      uri: 'https://osc8.test',
    })
    expect(providerCalls).toBe(0)
    await expect(resolver.activate(resolution, { ctrlKey: true })).resolves.toBe(true)
    expect(activatedUris).toEqual(['https://osc8.test'])
  })

  it('maps built-in URL spans back to cells after complex Unicode and blank slots', async () => {
    const url = 'https://example.test/path'
    const prefix: LinkCell[] = [
      { text: 'e\u0301' },
      { text: '界' },
      { continuation: true, text: '' },
      { text: '🙂' },
      { text: '' },
    ]
    const line = [...prefix, ...cells(url), { text: '' }]
    const resolver = new LinkResolver()

    const resolution = await resolver.resolve({ column: 12, line, row: 4 })

    expect(resolution.hit).toEqual({
      range: { end: prefix.length + url.length - 1, start: prefix.length },
      row: 4,
      source: 'url',
      text: url,
      uri: url,
    })
  })

  it('includes a wide continuation tail in a built-in URL range', async () => {
    const line: LinkCell[] = [
      ...cells('https://example.test/'),
      { text: '界' },
      { continuation: true, text: '' },
    ]
    const resolver = new LinkResolver()

    const resolution = await resolver.resolve({ column: line.length - 1, line, row: 0 })

    expect(resolution.hit).toMatchObject({
      range: { end: line.length - 1, start: 0 },
      source: 'url',
      uri: 'https://example.test/界',
    })
  })

  it('preserves balanced closing delimiters and trims sentence punctuation or unmatched closers', async () => {
    const resolver = new LinkResolver()
    const balancedUri = 'https://example.test/a(b)'
    const balanced = await resolver.resolve({
      column: 10,
      line: cells(`${balancedUri}.`),
      row: 0,
    })
    const unmatchedUri = 'https://example.test/path'
    const unmatched = await resolver.resolve({
      column: 10,
      line: cells(`(${unmatchedUri}).`),
      row: 0,
    })

    expect(balanced.hit).toMatchObject({
      range: { end: balancedUri.length - 1, start: 0 },
      uri: balancedUri,
    })
    expect(unmatched.hit).toMatchObject({
      range: { end: unmatchedUri.length, start: 1 },
      uri: unmatchedUri,
    })
  })

  it('uses unique tokens so out-of-order disposal removes the exact registration', async () => {
    const resolver = new LinkResolver()
    const sharedProvider = {
      provideLinks: () => [{ activate: () => {}, range: { end: 25, start: 6 } }],
    }
    const first = resolver.registerProvider(sharedProvider)
    const second = resolver.registerProvider(sharedProvider)
    expect(first.token).not.toBe(second.token)

    second.dispose()
    second.dispose()
    const provided = await resolver.resolve({
      column: 10,
      line: cells('visit https://example.test now'),
      row: 0,
    })

    expect(provided.hit).toMatchObject({ providerToken: first.token, source: 'provider' })

    first.dispose()
    const builtIn = await resolver.resolve({
      column: 10,
      line: cells('visit https://example.test now'),
      row: 0,
    })
    expect(builtIn.hit).toMatchObject({ source: 'url', uri: 'https://example.test' })
  })
})

describe('LinkResolver errors and generations', () => {
  it('reports each provider failure and continues to later providers or the built-in URL', async () => {
    const errors: LinkResolverError[] = []
    const resolver = new LinkResolver({
      onError: (error) => {
        errors.push(error)
      },
    })
    const rejected = resolver.registerProvider({
      provideLinks: async () => {
        throw new Error('provider rejected')
      },
    })
    const invalid = resolver.registerProvider({
      provideLinks: () => [{ activate: () => {}, range: { end: 100, start: 6 } }],
    })
    const good = resolver.registerProvider({
      provideLinks: () => [{ activate: () => {}, range: { end: 25, start: 6 }, text: 'custom' }],
    })
    const request = { column: 10, line: cells('visit https://example.test now'), row: 0 }

    const provided = await resolver.resolve(request)

    expect(provided.hit).toMatchObject({ providerToken: good.token, text: 'custom' })
    expect(errors.map((error) => error.providerToken)).toEqual([rejected.token, invalid.token])

    good.dispose()
    const builtIn = await resolver.resolve(request)

    expect(builtIn.hit).toMatchObject({ source: 'url', uri: 'https://example.test' })
    expect(errors).toHaveLength(4)
  })

  it('tags late async results as stale and prevents them from carrying a hit', async () => {
    const resolver = new LinkResolver()
    const first = deferred<readonly ProvidedLink[] | undefined>()
    resolver.registerProvider({
      provideLinks: (_line, row) => {
        if (row === 0) return first.promise
        return [{ activate: () => {}, range: { end: 2, start: 0 }, text: 'new' }]
      },
    })

    const pending = resolver.resolve({ column: 1, line: cells('old'), row: 0 })
    const current = await resolver.resolve({ column: 1, line: cells('new'), row: 1 })
    first.resolve([{ activate: () => {}, range: { end: 2, start: 0 }, text: 'old' }])
    const stale = await pending

    expect(resolver.isCurrent(current)).toBe(true)
    expect(current.hit).toMatchObject({ row: 1, text: 'new' })
    expect(resolver.isCurrent(stale)).toBe(false)
    expect(stale.hit).toBeUndefined()
  })

  it('guards activation by generation and reports sync or async activation errors', async () => {
    const errors: LinkResolverError[] = []
    let providerActivations = 0
    const resolver = new LinkResolver<{ kind: string }>({
      activateUri: async () => {
        throw new Error('URI activation failed')
      },
      onError: (error) => {
        errors.push(error)
      },
    })
    resolver.registerProvider({
      provideLinks: (_line, row) => {
        if (row !== 0) return undefined
        return [
          {
            activate: () => {
              providerActivations += 1
              throw new Error('provider activation failed')
            },
            range: { end: 2, start: 0 },
          },
        ]
      },
    })

    const provider = await resolver.resolve({ column: 1, line: cells('hit'), row: 0 })
    await expect(resolver.activate(provider, { kind: 'provider' })).resolves.toBe(false)
    expect(providerActivations).toBe(1)

    const uri = await resolver.resolve({
      column: 10,
      line: cells('go https://example.test'),
      row: 1,
    })
    await expect(resolver.activate(uri, { kind: 'uri' })).resolves.toBe(false)

    resolver.invalidate()
    await expect(resolver.activate(provider, { kind: 'stale' })).resolves.toBe(false)
    expect(providerActivations).toBe(1)
    expect(errors.map((error) => error.source)).toEqual(['provider', 'url'])
  })

  it('disposes idempotently and makes registrations, resolutions, and activations inert', async () => {
    const resolver = new LinkResolver()
    let activations = 0
    const registration = resolver.registerProvider({
      provideLinks: () => [
        {
          activate: () => {
            activations += 1
          },
          range: { end: 2, start: 0 },
        },
      ],
    })
    const resolution = await resolver.resolve({ column: 1, line: cells('hit'), row: 0 })

    resolver.dispose()
    const generation = resolver.generation
    resolver.dispose()
    registration.dispose()

    expect(resolver.generation).toBe(generation)
    expect(resolver.isCurrent(resolution)).toBe(false)
    await expect(resolver.activate(resolution, undefined)).resolves.toBe(false)
    expect(activations).toBe(0)
    expect(() => resolver.registerProvider({ provideLinks: () => undefined })).toThrow(
      'called after disposal',
    )
    await expect(resolver.resolve({ column: 0, line: cells('x'), row: 0 })).rejects.toThrow(
      'called after disposal',
    )
  })
})

describe('EventEmitter', () => {
  it('owns duplicate subscriptions independently and disposes them idempotently', () => {
    const emitter = new EventEmitter<number>()
    const values: number[] = []
    const listener = (value: number) => {
      values.push(value)
    }
    const first = emitter.subscribe(listener)
    const second = emitter.subscribe(listener)

    emitter.emit(1)
    first.dispose()
    first.dispose()
    emitter.emit(2)
    second.dispose()
    emitter.emit(3)

    expect(values).toEqual([1, 1, 2])
  })

  it('iterates a listener snapshot when subscriptions change during emission', () => {
    const emitter = new EventEmitter<string>()
    const calls: string[] = []
    const added = (value: string) => calls.push(`added:${value}`)
    let second = { dispose: () => {} }
    emitter.subscribe((value) => {
      calls.push(`first:${value}`)
      if (value !== 'one') return
      second.dispose()
      emitter.subscribe(added)
    })
    second = emitter.subscribe((value) => calls.push(`second:${value}`))

    emitter.emit('one')
    emitter.emit('two')

    expect(calls).toEqual(['first:one', 'second:one', 'first:two', 'added:two'])
  })

  it('reports synchronous failures and still calls every later listener', () => {
    const failure = new Error('listener failed')
    const errors: unknown[] = []
    const calls: string[] = []
    const emitter = new EventEmitter<string>((cause) => errors.push(cause))
    emitter.subscribe(() => {
      calls.push('first')
      throw failure
    })
    emitter.subscribe(() => {
      calls.push('second')
    })

    expect(() => emitter.emit('value')).not.toThrow()
    expect(calls).toEqual(['first', 'second'])
    expect(errors).toEqual([failure])
  })

  it('observes rejected listener promises and reports them to the error sink', async () => {
    const failure = new Error('async listener failed')
    const errors: unknown[] = []
    const emitter = new EventEmitter<void>((cause) => errors.push(cause))
    emitter.subscribe(async () => {
      await Promise.resolve()
      throw failure
    })

    emitter.emit()
    await flushPromiseRejections()

    expect(errors).toEqual([failure])
  })

  it('uses a sinkless error emitter as a non-recursive terminal sink', async () => {
    const listenerFailure = new Error('data listener failed')
    const errorListenerFailure = new Error('error listener failed')
    const observed: unknown[] = []
    const errors = new EventEmitter<unknown>()
    errors.subscribe(async (cause) => {
      observed.push(cause)
      throw errorListenerFailure
    })
    errors.subscribe((cause) => {
      observed.push(cause)
    })
    const emitter = new EventEmitter<void>(errors.emit)
    emitter.subscribe(() => {
      throw listenerFailure
    })

    expect(() => emitter.emit()).not.toThrow()
    await flushPromiseRejections()

    expect(observed).toEqual([listenerFailure, listenerFailure])
  })

  it('clears listeners on disposal, rejects new subscriptions, and ignores later emits', () => {
    const values: number[] = []
    const emitter = new EventEmitter<number>()
    const subscription = emitter.subscribe((value) => values.push(value))

    emitter.dispose()
    emitter.dispose()
    subscription.dispose()
    subscription.dispose()

    expect(() => emitter.emit(1)).not.toThrow()
    expect(values).toEqual([])
    expect(() => emitter.subscribe(() => {})).toThrow('called after disposal')
  })

  it('consumes late listener and sink rejections during teardown', async () => {
    let rejectListener: (cause: unknown) => void = () => {}
    const listenerResult = new Promise<void>((_resolve, reject) => {
      rejectListener = reject
    })
    const errors = new EventEmitter<unknown>()
    const emitter = new EventEmitter<void>(errors.emit)
    emitter.subscribe(() => listenerResult)

    emitter.emit()
    emitter.dispose()
    errors.dispose()
    rejectListener(new Error('late failure'))
    await flushPromiseRejections()

    expect(() => emitter.emit()).not.toThrow()
  })
})

describe('TerminalSession', () => {
  it('normalizes complete font defaults, numeric weights, line height, and letter spacing', async () => {
    const session = await createSession()
    const appearances: unknown[] = []
    session.on('appearance', ({ appearance }) => appearances.push(appearance.font))

    expect(session.appearance.font).toEqual({
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: 1.2,
      size: 14,
      weight: 400,
    })
    session.setFont({
      boldWeight: 1000,
      letterSpacing: -0.5,
      lineHeight: 1,
      weight: 1,
    })
    expect(session.appearance.font).toMatchObject({
      boldWeight: 1000,
      letterSpacing: -0.5,
      lineHeight: 1,
      weight: 1,
    })
    expect(appearances).toHaveLength(1)

    session.setFont({ boldWeight: 1000, letterSpacing: -0.5, lineHeight: 1, weight: 1 })
    expect(appearances).toHaveLength(1)
    for (const weight of [0, 1.5, 1001, Number.NaN]) {
      expect(() => session.setFont({ weight })).toThrow(/integer from 1 to 1000/u)
    }
    expect(() => session.setFont({ boldWeight: Number.POSITIVE_INFINITY })).toThrow(
      /integer from 1 to 1000/u,
    )
    expect(() => session.setFont({ letterSpacing: Number.NEGATIVE_INFINITY })).toThrow(/finite/u)
    expect(() => session.setFont({ lineHeight: 0.99 })).toThrow(/at least 1/u)
  })

  it('queues VT effects in native order and emits one revisioned render request per write', async () => {
    const session = await createSession({ appearance: { grid: grid() } })
    const order: string[] = []
    const renderStates: unknown[] = []
    session.on('title', ({ title }) => order.push(`title:${title}`))
    session.on('bell', () => order.push('bell'))
    session.on('data', ({ bytes }) => order.push(`data:${decoder.decode(bytes)}`))
    session.on('scroll', (event) => order.push(`scroll:${JSON.stringify(event)}`))
    session.on('renderRequest', ({ revision, state }) => {
      order.push(`render:${revision}`)
      renderStates.push(state)
    })

    expect(
      session.write(
        '0\r\n1\r\n2\r\n3\u001b]0;old\u0007\u0007\u001b[?996n\u001b]0;T\u0007\u001b[18t',
      ),
    ).toEqual({ revision: 1 })

    expect(order).toEqual([
      'bell',
      'data:\u001b[?997;1n',
      'title:T',
      'data:\u001b[8;3;8t',
      'scroll:{"scrollbackLength":1,"scrollbar":{"length":3,"offset":1,"total":4},"viewportActive":true}',
      'render:1',
    ])
    expect(renderStates).toEqual([session.renderState])

    expect(session.writeln('x')).toEqual({ revision: 2 })
    expect(order.filter((entry) => entry.startsWith('render:'))).toEqual(['render:1', 'render:2'])
  })

  it('emits copied key, paste, focus, raw, and mode-synchronized mouse bytes', async () => {
    const session = await createSession()
    const data: Uint8Array[] = []
    session.on('data', ({ bytes }) => data.push(bytes))

    const raw = Uint8Array.of(0x61, 0xff)
    expect(session.sendInput(raw)).toEqual(raw)
    raw[0] = 0
    expect(data[0]).toEqual(Uint8Array.of(0x61, 0xff))
    expect(decoder.decode(session.key(keyA()))).toBe('a')

    expect(session.setFocused(true)).toEqual(new Uint8Array())
    session.write('\u001b[?1004h')
    expect(decoder.decode(session.setFocused(false))).toBe('\u001b[O')
    expect(decoder.decode(session.setFocused(true))).toBe('\u001b[I')

    expect(decoder.decode(session.paste('a\nb\0\u001b[31m\u007f'))).toBe('a\rb  [31m ')
    session.write('\u001b[?2004h')
    expect(decoder.decode(session.paste('a\nb'))).toBe('\u001b[200~a\nb\u001b[201~')
    expect(decoder.decode(session.paste('a\nb', { bracketed: false }))).toBe('a\rb')

    session.write('\u001b[?1003h\u001b[?1006h')
    const motion = mouseEvent({ action: 'motion' })
    const pressed = mouseState({ anyButtonPressed: true })
    expect(decoder.decode(session.mouse({ event: motion, state: pressed }))).toBe('\u001b[<32;1;1M')
    expect(session.mouse({ event: motion, state: pressed })).toEqual(new Uint8Array())

    session.resetMouseTracking()
    expect(decoder.decode(session.mouse({ event: motion, state: pressed }))).toBe('\u001b[<32;1;1M')
    expect(session.mouse({ event: motion, state: pressed })).toEqual(new Uint8Array())

    session.write('x')
    expect(decoder.decode(session.mouse({ event: motion, state: pressed }))).toBe('\u001b[<32;1;1M')
    expect(session.mouse({ event: motion, state: pressed })).toEqual(new Uint8Array())

    session.write('\u001b[?1004l')
    expect(decoder.decode(session.mouse({ event: motion, state: pressed }))).toBe('\u001b[<32;1;1M')
    expect(session.mouse({ event: motion, state: pressed })).toEqual(new Uint8Array())

    session.write('\u001b[?1003l')
    expect(session.mouse({ event: motion, state: pressed })).toEqual(new Uint8Array())
    expect(data).not.toContainEqual(new Uint8Array())
  })

  it('keeps logical DPR appearance while batching native resize and complete theme updates', async () => {
    const session = await createSession({ appearance: { grid: grid() } })
    const resizeEvents: TerminalGrid[] = []
    const appearances: TerminalTheme[] = []
    const output: string[] = []
    const revisions: number[] = []
    session.on('resize', ({ grid: next }) => resizeEvents.push(next))
    session.on('appearance', ({ appearance }) => appearances.push(appearance.theme))
    session.on('data', ({ bytes }) => output.push(decoder.decode(bytes)))
    session.on('renderRequest', ({ revision }) => revisions.push(revision))

    expect(
      session.resize({ cellHeight: 18, cellWidth: 9, columns: 10, pixelRatio: 2, rows: 4 }),
    ).toEqual({ revision: 1 })
    expect(session.grid).toEqual({
      cellHeight: 18,
      cellWidth: 9,
      columns: 10,
      pixelRatio: 2,
      rows: 4,
    })
    expect(resizeEvents).toEqual([session.grid])
    expect(revisions).toEqual([1])

    session.write('\u001b[14t\u001b[16t\u001b[18t')
    expect(output.splice(0)).toEqual(['\u001b[4;144;180t', '\u001b[6;36;18t', '\u001b[8;4;10t'])

    const palette = session.appearance.theme.palette.map((color) => ({ ...color }))
    palette[42] = { b: 12, g: 11, r: 10 }
    const foreground = { b: 3, g: 2, r: 1 }
    const theme: TerminalTheme = {
      ...session.appearance.theme,
      background: { b: 6, g: 5, r: 4 },
      cursor: { b: 9, g: 8, r: 7 },
      foreground,
      palette,
    }
    expect(session.setTheme(theme)).toEqual({ revision: 3 })
    palette[42]!.r = 99
    foreground.r = 99

    session.write('\u001b]10;?\u0007\u001b]11;?\u0007\u001b]12;?\u0007\u001b]4;42;?\u0007')
    expect(output.splice(0).join('')).toBe(
      '\u001b]10;rgb:0101/0202/0303\u0007' +
        '\u001b]11;rgb:0404/0505/0606\u0007' +
        '\u001b]12;rgb:0707/0808/0909\u0007' +
        '\u001b]4;42;rgb:0a0a/0b0b/0c0c\u0007',
    )
    expect(appearances.at(-1)).toEqual(session.appearance.theme)
    expect(session.appearance.rendererTheme.foreground).toEqual({ b: 3, g: 2, r: 1 })

    session.setColorScheme('light')
    session.write('\u001b[?996n')
    expect(output).toEqual(['\u001b[?997;2n'])
  })

  it('canonicalizes fractional CSS cells to their shared integer device geometry', async () => {
    const session = await createSession({
      appearance: { grid: grid({ cellWidth: 7.8, pixelRatio: 2 }) },
    })
    const output: string[] = []
    session.on('data', ({ bytes }) => output.push(decoder.decode(bytes)))

    expect(session.grid.cellWidth).toBe(8)
    expect(session.grid.pixelRatio).toBe(2)
    session.write('\u001b[16t')
    expect(output).toEqual(['\u001b[6;40;16t'])
  })

  it('diffs scroll snapshots and preserves a scrolled viewport across writes', async () => {
    const session = await createSession({ appearance: { grid: grid() } })
    const events: Array<{ revision?: number; scroll?: TerminalScrollEvent }> = []
    session.on('scroll', (scroll) => events.push({ scroll }))
    session.on('renderRequest', ({ revision }) => events.push({ revision }))

    session.write('0\r\n1\r\n2\r\n3\r\n4\r\n5')
    expectScroll(events[0]!.scroll!, {
      scrollbackLength: 3,
      scrollbar: { length: 3, offset: 3, total: 6 },
      viewportActive: true,
    })
    expect(events[1]).toEqual({ revision: 1 })

    session.scrollToTop()
    expect(session.scrollbar.offset).toBe(0)
    expect(session.viewportActive).toBe(false)
    session.scrollToRow(2)
    expect(session.scrollbar.offset).toBe(2)
    session.scrollBy(-1)
    expect(session.scrollbar.offset).toBe(1)
    session.scrollToBottom()
    expect(session.scrollbar.offset).toBe(3)

    session.scrollToTop()
    session.write('\r\n6')
    expect({
      scrollbackLength: session.scrollbackLength,
      scrollbar: session.scrollbar,
      viewportActive: session.viewportActive,
    }).toEqual({
      scrollbackLength: 4,
      scrollbar: { length: 3, offset: 0, total: 7 },
      viewportActive: false,
    })
    const revision = session.revision
    expect(session.scrollToTop()).toEqual({ revision })
  })

  it('copies clipboard writes, defaults to deny, and converts policy failures into errors', async () => {
    const session = await createSession()
    const errors: Array<{ cause: unknown; operation: string }> = []
    session.on('error', (error) => errors.push(error))

    expect(() => session.write('\u001b]52;c;ZGVuaWVk\u0007')).not.toThrow()
    const writes: TerminalClipboardWrite[] = []
    session.setClipboardWritePolicy((write) => {
      writes.push(write)
      return 'success'
    })
    session.write('\u001b]52;c;Y29waWVkIHNlc3Npb24=\u0007')

    const first = writes[0]!
    expect(first.location).toBe('standard')
    expect(first.contents[0]!.mime).toBe('text/plain')
    expect(decoder.decode(first.contents[0]!.data)).toBe('copied session')
    expect(first.contents[0]!.data.buffer).not.toBe(session.runtime.exports.memory.buffer)

    session.write('\u001b]52;c;cmVwbGFjZW1lbnQ=\u0007')
    expect(decoder.decode(first.contents[0]!.data)).toBe('copied session')
    const failure = new Error('clipboard policy failed')
    session.setClipboardWritePolicy(() => {
      throw failure
    })
    expect(() => session.write('\u001b]52;c;ZmFpbA==\u0007')).not.toThrow()
    expect(errors).toEqual([{ cause: failure, operation: 'clipboardWrite' }])
  })

  it('rejects session reentry from a synchronous clipboard policy', async () => {
    let session!: TerminalSession
    session = await createSession({
      clipboardWrite: () => {
        session.write('\u001b[18t')
        return 'success'
      },
    })
    const data: Uint8Array[] = []
    const errors: Array<{ cause: unknown; operation: string }> = []
    const revisions: number[] = []
    session.on('data', ({ bytes }) => data.push(bytes))
    session.on('error', (error) => errors.push(error))
    session.on('renderRequest', ({ revision }) => revisions.push(revision))

    expect(session.write('\u001b]52;c;eA==\u0007')).toEqual({ revision: 1 })
    expect(data).toEqual([])
    expect(revisions).toEqual([1])
    expect(errors).toHaveLength(1)
    expect(errors[0]!.operation).toBe('clipboardWrite')
    expect(errors[0]!.cause).toMatchObject({ operation: 'terminal_session.reentry' })
  })

  it('preserves a live native selection anchor across write, scroll, and resize mutations', async () => {
    const session = await createSession({ appearance: { grid: grid() } })
    const order: string[] = []
    session.on('selection', ({ hasSelection }) => order.push(`selection:${hasSelection}`))
    session.on('renderRequest', ({ revision }) => order.push(`render:${revision}`))

    session.write('abcdefgh\r\nijklmnop\r\nqrstuvwx\r\nyz')
    session.scrollToTop()
    const beforePress = session.revision
    expect(session.selectionPress(pressEvent(1, 0))).toEqual({
      autoscroll: 'none',
      selectionChanged: false,
      selectionInstalled: false,
    })
    expect(session.revision).toBe(beforePress)

    session.write('\r\nmore')
    session.scrollToRow(1)
    session.resize({ columns: 4 })
    const beforeDrag = session.revision
    expect(session.selectionDrag(dragEvent(4, 2, 2))).toEqual({
      autoscroll: 'none',
      selectionChanged: true,
      selectionInstalled: true,
    })
    expect(session.revision).toBe(beforeDrag + 1)
    expect(session.getSelection()).toBe('bcdefgh\nijklmnop\nqrs')
    expect(session.selectionCoordinates()).toEqual({
      end: { x: 2, y: 4 },
      rectangle: false,
      start: { x: 1, y: 0 },
    })
    expect(session.selectionRelease({ x: 2, y: 2 }).dragged).toBe(true)
    expect(session.getSelection()).toBe('bcdefgh\nijklmnop\nqrs')

    let selectedDuringData = true
    session.on('data', () => {
      selectedDuringData = session.getSelection() !== undefined
    })
    session.sendInput('p', { preserveSelection: true })
    expect(selectedDuringData).toBe(true)
    expect(session.getSelection()).toBe('bcdefgh\nijklmnop\nqrs')
    order.length = 0
    session.sendInput('x')
    expect(selectedDuringData).toBe(false)
    expect(order).toEqual(['selection:false', `render:${session.revision}`])

    const beforeSelectAll = session.revision
    expect(session.selectAll().selectionChanged).toBe(true)
    expect(session.revision).toBe(beforeSelectAll + 1)
    expect(session.selectAll().selectionChanged).toBe(false)
    expect(session.revision).toBe(beforeSelectAll + 1)
    const installedSelection = session.getSelection()
    session.resetSelectionGesture()
    expect(session.getSelection()).toBe(installedSelection)
    expect(session.revision).toBe(beforeSelectAll + 1)
    expect(session.clearSelection()).toBe(true)
    expect(session.clearSelection()).toBe(false)
  })

  it('publishes native screen-coordinate range and whole-line selections', async () => {
    const session = await createSession({ appearance: { grid: grid({ columns: 5 }) } })
    const selectionEvents: boolean[] = []
    session.on('selection', ({ hasSelection }) => selectionEvents.push(hasSelection))
    session.write('abcde\r\nfghij\r\nklmno')

    expect(session.selectRange({ x: 1, y: 0 }, { x: 2, y: 1 }).selectionInstalled).toBe(true)
    expect(session.getSelection()).toBe('bcde\nfgh')
    expect(session.selectionCoordinates()).toEqual({
      end: { x: 2, y: 1 },
      rectangle: false,
      start: { x: 1, y: 0 },
    })

    expect(session.selectLines(1, 2).selectionChanged).toBe(true)
    expect(session.getSelection()).toBe('fghij\nklmno')
    expect(selectionEvents).toEqual([true, true])
  })

  it('enforces OSC 8 precedence, composes link errors, and invalidates resolutions', async () => {
    const configuredErrors: LinkResolverError[] = []
    const sessionErrors: Array<{ cause: unknown; operation: string }> = []
    const session = await createSession<string>({
      appearance: { grid: grid({ columns: 40 }) },
      links: {
        onError: (error) => {
          configuredErrors.push(error)
        },
      },
    })
    session.on('error', (error) => sessionErrors.push(error))
    session.write('\u001b]8;;https://osc8.test\u0007link\u001b]8;;\u0007 https://url.test')
    const line = textCells('link https://url.test')
    let providerCalls = 0
    const activationFailure = new Error('activation failed')
    session.registerLinkProvider({
      provideLinks() {
        providerCalls += 1
        return [
          {
            activate: () => {
              throw activationFailure
            },
            range: { end: 20, start: 5 },
            text: 'provided',
          },
        ]
      },
    })

    const osc8 = await session.resolveLink({ column: 1, line, row: 0 })
    expect(osc8.hit).toMatchObject({
      range: { end: 3, start: 0 },
      source: 'osc8',
      text: 'link',
      uri: 'https://osc8.test',
    })
    expect(providerCalls).toBe(0)
    const provided = await session.resolveLink({ column: 10, line, row: 0 })
    expect(provided.hit).toMatchObject({ source: 'provider', text: 'provided' })
    expect(await session.activateLink(provided, 'event')).toBe(false)
    expect(configuredErrors.at(-1)?.cause).toBe(activationFailure)
    expect(sessionErrors.at(-1)).toEqual({
      cause: activationFailure,
      operation: 'link.activate',
    })

    const failure = new Error('provider failed')
    session.registerLinkProvider({
      provideLinks() {
        throw failure
      },
    })
    const noMatch = textCells('not a link')
    await session.resolveLink({ column: 0, line: noMatch, row: 1 })
    expect(configuredErrors.at(-1)?.cause).toBe(failure)
    expect(sessionErrors.at(-1)).toEqual({ cause: failure, operation: 'link.provide' })

    const operations = [
      () => session.write('x'),
      () => session.resize({ columns: 39 }),
      () => session.reset(),
      () => session.scrollToTop(),
    ]
    for (const mutate of operations) {
      const resolution = await session.resolveLink({ column: 8, line, row: 0 })
      mutate()
      expect(session.isLinkCurrent(resolution)).toBe(false)
      expect(await session.activateLink(resolution, 'event')).toBe(false)
    }
  })

  it('routes asynchronous link error-handler failures without an unhandled rejection', async () => {
    const providerFailure = new Error('provider failed')
    const handlerFailure = new Error('async error handler failed')
    const errors: Array<{ cause: unknown; operation: string }> = []
    const session = await createSession({
      links: {
        onError: async () => {
          throw handlerFailure
        },
      },
    })
    session.on('error', (error) => errors.push(error))
    session.registerLinkProvider({
      provideLinks() {
        throw providerFailure
      },
    })

    await session.resolveLink({ column: 0, line: [{ text: 'x' }], row: 0 })
    await Promise.resolve()

    expect(errors).toEqual([
      { cause: providerFailure, operation: 'link.provide' },
      { cause: handlerFailure, operation: 'link.onError' },
    ])
  })

  it('defers listener-requested disposal until write orchestration completes', async () => {
    const runtime = await GhosttyRuntime.create()
    runtimes.push(runtime)
    const session = await createSession({ runtime: { kind: 'borrowed', runtime } })
    const order: string[] = []
    session.on('title', () => {
      order.push('dispose')
      session.dispose()
    })
    session.on('title', () => {
      order.push('later-title')
      expect(() => session.write('nested')).toThrow('disposed')
    })
    session.on('renderRequest', () => order.push('render'))

    expect(() => session.write('\u001b]0;done\u0007')).not.toThrow()
    expect(order).toEqual(['dispose', 'later-title', 'render'])
    expect(runtime.bridge.terminalCount).toBe(0)
    expect(() => runtime.ensureActive()).not.toThrow()
    expect(() => session.write('after')).toThrow('disposed')
  })

  it('defers listener-requested disposal across resize and appearance events', async () => {
    const runtime = await GhosttyRuntime.create()
    runtimes.push(runtime)
    const session = await createSession({ runtime: { kind: 'borrowed', runtime } })
    const order: string[] = []
    session.on('resize', () => {
      order.push('resize')
      session.dispose()
    })
    session.on('appearance', () => order.push('appearance'))
    session.on('renderRequest', () => order.push('render'))

    expect(() => session.resize({ columns: 81 })).not.toThrow()
    expect(order).toEqual(['resize', 'appearance', 'render'])
    expect(runtime.bridge.terminalCount).toBe(0)
    expect(() => runtime.ensureActive()).not.toThrow()
  })

  it('isolates listener failures and preserves borrowed runtime ownership', async () => {
    const runtime = await GhosttyRuntime.create()
    runtimes.push(runtime)
    const first = await createSession({ runtime: { kind: 'borrowed', runtime } })
    const second = await createSession({ runtime: { kind: 'borrowed', runtime } })
    expect(runtime.bridge.terminalCount).toBe(2)

    const failure = new Error('title listener failed')
    const errors: Array<{ cause: unknown; operation: string }> = []
    let laterListenerCalled = false
    first.on('error', (error) => errors.push(error))
    first.on('title', () => {
      throw failure
    })
    first.on('title', () => {
      laterListenerCalled = true
    })
    expect(() => first.write('\u001b]0;title\u0007')).not.toThrow()
    expect(laterListenerCalled).toBe(true)
    expect(errors).toEqual([{ cause: failure, operation: 'event.title' }])

    first.dispose()
    first.dispose()
    expect(runtime.bridge.terminalCount).toBe(1)
    expect(() => second.write('still alive')).not.toThrow()
    second.dispose()
    expect(runtime.bridge.terminalCount).toBe(0)
    expect(() => runtime.ensureActive()).not.toThrow()
    const terminal = runtime.createTerminal()
    terminal.dispose()
  })

  it('disposes convenience runtimes, live anchors, and failed partial construction safely', async () => {
    const owned = await createSession({ appearance: { grid: grid() } })
    const ownedRuntime = owned.runtime
    owned.write('anchor')
    owned.selectionPress(pressEvent(0, 0))
    owned.dispose()
    owned.dispose()
    expect(() => ownedRuntime.ensureActive()).toThrow('disposed')
    expect(() => owned.write('x')).toThrow('session has been disposed')

    const runtime = await GhosttyRuntime.create()
    runtimes.push(runtime)
    const invalidTheme = { ...defaultRendererTheme, palette: [] } as TerminalTheme
    await expect(
      TerminalSession.create({
        appearance: { theme: invalidTheme },
        runtime: { kind: 'borrowed', runtime },
      }),
    ).rejects.toThrow('exactly 256 colors')
    expect(runtime.bridge.terminalCount).toBe(0)
    expect(() => runtime.ensureActive()).not.toThrow()
  })
})
