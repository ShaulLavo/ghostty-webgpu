import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import {
  captureNativeLinkSnapshot,
  captureNativeLinkDiscovery,
  createProjectedLinkSession,
  type LinkProjection,
  type NativeLinkRequest,
  type NativeLinkSnapshot,
  type NativeLinkSnapshotSource,
  type NativeLinkDiscoveryRequest,
  type NativeLinkDiscoverySnapshot,
} from '../link-snapshot.js'
import type { ProvidedLink } from '../links.js'

let runtime: GhosttyRuntime
const cleanups: Array<() => void> = []

beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
afterAll(() => runtime.dispose())

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function nativeHarness(output: string) {
  const terminal = runtime.createTerminal({ columns: 40, rows: 2 })
  const renderState = runtime.createRenderState(terminal)
  cleanups.push(() => {
    renderState.dispose()
    terminal.dispose()
  })
  terminal.write(output)
  renderState.update()
  let revision = 1
  let projection: LinkProjection | undefined = { generation: 1, layout: 1, revision }
  const rowReads: number[][] = []
  let onLinkRead: (() => void) | undefined
  const source: NativeLinkSnapshotSource = {
    get revision() {
      return revision
    },
    get grid() {
      return terminal.size
    },
    renderState: {
      readTextRows: (options) => {
        rowReads.push(Array.from(options?.rows ?? []))
        return renderState.readTextRows(options)
      },
    },
    linkAt: (column, row) => {
      onLinkRead?.()
      return terminal.linkAt({ x: column, y: row, tag: 'viewport' })
    },
  }
  const getProjection = () => projection
  const snapshot = (request: NativeLinkRequest) =>
    captureNativeLinkSnapshot(source, request, getProjection)
  return {
    getProjection,
    source,
    rowReads,
    snapshot,
    discovery: (request: NativeLinkDiscoveryRequest) =>
      captureNativeLinkDiscovery(source, request, getProjection),
    request: (column = 0, row = 0): NativeLinkRequest => ({
      column,
      row,
      projection: { ...projection! },
    }),
    setProjection: (value: LinkProjection | undefined) => {
      projection = value
    },
    onLinkRead: (callback: () => void) => {
      onLinkRead = callback
    },
    write: (data: string) => {
      terminal.write(data)
      revision += 1
      renderState.update()
    },
  }
}

describe('native link snapshots', () => {
  it('owns one requested native row and contiguous OSC metadata synchronously', () => {
    const native = nativeHarness('\u001b]8;;https://osc.test\u0007界A\u001b]8;;\u0007 plain')
    const snapshot = native.snapshot(native.request(1))!
    expect(snapshot).not.toBeInstanceOf(Promise)
    expect(snapshot.osc8Uri).toBe('https://osc.test')
    expect(snapshot.osc8Range).toEqual({ start: 0, end: 2 })
    expect(snapshot.line.slice(0, 3)).toEqual([
      { text: '界', continuation: false },
      { text: '', continuation: true },
      { text: 'A', continuation: false },
    ])
    expect(native.rowReads).toEqual([[0]])
    expect(structuredClone(snapshot)).toEqual(snapshot)
    native.write('\u001b[2J\u001b[Hreplacement')
    expect(snapshot.line[0]?.text).toBe('界')
    expect(snapshot.osc8Uri).toBe('https://osc.test')
    expect(Object.isFrozen(snapshot.line[0])).toBe(true)
  })

  it.each(['generation', 'layout', 'revision'] as const)(
    'rejects stale %s before reading native rows',
    (field) => {
      const native = nativeHarness('https://native.test')
      const request = native.request()
      native.setProjection({ ...request.projection, [field]: request.projection[field] + 1 })
      expect(native.snapshot(request)).toBeUndefined()
      expect(native.rowReads).toEqual([])
    },
  )

  it('rejects output awaiting a new committed submission', () => {
    const native = nativeHarness('https://old.test')
    const request = native.request()
    native.write('\u001b[2J\u001b[Hhttps://new.test')
    expect(native.snapshot(request)).toBeUndefined()
    expect(native.rowReads).toEqual([])
  })

  it('rejects native mutation reentered during a read', () => {
    const native = nativeHarness('https://old.test')
    let changed = false
    native.onLinkRead(() => {
      if (changed) return
      changed = true
      native.write('\u001b[2J\u001b[Hhttps://new.test')
    })
    expect(native.snapshot(native.request())).toBeUndefined()
  })

  it.each([
    [-1, 0],
    [40, 0],
    [0, 2],
    [0.5, 0],
  ])('rejects an out-of-grid query (%s,%s)', (column, row) => {
    const native = nativeHarness('https://native.test')
    expect(native.snapshot(native.request(column, row))).toBeUndefined()
    expect(native.rowReads).toEqual([])
  })
})

