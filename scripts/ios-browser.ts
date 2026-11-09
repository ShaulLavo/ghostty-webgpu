import { WebdriverBrowserProvider, webdriverio } from '@vitest/browser-webdriverio'
import { attach } from 'webdriverio'
import type {
  BrowserCommand,
  BrowserCommandContext,
  BrowserProviderOption,
  TestProject,
} from 'vitest/node'
import type { Plugin } from 'vite'
import type { FrameworkHost } from 'waffle/testing/page-runner/framework'
import { fileURLToPath } from 'node:url'
import type { ScreenshotOptions } from '@vitest/browser/context'
import type { Buffer } from 'node:buffer'

type ProviderScreenshotOptions = Omit<ScreenshotOptions, 'element'> & {
  element?: { selector: string; locator: unknown }
  target?: 'page'
}

type RejectedNativeCommand = (...payload: unknown[]) => never

declare module 'vitest/internal/browser' {
  interface BrowserCommands {
    __ghostty_initialViewport: (request: unknown) => Promise<void>
    __vitest_cleanup: (state: unknown) => void
    __vitest_upload: RejectedNativeCommand
    __vitest_click: RejectedNativeCommand
    __vitest_dblClick: RejectedNativeCommand
    __vitest_tripleClick: RejectedNativeCommand
    __vitest_wheel: RejectedNativeCommand
    __vitest_takeScreenshot: (
      name: string,
      options: ProviderScreenshotOptions,
    ) => Promise<{ buffer: Buffer; path: string }>
    __vitest_type: RejectedNativeCommand
    __vitest_clear: RejectedNativeCommand
    __vitest_fill: RejectedNativeCommand
    __vitest_tab: RejectedNativeCommand
    __vitest_keyboard: RejectedNativeCommand
    __vitest_selectOptions: RejectedNativeCommand
    __vitest_dragAndDrop: RejectedNativeCommand
    __vitest_hover: RejectedNativeCommand
    __vitest_viewport: (size: { width: number; height: number }) => Promise<void>
  }
}

const unsupportedCommands = [
  '__vitest_upload',
  '__vitest_click',
  '__vitest_dblClick',
  '__vitest_tripleClick',
  '__vitest_wheel',
  '__vitest_type',
  '__vitest_clear',
  '__vitest_fill',
  '__vitest_tab',
  '__vitest_keyboard',
  '__vitest_selectOptions',
  '__vitest_dragAndDrop',
  '__vitest_hover',
] satisfies readonly (keyof import('vitest/browser').BrowserCommands)[]

export function rejectNativeBrowserCommand(name: string): never {
  throw new Error(`Unsupported Ghostty native browser command: ${name}`)
}

type ContextCheck = (context: BrowserCommandContext) => () => void

export async function checkedCommand<T>(
  check: () => void,
  invoke: () => T | PromiseLike<T>,
  secondary: unknown[],
): Promise<T> {
  check()
  let outcome: { kind: 'fulfilled'; value: T } | { kind: 'rejected'; reason: unknown }
  try {
    outcome = { kind: 'fulfilled', value: await invoke() }
  } catch (reason) {
    outcome = { kind: 'rejected', reason }
  }
  try {
    check()
  } catch (reason) {
    if (outcome.kind === 'fulfilled') throw reason
    secondary.push(reason)
  }
  if (outcome.kind === 'rejected') throw outcome.reason
  return outcome.value
}

type ScreenshotRegistration = {
  prepare: ContextCheck | undefined
  secondary: unknown[]
}

function guardedScreenshot<Payload extends unknown[], Result>(
  command: BrowserCommand<Payload, Result>,
  registration: ScreenshotRegistration,
  host: FrameworkHost,
): BrowserCommand<Payload, Result> {
  return function (this: unknown, context, ...payload) {
    if (!registration.prepare || !context.testPath)
      throw new Error('Ghostty screenshot adapter is not ready')
    const check = registration.prepare(context)
    const invoke = async () => command.call(this, context, ...payload)
    return host.provider({ kind: 'screenshot', file: context.testPath }, async () =>
      checkedCommand(check, invoke, registration.secondary),
    )
  }
}

