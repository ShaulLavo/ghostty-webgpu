import type { Terminal as XtermTerminalType } from '@xterm/xterm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { RendererTheme } from '../../render/instances/types.js'
import type { RendererGridSize } from '../../render/renderer.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { GhosttyWebGpuTerminal } from '../../dom/terminal.js'
import type { GhosttyWebGpuRenderer } from '../../dom/types.js'
import {
  createGhosttyBrowserLifecycleDriver,
  createXtermBrowserLifecycleDriver,
  type BrowserLifecycleDriver,
  type SmokeSize,
} from './smoke-driver.js'

class NoopRenderer implements GhosttyWebGpuRenderer {
  readonly hasPendingFrame = false
  readonly hasPendingTimer = false

  dispose(): void {}
  notifyScroll(): void {}
  notifySelectionChange(): void {}
  notifyWrite(): void {}
  resize(_grid: RendererGridSize): void {}
  schedule(): void {}
  setCursorBlinkEnabled(_enabled: boolean): void {}
  setDocumentVisible(_visible: boolean): void {}
  setFocused(_focused: boolean): void {}
  setFont(_font: TerminalFittedFont): void {}
  setTheme(_theme: Partial<RendererTheme>): void {}
}

const drivers: BrowserLifecycleDriver[] = []
const hosts: HTMLElement[] = []
let runtime: GhosttyRuntime
let XtermTerminal: typeof XtermTerminalType | undefined

beforeAll(async () => {
  const runtimeUrl = new URL('../../../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url)
    .href
  const xterm = (await import(/* @vite-ignore */ runtimeUrl)) as {
    readonly Terminal: typeof XtermTerminalType
  }
  XtermTerminal = xterm.Terminal
  runtime = await GhosttyRuntime.create()
})

afterEach(() => {
  for (const driver of drivers.splice(0).reverse()) driver.dispose()
  for (const host of hosts.splice(0).reverse()) host.remove()
})

afterAll(() => {
  runtime.dispose()
})

function trackedHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.height = '180px'
  host.style.width = '360px'
  document.body.append(host)
  hosts.push(host)
  return host
}

function trackedXterm(options: ConstructorParameters<typeof XtermTerminalType>[0] = {}) {
  if (!XtermTerminal) throw new TypeError('xterm browser runtime was not loaded')
  const driver = createXtermBrowserLifecycleDriver(new XtermTerminal(options))
  drivers.push(driver)
  return driver
}

async function trackedGhostty(size?: SmokeSize): Promise<BrowserLifecycleDriver> {
  const terminal = await GhosttyWebGpuTerminal.create({
    ...(size ? { appearance: { grid: size } } : {}),
    rendererFactory: () => Promise.resolve(new NoopRenderer()),
    runtime: { kind: 'borrowed', runtime },
  })
  const driver = createGhosttyBrowserLifecycleDriver(terminal)
  drivers.push(driver)
  return driver
}

describe.sequential('released xterm browser lifecycle smoke observables', () => {
  it('records matching constructor dimensions and absent pre-open DOM references', async () => {
    const xtermDefault = trackedXterm()
    const ghosttyDefault = await trackedGhostty()
    const xtermCustom = trackedXterm({ cols: 91, rows: 33 })
    const ghosttyCustom = await trackedGhostty({ columns: 91, rows: 33 })

    expect(xtermDefault.size()).toEqual({ columns: 80, rows: 24 })
    expect(ghosttyDefault.size()).toEqual({ columns: 80, rows: 24 })
    expect(xtermCustom.size()).toEqual({ columns: 91, rows: 33 })
    expect(ghosttyCustom.size()).toEqual({ columns: 91, rows: 33 })
    expect(xtermDefault.dom()).toEqual({ element: undefined, textarea: undefined })
    expect(ghosttyDefault.dom()).toEqual({ element: undefined, textarea: undefined })
  })

  it('records xterm reopen as a no-op and Ghostty reopen as a rejection', async () => {
    const xterm = trackedXterm()
    const ghostty = await trackedGhostty()
    const xtermFirstHost = trackedHost()
    const xtermSecondHost = trackedHost()
    const ghosttyFirstHost = trackedHost()
    const ghosttySecondHost = trackedHost()

    expect(xterm.open(xtermFirstHost)).toBeUndefined()
    const xtermOpened = xterm.dom()
    expect(xterm.open(xtermSecondHost)).toBeUndefined()
    expect(xterm.dom()).toEqual(xtermOpened)
    expect(xtermFirstHost.contains(xtermOpened.element!)).toBe(true)
    expect(xtermSecondHost.childElementCount).toBe(0)

    const ghosttyOpen = ghostty.open(ghosttyFirstHost)
    expect(ghosttyOpen).toBeInstanceOf(Promise)
    await ghosttyOpen
    await expect(Promise.resolve(ghostty.open(ghosttySecondHost))).rejects.toThrow(
      'Terminal cannot open while lifecycle is open',
    )
    expect(ghosttyFirstHost.contains(ghostty.dom().element!)).toBe(true)
    expect(ghosttySecondHost.childElementCount).toBe(0)
  })

  it('records xterm retained disconnected references and Ghostty cleared references', async () => {
    const xterm = trackedXterm()
    const ghostty = await trackedGhostty()
    expect(xterm.open(trackedHost())).toBeUndefined()
    await ghostty.open(trackedHost())
    const xtermOpened = xterm.dom()
    const ghosttyOpened = ghostty.dom()

    expect(xtermOpened.element?.isConnected).toBe(true)
    expect(xtermOpened.textarea?.isConnected).toBe(true)
    expect(ghosttyOpened.element?.isConnected).toBe(true)
    expect(ghosttyOpened.textarea?.isConnected).toBe(true)

    xterm.dispose()
    ghostty.dispose()

    expect(xterm.dom()).toEqual(xtermOpened)
    expect(xterm.dom().element?.isConnected).toBe(false)
    expect(xterm.dom().textarea?.isConnected).toBe(false)
    expect(ghostty.dom()).toEqual({ element: undefined, textarea: undefined })
    expect(() => {
      xterm.dispose()
      ghostty.dispose()
    }).not.toThrow()
  })
})