describe('host link resolution', () => {
  it.each(['sync', 'port'] as const)(
    'resolves native OSC metadata with a %s result and host-only activation',
    async (transport) => {
      const native = nativeHarness(
        '\u001b]8;;https://osc.test\u0007https://text.test\u001b]8;;\u0007',
      )
      const channel = new MessageChannel()
      cleanups.push(() => {
        channel.port1.close()
        channel.port2.close()
      })
      channel.port2.onmessage = (event: MessageEvent<NativeLinkRequest>) => {
        channel.port2.postMessage(native.snapshot(event.data))
      }
      const activations: string[] = []
      let providerCalls = 0
      const host = createProjectedLinkSession<string>({
        getProjection: native.getProjection,
        resolveLinkDiscovery: native.discovery,
        resolveLinkSnapshot: (request) => {
          if (transport === 'sync') return native.snapshot(request)
          return new Promise<NativeLinkSnapshot | undefined>((resolve) => {
            channel.port1.onmessage = (event: MessageEvent<NativeLinkSnapshot | undefined>) =>
              resolve(event.data)
            channel.port1.postMessage(request)
          })
        },
        activateUri: (uri, event) => {
          activations.push(`${uri}:${event}`)
        },
      })
      cleanups.push(() => host.dispose())
      host.registerLinkProvider({
        provideLinks: () => {
          providerCalls += 1
          return []
        },
      })
      const resolution = await host.resolveLink({ column: 1, row: 0, line: [] })
      expect(resolution.hit?.source).toBe('osc8')
      expect(providerCalls).toBe(0)
      expect(host.isLinkCurrent(resolution)).toBe(true)
      await expect(host.activateLink(resolution, 'click')).resolves.toBe(true)
      expect(activations).toEqual(['https://osc.test:click'])
      native.setProjection({ ...native.getProjection()!, layout: 2 })
      await expect(host.activateLink(resolution, 'stale')).resolves.toBe(false)
      expect(activations).toHaveLength(1)
    },
  )

  it('runs providers and built-in detection solely on the host using owned native cells', async () => {
    const native = nativeHarness('https://native.test')
    const activations: string[] = []
    const host = createProjectedLinkSession<string>({
      getProjection: native.getProjection,
      resolveLinkDiscovery: native.discovery,
      resolveLinkSnapshot: native.snapshot,
      activateUri: (uri) => {
        activations.push(uri)
      },
    })
    cleanups.push(() => host.dispose())
    const registration = host.registerLinkProvider({
      provideLinks: (line) => {
        expect(line.text.trimEnd()).toBe('https://native.test')
        return [
          {
            range: { start: 0, end: 18 },
            activate: (event) => {
              activations.push(event)
            },
          },
        ]
      },
    })
    const request = { column: 0, row: 0, line: [{ text: 'untrusted host text' }] }
    const provided = await host.resolveLink(request)
    expect(provided.hit?.source).toBe('provider')
    await expect(host.activateLink(provided, 'provider')).resolves.toBe(true)
    registration.dispose()
    expect(host.isLinkCurrent(provided)).toBe(false)
    const builtIn = await host.resolveLink(request)
    expect(builtIn.hit).toMatchObject({ source: 'url', uri: 'https://native.test' })
    await host.activateLink(builtIn, 'click')
    expect(activations).toEqual(['provider', 'https://native.test'])
  })

  it.each(['generation', 'layout', 'revision', 'cancel', 'dispose'] as const)(
    'does not start providers after a native reply invalidated by %s',
    async (change) => {
      const native = nativeHarness('https://native.test')
      const reply = deferred<NativeLinkSnapshot | undefined>()
      let providers = 0
      const host = createProjectedLinkSession({
        getProjection: native.getProjection,
        resolveLinkDiscovery: native.discovery,
        resolveLinkSnapshot: () => reply.promise,
      })
      cleanups.push(() => host.dispose())
      host.registerLinkProvider({
        provideLinks: () => {
          providers += 1
          return []
        },
      })
      const request = native.request()
      const pending = host.resolveLink({ column: 0, row: 0, line: [] })
      const snapshot = native.snapshot(request)
      if (change === 'cancel') host.cancelLinkResolution()
      else if (change === 'dispose') host.dispose()
      else native.setProjection({ ...request.projection, [change]: request.projection[change] + 1 })
      reply.resolve(snapshot)
      const resolution = await pending
      expect(providers).toBe(0)
      expect(host.isLinkCurrent(resolution)).toBe(false)
      await expect(host.activateLink(resolution, new Event('click'))).resolves.toBe(false)
    },
  )

  it('rejects a delayed host provider after the committed revision changes', async () => {
    const native = nativeHarness('https://native.test')
    const provided = deferred<readonly ProvidedLink<Event>[]>()
    let activations = 0
    let providerCalls = 0
    const host = createProjectedLinkSession({
      getProjection: native.getProjection,
      resolveLinkDiscovery: native.discovery,
      resolveLinkSnapshot: native.snapshot,
    })
    cleanups.push(() => host.dispose())
    host.registerLinkProvider({
      provideLinks: () => {
        providerCalls += 1
        return provided.promise
      },
    })
    const pending = host.resolveLink({ column: 0, row: 0, line: [] })
    await expect.poll(() => providerCalls).toBe(1)
    native.setProjection({ ...native.getProjection()!, revision: 2 })
    provided.resolve([
      {
        range: { start: 0, end: 18 },
        activate: () => {
          activations += 1
        },
      },
    ])
    const resolution = await pending
    expect(host.isLinkCurrent(resolution)).toBe(false)
    await expect(host.activateLink(resolution, new Event('click'))).resolves.toBe(false)
    expect(activations).toBe(0)
  })
})