function interceptScreenshot(project: TestProject, host: FrameworkHost) {
  const browser = project.browser
  if (!browser) throw new Error('Ghostty framework adapter requires a browser project')
  const original = browser.registerCommand
  const forward: typeof original = original.bind(browser)
  let count = 0
  const registration: ScreenshotRegistration = { prepare: undefined, secondary: [] }
  const register: typeof original = function (name, command) {
    if (name !== '__vitest_takeScreenshot') return forward(name, command)
    count++
    forward(name, guardedScreenshot(command, registration, host))
  }
  browser.registerCommand = register
  return {
    secondary: registration.secondary,
    restore: () => {
      browser.registerCommand = original
    },
    install: (check: ContextCheck) => {
      if (count !== 1) throw new Error('Expected exactly one official screenshot registration')
      registration.prepare = check
    },
  }
}

function sameDescriptor(
  descriptor: object,
  fields: readonly string[],
  retained: readonly unknown[] | undefined,
): boolean {
  return fields.every((key, index) => Reflect.get(descriptor, key) === retained?.[index])
}

function nativeSessionCheck(
  current: () => WebdriverIO.Browser | null,
  attached: WebdriverIO.Browser,
  connection: import('waffle/testing/page-runner/framework').AttachedConnection,
): () => void {
  const sessionId = connection.sessionId
  const capabilities = attached.capabilities
  const requested = attached.requestedCapabilities
  const options = attached.options
  const retainedOptions: [string, unknown][] = Object.entries(connection.options)
  const descriptors = [capabilities, requested]
  const fields = [
    'browserName',
    'browserVersion',
    'platformName',
    'safari:useSimulator',
    'safari:deviceUDID',
  ]
  const retained = descriptors.map((descriptor) =>
    fields.map((key): unknown => Reflect.get(descriptor, key)),
  )
  return () => {
    if (
      current() !== attached ||
      attached.sessionId !== sessionId ||
      attached.capabilities !== capabilities ||
      attached.requestedCapabilities !== requested ||
      attached.options !== options ||
      !retainedOptions.every(([key, value]) => Reflect.get(options, key) === value)
    )
      throw new Error('Ghostty native session descriptor changed')
    const unchanged = descriptors.every((descriptor, index) =>
      sameDescriptor(descriptor, fields, retained[index]),
    )
    if (!unchanged) throw new Error('Ghostty native capabilities changed')
  }
}

export class AttachedGhosttyProvider extends WebdriverBrowserProvider {
  private closed = false
  private readonly host: FrameworkHost
  private readonly ownerProject: TestProject
  private readonly ownerBrowser: NonNullable<TestProject['browser']>
  private frameworkSession: string | undefined
  private nativeCheck: (() => void) | undefined
  readonly secondaryContextFaults: readonly unknown[]

  constructor(project: TestProject, host: FrameworkHost) {
    const registration = interceptScreenshot(project, host)
    try {
      super(project, {})
    } finally {
      registration.restore()
    }
    this.host = host
    this.ownerProject = project
    this.secondaryContextFaults = registration.secondary
    const browser = project.browser
    if (!browser) throw new Error('Ghostty framework adapter requires a browser project')
    this.ownerBrowser = browser
    registration.install((context) => this.captureContext(context))
    browser.registerCommand('__vitest_viewport', (_context, size) => this.setViewport(size))
    for (const name of unsupportedCommands) {
      browser.registerCommand(name, () => {
        rejectNativeBrowserCommand(name)
      })
    }
    browser.registerCommand('__ghostty_initialViewport', (_context, request: unknown) =>
      host.initialViewport(request),
    )
    browser.registerCommand('__vitest_cleanup', (_context, state: unknown) => {
      if (typeof state !== 'object' || state === null || !('unreleased' in state)) return
      if (!Array.isArray(state.unreleased) || state.unreleased.length !== 0)
        throw new Error('Unsupported Ghostty native keyboard cleanup')
    })
  }

