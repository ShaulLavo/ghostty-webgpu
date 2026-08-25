import type { Terminal as XtermTerminalType } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { GhosttyWebGpuRenderer } from '../../dom/types.js'
import type { RendererTheme } from '../../render/instances/types.js'
import {
  WebGpuTerminalRenderer,
  type RendererFrameSnapshot,
  type RendererGridSize,
  type WebGpuTerminalRendererOptions,
} from '../../render/renderer.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { Terminal } from '../terminal.js'
import '../css/xterm.css'

interface AccessibilityDriver {
  readonly name: string
  readonly root: HTMLElement
  readonly textarea: HTMLTextAreaElement
  dispose(): void
  setScreenReaderMode(enabled: boolean): void
}

interface AccessibilityDom {
  readonly liveAria: string | null
  readonly liveClass: boolean
  readonly rowRoles: readonly (string | null)[]
  readonly rowTabIndexes: readonly number[]
  readonly textareaActiveDescendant: string | null
  readonly textareaControls: string | null
  readonly textareaDescribedBy: string | null
  readonly textareaLabel: string | null
  readonly treeAriaLabel: string | null
  readonly treeClass: boolean
  readonly treeRole: string | null
  readonly wrapperFirst: boolean
}

const drivers: AccessibilityDriver[] = []
const hosts: HTMLDivElement[] = []
const rendererRestores: Array<() => void> = []
let XtermTerminal: typeof XtermTerminalType

class FrameRenderer implements GhosttyWebGpuRenderer {
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

function accessibilityFrame(rows = 4): RendererFrameSnapshot {
  return {
    cursor: {
      blinking: false,
      passwordInput: false,
      style: 'block',
      viewport: { wideTail: false, x: 0, y: 0 },
      visible: true,
    },
    rows: Array.from({ length: rows }, (_, y) => ({
      cells: [`row ${y + 1}`],
      continuations: [false],
      text: `row ${y + 1}`,
      y,
    })),
  }
}

function installFrameRenderer(): void {
  const originalCreate = WebGpuTerminalRenderer.create
  WebGpuTerminalRenderer.create = (async (options: WebGpuTerminalRendererOptions) => {
    options.onFrame?.(accessibilityFrame())
    return new FrameRenderer() as unknown as WebGpuTerminalRenderer
  }) as typeof WebGpuTerminalRenderer.create
  rendererRestores.push(() => {
    WebGpuTerminalRenderer.create = originalCreate
  })
}

function appendHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.height = '180px'
  host.style.width = '360px'
  document.body.append(host)
  hosts.push(host)
  return host
}

function requireOpenTerminal(
  name: string,
  root: HTMLElement | undefined,
  textarea: HTMLTextAreaElement | undefined,
): { readonly root: HTMLElement; readonly textarea: HTMLTextAreaElement } {
  if (!root || !textarea) throw new TypeError(`${name} did not expose its open DOM`)
  return { root, textarea }
}

function createReferenceDriver(screenReaderMode: boolean): AccessibilityDriver {
  const terminal = new XtermTerminal({ cols: 12, rows: 4, screenReaderMode })
  terminal.open(appendHost())
  const elements = requireOpenTerminal('@xterm/xterm@6.0.0', terminal.element, terminal.textarea)
  const driver = {
    dispose: () => terminal.dispose(),
    name: '@xterm/xterm@6.0.0',
    root: elements.root,
    setScreenReaderMode: (enabled: boolean) => {
      terminal.options = { screenReaderMode: enabled }
    },
    textarea: elements.textarea,
  }
  drivers.push(driver)
  return driver
}

async function createTargetDriver(screenReaderMode: boolean): Promise<AccessibilityDriver> {
  installFrameRenderer()
  const terminal = new Terminal({ cols: 12, rows: 4, screenReaderMode })
  terminal.open(appendHost())
  await Promise.all([terminal.ghosttyReady, terminal.ghosttyOpened])
  const elements = requireOpenTerminal(
    'ghostty-webgpu Terminal',
    terminal.element,
    terminal.textarea,
  )
  const driver = {
    dispose: () => terminal.dispose(),
    name: 'ghostty-webgpu Terminal',
    root: elements.root,
    setScreenReaderMode: (enabled: boolean) => {
      terminal.options = { screenReaderMode: enabled }
    },
    textarea: elements.textarea,
  }
  drivers.push(driver)
  return driver
}