describe.each(['hover', 'discovery'] as const)('provider-chain freshness for %s', (path) => {
  it.each(['current', 'generation', 'layout', 'revision'] as const)(
    'continues to the second provider only while %s',
    async (change) => {
      const native = nativeHarness('plain text')
      const firstResult = deferred<readonly ProvidedLink<Event>[]>()
      let firstCalls = 0
      let secondCalls = 0
      let batches = 0
      let cellRequests = 0
      const host = createProjectedLinkSession({
        getProjection: native.getProjection,
        resolveLinkSnapshot: (request) => {
          cellRequests += 1
          return native.snapshot(request)
        },
        resolveLinkDiscovery: (request) => {
          batches += 1
          return native.discovery(request)
        },
      })
      cleanups.push(() => host.dispose())
      host.registerLinkProvider({
        provideLinks: () => {
          firstCalls += 1
          return firstResult.promise
        },
      })
      host.registerLinkProvider({
        provideLinks: () => {
          secondCalls += 1
          return [{ range: { start: 0, end: 0 }, activate: () => {} }]
        },
      })
      const pending =
        path === 'hover'
          ? host.resolveLink({ column: 0, row: 0, line: [] })
          : host.findNextLink([{ column: 0, row: 0 }]).then((found) => found?.resolution)
      await expect.poll(() => firstCalls).toBe(1)
      if (change !== 'current') {
        const projection = native.getProjection()!
        native.setProjection({ ...projection, [change]: projection[change] + 1 })
      }
      firstResult.resolve([])
      const resolution = await pending
      expect(secondCalls).toBe(change === 'current' ? 1 : 0)
      expect(resolution !== undefined && host.isLinkCurrent(resolution)).toBe(change === 'current')
      if (change === 'current') expect(resolution?.hit?.source).toBe('provider')
      expect(batches).toBe(path === 'discovery' ? 1 : 0)
      expect(cellRequests).toBe(path === 'hover' ? 1 : 0)
    },
  )

  it.each(['invalid-result', 'rejection'] as const)(
    'skips stale provider %s before interpreting or reporting it',
    async (kind) => {
      const native = nativeHarness('plain text')
      const gate = deferred<void>()
      const started = deferred<void>()
      const errors: unknown[] = []
      let secondCalls = 0
      const host = createProjectedLinkSession({
        getProjection: native.getProjection,
        resolveLinkSnapshot: native.snapshot,
        resolveLinkDiscovery: native.discovery,
        onError: (error) => {
          errors.push(error)
        },
      })
      cleanups.push(() => host.dispose())
      host.registerLinkProvider({
        provideLinks: async () => {
          started.resolve()
          await gate.promise
          if (kind === 'rejection') return Promise.reject('provider failed')
          return [{ range: { start: 0, end: 100 }, activate: () => {} }]
        },
      })
      host.registerLinkProvider({
        provideLinks: () => {
          secondCalls += 1
          return []
        },
      })
      const pending =
        path === 'hover'
          ? host.resolveLink({ column: 0, row: 0, line: [] })
          : host.findNextLink([{ column: 0, row: 0 }])
      await started.promise
      native.setProjection({ ...native.getProjection()!, revision: 2 })
      gate.resolve()
      await pending
      expect(errors).toEqual([])
      expect(secondCalls).toBe(0)
    },
  )

  it('leaves a newer request current when an obsolete provider completes', async () => {
    const native = nativeHarness('plain text')
    const gate = deferred<readonly ProvidedLink<Event>[]>()
    const started = deferred<void>()
    let firstCalls = 0
    let secondCalls = 0
    const host = createProjectedLinkSession({
      getProjection: native.getProjection,
      resolveLinkSnapshot: native.snapshot,
      resolveLinkDiscovery: native.discovery,
    })
    cleanups.push(() => host.dispose())
    host.registerLinkProvider({
      provideLinks: () => {
        firstCalls += 1
        if (firstCalls > 1) return []
        started.resolve()
        return gate.promise
      },
    })
    host.registerLinkProvider({
      provideLinks: () => {
        secondCalls += 1
        return [{ range: { start: 0, end: 0 }, activate: () => {} }]
      },
    })
    const resolve = () =>
      path === 'hover'
        ? host.resolveLink({ column: 0, row: 0, line: [] })
        : host.findNextLink([{ column: 0, row: 0 }]).then((found) => found?.resolution)
    const obsolete = resolve()
    await started.promise
    native.setProjection({ ...native.getProjection()!, layout: 2 })
    const current = (await resolve())!
    expect(host.isLinkCurrent(current)).toBe(true)
    gate.resolve([])
    await obsolete
    expect(host.isLinkCurrent(current)).toBe(true)
    expect(secondCalls).toBe(1)
  })
})

