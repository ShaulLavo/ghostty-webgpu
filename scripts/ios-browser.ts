import { WebdriverBrowserProvider, webdriverio } from '@vitest/browser-webdriverio'
import { attach } from 'webdriverio'
import type { BrowserProviderOption, TestProject } from 'vitest/node'
import type { Plugin } from 'vite'
import type { FrameworkHost } from 'waffle/testing/page-runner/framework'
import { fileURLToPath } from 'node:url'

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
    __vitest_takeScreenshot: RejectedNativeCommand
    __vitest_type: RejectedNativeCommand
    __vitest_clear: RejectedNativeCommand
    __vitest_fill: RejectedNativeCommand
    __vitest_tab: RejectedNativeCommand
    __vitest_keyboard: RejectedNativeCommand
    __vitest_selectOptions: RejectedNativeCommand
    __vitest_dragAndDrop: RejectedNativeCommand
    __vitest_hover: RejectedNativeCommand
    __vitest_viewport: RejectedNativeCommand
  }
}

const unsupportedCommands = [
  '__vitest_upload',
  '__vitest_click',
  '__vitest_dblClick',
  '__vitest_tripleClick',
  '__vitest_wheel',
  '__vitest_takeScreenshot',
  '__vitest_type',
  '__vitest_clear',
  '__vitest_fill',
  '__vitest_tab',
  '__vitest_keyboard',
  '__vitest_selectOptions',
  '__vitest_dragAndDrop',
  '__vitest_hover',
  '__vitest_viewport',
] satisfies readonly (keyof import('vitest/browser').BrowserCommands)[]

export function rejectNativeBrowserCommand(name: string): never {
  throw new Error(`Unsupported Ghostty native browser command: ${name}`)
}

export class AttachedGhosttyProvider extends WebdriverBrowserProvider {
  private closed = false
  private readonly host: FrameworkHost

  constructor(project: TestProject, host: FrameworkHost) {
    super(project, {})
    this.host = host
    const browser = project.browser
    if (!browser) throw new Error('Ghostty framework adapter requires a browser project')
    // Reject before any host token is granted, including same-size explicit viewport.
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
      connect: (connection) =>
        attach({
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
        }),
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

  override async setViewport(): Promise<void> {
    throw new Error('Explicit Ghostty native viewport is unsupported')
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
