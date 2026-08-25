import type { Terminal as XtermTerminalType } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { TerminalElements } from '../../dom/elements.js'
import { defaultXtermTerminalDependencies } from '../runtime.js'
import '../css/xterm.css'

interface TerminalDomHarness {
  readonly root: HTMLElement
  readonly textarea: HTMLTextAreaElement
  dispose(): void
}

interface BaseStructure {
  readonly compositionInHelpers: boolean
  readonly decorationInScreen: boolean
  readonly direction: string
  readonly hasTerminalClass: boolean
  readonly hasXtermClass: boolean
  readonly helpersInScreen: boolean
  readonly screenInScrollable: boolean
  readonly scrollableInRoot: boolean
  readonly selectionInScreen: boolean
  readonly textareaAttributes: Readonly<Record<string, string | number>>
  readonly textareaInHelpers: boolean
  readonly viewportInRoot: boolean
}

interface LayoutHooks {
  readonly composition: Readonly<Record<string, string>>
  readonly helpers: Readonly<Record<string, string>>
  readonly root: Readonly<Record<string, string>>
  readonly screen: Readonly<Record<string, string>>
  readonly textarea: Readonly<Record<string, string>>
  readonly viewport: Readonly<Record<string, string>>
}

interface CompositionState {
  readonly active: boolean
  readonly display: string
  readonly text: string
}

const harnesses: TerminalDomHarness[] = []
const hosts: HTMLDivElement[] = []
let XtermTerminal: typeof XtermTerminalType

function requiredElement<TElement extends Element>(root: Element, selector: string): TElement {
  const element = root.querySelector<TElement>(selector)
  if (element) return element
  throw new TypeError(`Missing required terminal element: ${selector}`)
}

function appendHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.height = '180px'
  host.style.width = '360px'
  document.body.append(host)
  hosts.push(host)
  return host
}

function createReferenceHarness(): TerminalDomHarness {
  const terminal = new XtermTerminal({ cols: 12, rows: 4 })
  terminal.open(appendHost())
  const root = terminal.element
  const textarea = terminal.textarea
  if (!root || !textarea) throw new TypeError('xterm reference did not expose its open DOM')
  const harness = { dispose: () => terminal.dispose(), root, textarea }
  harnesses.push(harness)
  return harness
}

function createTargetHarness(): {
  readonly elements: TerminalElements
  readonly harness: TerminalDomHarness
} {
  const elements = defaultXtermTerminalDependencies.createElements(appendHost())
  const harness = {
    dispose: () => elements.dispose(),
    root: elements.root,
    textarea: elements.textarea,
  }
  harnesses.push(harness)
  return { elements, harness }
}

function attributeValue(element: Element, name: string): string {
  return element.getAttribute(name) ?? ''
}

function structureOf(harness: TerminalDomHarness): BaseStructure {
  const root = harness.root
  const viewport = requiredElement<HTMLElement>(root, '.xterm-viewport')
  const scrollable = requiredElement<HTMLElement>(root, '.xterm-scrollable-element')
  const screen = requiredElement<HTMLElement>(root, '.xterm-screen')
  const helpers = requiredElement<HTMLElement>(screen, '.xterm-helpers')
  const composition = requiredElement<HTMLElement>(helpers, '.composition-view')
  const selection = requiredElement<HTMLElement>(screen, '.xterm-selection')
  const decoration = requiredElement<HTMLElement>(screen, '.xterm-decoration-container')
  const textarea = harness.textarea
  return {
    compositionInHelpers: composition.parentElement === helpers,
    decorationInScreen: decoration.parentElement === screen,
    direction: root.dir,
    hasTerminalClass: root.classList.contains('terminal'),
    hasXtermClass: root.classList.contains('xterm'),
    helpersInScreen: helpers.parentElement === screen,
    screenInScrollable: screen.parentElement === scrollable,
    scrollableInRoot: scrollable.parentElement === root,
    selectionInScreen: selection.parentElement === screen,
    textareaAttributes: {
      ariaLabel: attributeValue(textarea, 'aria-label'),
      ariaMultiline: attributeValue(textarea, 'aria-multiline'),
      autocapitalize: attributeValue(textarea, 'autocapitalize'),
      autocomplete: attributeValue(textarea, 'autocomplete'),
      autocorrect: attributeValue(textarea, 'autocorrect'),
      spellcheck: attributeValue(textarea, 'spellcheck'),
      tabIndex: textarea.tabIndex,
    },
    textareaInHelpers: textarea.parentElement === helpers,
    viewportInRoot: viewport.parentElement === root,
  }
}