describe('bounded keyboard discovery', () => {
  const cells = Array.from({ length: 80 }, (_, index) => ({
    column: index % 40,
    row: Math.floor(index / 40),
  }))

  it.each(['link-free', 'late-link'] as const)(
    'uses one native batch for a %s viewport',
    async (kind) => {
      const output =
        kind === 'link-free'
          ? 'plain text'
          : '\u001b[2;40H\u001b]8;;https://late.test\u0007X\u001b]8;;\u0007'
      const native = nativeHarness(output)
      let batches = 0
      let cellRequests = 0
      const host = createProjectedLinkSession({
        getProjection: native.getProjection,
        resolveLinkSnapshot: (request) => {
          cellRequests += 1
          return native.snapshot(request)
        },
        resolveLinkDiscovery: async (request) => {
          batches += 1
          return native.discovery(request)
        },
      })
      cleanups.push(() => host.dispose())
      const found = await host.findNextLink(cells)
      expect(batches).toBe(1)
      expect(cellRequests).toBe(0)
      expect(native.rowReads).toEqual([[0, 1]])
      if (kind === 'link-free') expect(found).toBeUndefined()
      else {
        expect(found?.cell).toEqual({ row: 1, column: 39 })
        expect(found?.resolution.hit).toMatchObject({ source: 'osc8', uri: 'https://late.test' })
        expect(host.isLinkCurrent(found!.resolution)).toBe(true)
      }
    },
  )

  it('owns only requested rows and distinct native OSC runs', () => {
    const native = nativeHarness(
      '\u001b]8;;https://same.test\u0007界A\u001b]8;;\u0007 plain \u001b]8;;https://same.test\u0007Z\u001b]8;;\u0007',
    )
    const projection = native.getProjection()!
    const snapshot = native.discovery({ projection, rows: [0, 0] })!
    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows[0]!.osc8Links).toEqual([
      { range: { start: 0, end: 2 }, uri: 'https://same.test' },
      { range: { start: 10, end: 10 }, uri: 'https://same.test' },
    ])
    expect(native.rowReads).toEqual([[0]])
    expect(structuredClone(snapshot)).toEqual(snapshot)
    native.write('\u001b[2J\u001b[Hreplacement')
    expect(snapshot.rows[0]!.line[0]!.text).toBe('界')
  })

  it.each(['generation', 'layout', 'revision', 'cancel', 'dispose'] as const)(
    'rejects the batch before host candidate work after %s',
    async (change) => {
      const native = nativeHarness('plain text')
      const reply = deferred<NativeLinkDiscoverySnapshot | undefined>()
      const snapshot = native.discovery({ projection: native.getProjection()!, rows: [0, 1] })
      let providerCalls = 0
      const host = createProjectedLinkSession({
        getProjection: native.getProjection,
        resolveLinkSnapshot: native.snapshot,
        resolveLinkDiscovery: () => reply.promise,
      })
      cleanups.push(() => host.dispose())
      host.registerLinkProvider({
        provideLinks: () => {
          providerCalls += 1
          return []
        },
      })
      const pending = host.findNextLink(cells)
      if (change === 'cancel') host.cancelLinkResolution()
      else if (change === 'dispose') host.dispose()
      else
        native.setProjection({
          ...native.getProjection()!,
          [change]: native.getProjection()![change] + 1,
        })
      reply.resolve(snapshot)
      await expect(pending).resolves.toBeUndefined()
      expect(providerCalls).toBe(0)
    },
  )

  it('stops candidate scanning when an awaiting host provider loses its projection', async () => {
    const native = nativeHarness('plain text')
    const pendingProvider = deferred<readonly ProvidedLink<Event>[]>()
    let providerCalls = 0
    const host = createProjectedLinkSession({
      getProjection: native.getProjection,
      resolveLinkSnapshot: native.snapshot,
      resolveLinkDiscovery: native.discovery,
    })
    cleanups.push(() => host.dispose())
    host.registerLinkProvider({
      provideLinks: () => {
        providerCalls += 1
        return pendingProvider.promise
      },
    })
    const pending = host.findNextLink(cells)
    await expect.poll(() => providerCalls).toBe(1)
    native.setProjection({ ...native.getProjection()!, revision: 2 })
    pendingProvider.resolve([])
    await expect(pending).resolves.toBeUndefined()
    expect(providerCalls).toBe(1)
  })
})