function requiredElement<TElement extends Element>(root: Element, selector: string): TElement {
  const element = root.querySelector<TElement>(selector)
  if (element) return element
  throw new TypeError(`Missing required accessibility element: ${selector}`)
}

function accessibilityDom(driver: AccessibilityDriver): AccessibilityDom | undefined {
  const wrapper = driver.root.querySelector<HTMLElement>('.xterm-accessibility')
  if (!wrapper) return undefined
  const tree = requiredElement<HTMLElement>(wrapper, '.xterm-accessibility-tree')
  const live = requiredElement<HTMLElement>(wrapper, '.live-region')
  const rows = [...tree.children]
  return {
    liveAria: live.getAttribute('aria-live'),
    liveClass: live.classList.contains('live-region'),
    rowRoles: rows.map((row) => row.getAttribute('role')),
    rowTabIndexes: rows.map((row) => (row as HTMLElement).tabIndex),
    textareaActiveDescendant: driver.textarea.getAttribute('aria-activedescendant'),
    textareaControls: driver.textarea.getAttribute('aria-controls'),
    textareaDescribedBy: driver.textarea.getAttribute('aria-describedby'),
    textareaLabel: driver.textarea.getAttribute('aria-label'),
    treeAriaLabel: tree.getAttribute('aria-label'),
    treeClass: tree.classList.contains('xterm-accessibility-tree'),
    treeRole: tree.getAttribute('role'),
    wrapperFirst: driver.root.firstElementChild === wrapper,
  }
}

beforeAll(async () => {
  const runtimeUrl = new URL('../../../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url)
    .href
  const xterm = (await import(/* @vite-ignore */ runtimeUrl)) as {
    readonly Terminal: typeof XtermTerminalType
  }
  XtermTerminal = xterm.Terminal
})

afterEach(() => {
  for (const driver of drivers.splice(0).reverse()) driver.dispose()
  for (const restore of rendererRestores.splice(0).reverse()) restore()
  for (const host of hosts.splice(0).reverse()) host.remove()
})

describe.sequential('xterm accessibility DOM compatibility', () => {
  it('matches released xterm roles, hooks, prompt label, and initial enabled state', async () => {
    const promptLabel = 'Plan 010 terminal prompt'
    const originalReferenceLabel = XtermTerminal.strings.promptLabel
    const originalTargetLabel = Terminal.strings.promptLabel
    XtermTerminal.strings.promptLabel = promptLabel
    Terminal.strings.promptLabel = promptLabel

    try {
      const reference = createReferenceDriver(true)
      const target = await createTargetDriver(true)
      expect(accessibilityDom(target)).toEqual(accessibilityDom(reference))
      expect(target.root.querySelector('.xterm-accessibility-tree')?.classList).toContain(
        'ghostty-webgpu-accessibility',
      )
      expect(target.root.querySelector('.live-region')?.classList).toContain(
        'ghostty-webgpu-live-region',
      )
    } finally {
      XtermTerminal.strings.promptLabel = originalReferenceLabel
      Terminal.strings.promptLabel = originalTargetLabel
    }
  })

  it('matches dynamic enable-disable lifecycle without replacing the public root or textarea', async () => {
    const reference = createReferenceDriver(false)
    const target = await createTargetDriver(false)

    for (const driver of [reference, target]) {
      const root = driver.root
      const textarea = driver.textarea
      expect(accessibilityDom(driver), driver.name).toBeUndefined()

      driver.setScreenReaderMode(true)
      expect(driver.root, driver.name).toBe(root)
      expect(driver.textarea, driver.name).toBe(textarea)
      expect(accessibilityDom(driver), driver.name).toBeDefined()

      driver.setScreenReaderMode(false)
      expect(driver.root, driver.name).toBe(root)
      expect(driver.textarea, driver.name).toBe(textarea)
      expect(accessibilityDom(driver), driver.name).toBeUndefined()
      expect(textarea.getAttribute('aria-label'), driver.name).toBe('Terminal input')
    }
  })
})