function selectedStyles(
  element: Element,
  properties: readonly string[],
): Readonly<Record<string, string>> {
  const computed = getComputedStyle(element)
  const result: Record<string, string> = {}
  for (const property of properties) result[property] = computed.getPropertyValue(property)
  return result
}

function layoutHooksOf(harness: TerminalDomHarness): LayoutHooks {
  const root = harness.root
  const viewport = requiredElement(root, '.xterm-viewport')
  const screen = requiredElement(root, '.xterm-screen')
  const helpers = requiredElement(screen, '.xterm-helpers')
  const composition = requiredElement(helpers, '.composition-view')
  return {
    composition: selectedStyles(composition, ['display', 'position', 'white-space', 'z-index']),
    helpers: selectedStyles(helpers, ['position', 'top', 'z-index']),
    root: selectedStyles(root, ['cursor', 'position', 'user-select']),
    screen: selectedStyles(screen, ['position']),
    textarea: selectedStyles(harness.textarea, [
      'border-bottom-width',
      'border-left-width',
      'border-right-width',
      'border-top-width',
      'margin-bottom',
      'margin-left',
      'margin-right',
      'margin-top',
      'opacity',
      'overflow',
      'padding-bottom',
      'padding-left',
      'padding-right',
      'padding-top',
      'position',
      'resize',
      'white-space',
    ]),
    viewport: selectedStyles(viewport, [
      'bottom',
      'cursor',
      'left',
      'overflow-y',
      'position',
      'right',
      'top',
    ]),
  }
}

function focusLifecycleOf(harness: TerminalDomHarness): readonly [boolean, boolean] {
  harness.textarea.focus({ preventScroll: true })
  const focused = harness.root.classList.contains('focus')
  harness.textarea.blur()
  return [focused, harness.root.classList.contains('focus')]
}

function compositionState(harness: TerminalDomHarness): CompositionState {
  const composition = requiredElement<HTMLElement>(harness.root, '.composition-view')
  return {
    active: composition.classList.contains('active'),
    display: getComputedStyle(composition).display,
    text: composition.textContent ?? '',
  }
}

function compositionLifecycleOf(harness: TerminalDomHarness): readonly CompositionState[] {
  harness.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  const started = compositionState(harness)
  harness.textarea.dispatchEvent(
    new CompositionEvent('compositionupdate', { bubbles: true, data: '漢' }),
  )
  const updated = compositionState(harness)
  harness.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  return [started, updated, compositionState(harness)]
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
  for (const harness of harnesses.splice(0).reverse()) harness.dispose()
  for (const host of hosts.splice(0).reverse()) host.remove()
})

describe('xterm DOM compatibility elements', () => {
  it('matches xterm 6 public hierarchy, hooks, and helper attributes', () => {
    const reference = createReferenceHarness()
    const target = createTargetHarness().harness
    expect(structureOf(target)).toEqual(structureOf(reference))
  })

  it('matches the published stylesheet and focus/composition class lifecycle', () => {
    const reference = createReferenceHarness()
    const target = createTargetHarness().harness
    expect(layoutHooksOf(target)).toEqual(layoutHooksOf(reference))
    expect(focusLifecycleOf(target)).toEqual(focusLifecycleOf(reference))
    expect(compositionLifecycleOf(target)).toEqual(compositionLifecycleOf(reference))
  })

  it('preserves native hooks, geometry updates, and aborting disposal', () => {
    const { elements, harness } = createTargetHarness()
    const compositionView = requiredElement<HTMLElement>(elements.root, '.composition-view')
    expect(elements.root.classList.contains('ghostty-webgpu')).toBe(true)
    expect(elements.canvas.classList.contains('ghostty-webgpu-canvas')).toBe(true)
    expect(elements.textarea.classList.contains('ghostty-webgpu-input')).toBe(true)
    expect(elements.canvas.style.paddingLeft).toBe('0px')

    expect(elements.setPadding({ bottom: 1, left: 3, right: 5, top: 7 })).toBe(true)
    expect(elements.canvas.style.paddingLeft).toBe('3px')
    elements.positionTextarea({ x: 11, y: 13 })
    expect(elements.textarea.style.left).toBe('11px')
    expect(compositionView.style.left).toBe('11px')

    harness.dispose()
    expect(elements.signal.aborted).toBe(true)
    expect(elements.root.isConnected).toBe(false)
    elements.textarea.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(compositionView.classList.contains('active')).toBe(false)
  })
})