  override async openBrowser(): Promise<WebdriverIO.Browser> {
    if (this.closed) throw new Error('Attached Ghostty provider is closed')
    if (this.browser) return this.browser
    const thisHost = this.host
    this.browser = await this.host.attach({
      connect: async (connection) => {
        const attached = await attach({
          ...connection,
          options: {
            ...connection.options,
            beforeCommand: function () {
              thisHost.requestStarted(this)
            },
            transformRequest: (request) => this.host.guardRequest(request),
            transformResponse: (response, request) => this.host.observeResponse(response, request),
            afterCommand: () => this.host.requestSettled({ kind: 'completed' }),
          },
        })
        this.nativeCheck = nativeSessionCheck(() => this.browser, attached, connection)
        return attached
      },
      detach: () => this.close(),
      frames: {
        isTestFrame: () => this.isIframeSwitched(),
        main: () => this.switchToMainFrame(),
        tester: () => this.switchToTestFrame(),
      },
    })
    return this.browser
  }

  override async openPage(sessionId: string, url: string): Promise<void> {
    if (this.closed) throw new Error('Attached Ghostty provider is closed')
    if (this.frameworkSession !== undefined && this.frameworkSession !== sessionId)
      throw new Error('Ghostty framework session changed')
    this.frameworkSession = sessionId
    await this.host.openPage(url, () => super.openPage(sessionId, url))
  }

  override switchToTestFrame(): Promise<void> {
    return this.host.provider('test-frame', async () => {
      if (!this.isIframeSwitched()) await super.switchToTestFrame()
    })
  }

  override switchToMainFrame(): Promise<void> {
    return this.host.provider('main-frame', async () => {
      if (this.isIframeSwitched()) await super.switchToMainFrame()
    })
  }

  private captureContext(context: BrowserCommandContext): () => void {
    const browser = this.browser
    const file = context.testPath
    const session = this.frameworkSession
    const check = () => {
      if (
        this.closed ||
        !browser ||
        !file ||
        !session ||
        !this.nativeCheck ||
        context.project !== this.ownerProject ||
        this.ownerProject.browser !== this.ownerBrowser ||
        this.ownerBrowser.provider !== this ||
        context.provider !== this ||
        context.browser !== browser ||
        this.browser !== browser ||
        context.sessionId !== session ||
        this.frameworkSession !== session ||
        context.testPath !== file
      )
        throw new Error('Ghostty screenshot context changed')
      this.nativeCheck()
    }
    check()
    return check
  }

  override async setViewport(size: { width: number; height: number }): Promise<void> {
    if (this.closed) throw new Error('Attached Ghostty provider is closed')
    await this.host.provider({ kind: 'viewport', width: size.width, height: size.height })
  }

  override async getCDPSession(): Promise<never> {
    throw new Error('Ghostty native CDP is unsupported')
  }

  override async close(): Promise<void> {
    this.closed = true
    await this.host.detach()
    this.browser = null
  }
}

export function attachedGhosttyProvider(host: FrameworkHost): BrowserProviderOption {
  return {
    ...webdriverio(),
    providerFactory: (project) => new AttachedGhosttyProvider(project, host),
  }
}

type DocumentInput = Parameters<FrameworkHost['instrumentDocument']>[0]
const documentHook = Symbol.for('ghostty.framework.instrumentDocument')
const pageModule = '/@ghostty/framework-page'

export function ghosttyFrameworkPlugin(
  host: Pick<FrameworkHost, 'mount' | 'instrumentDocument'>,
): Plugin {
  const instrument = (input: DocumentInput) => host.instrumentDocument(input)
  const onClose = () => {
    if (Reflect.get(globalThis, documentHook) === instrument)
      Reflect.deleteProperty(globalThis, documentHook)
  }
  return {
    name: 'ghostty-framework-observation',
    enforce: 'pre',
    config() {
      return { optimizeDeps: { include: ['waffle/testing/page-runner/framework-page'] } }
    },
    configureServer(server) {
      if (Reflect.has(globalThis, documentHook)) throw new Error('Duplicate Ghostty framework host')
      host.mount(server.middlewares)
      Reflect.set(globalThis, documentHook, instrument)
      server.httpServer?.once('close', onClose)
    },
    resolveId(id) {
      if (id === pageModule) return fileURLToPath(new URL('./ios-browser-page.ts', import.meta.url))
    },
  }
}
