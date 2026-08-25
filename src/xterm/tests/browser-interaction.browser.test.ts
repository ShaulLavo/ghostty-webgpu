import type { Terminal as XtermTerminalType } from '@xterm/xterm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Terminal } from '../terminal.js'
import type { ITerminalInitOnlyOptions, ITerminalOptions } from '../types.js'
import '../css/xterm.css'

interface InteractionTerminal {
  readonly element: HTMLElement | undefined
  readonly options: ITerminalOptions
  readonly textarea: HTMLTextAreaElement | undefined
  blur(): void
  dispose(): void
  focus(): void
  getSelection(): string
  open(parent: HTMLElement): void
  write(data: string, callback?: () => void): void
}

interface TrackedTerminal {
  readonly kind: 'reference' | 'target'
  readonly ready: Promise<void>
  readonly terminal: InteractionTerminal
}

interface ShellOptionObservation {
  readonly allowTransparency: boolean | undefined
  readonly disableStdin: boolean | undefined
  readonly readOnly: boolean
}

interface FocusObservation {
  readonly active: boolean
  readonly rootClass: boolean
}

type TerminalConstructionOptions = ITerminalOptions & ITerminalInitOnlyOptions

const hosts: HTMLDivElement[] = []
const terminals: InteractionTerminal[] = []
let XtermTerminal: typeof XtermTerminalType

beforeAll(async () => {
  const runtimeUrl = new URL('../../../node_modules/@xterm/xterm/lib/xterm.mjs', import.meta.url)
    .href
  const xterm = (await import(/* @vite-ignore */ runtimeUrl)) as {
    readonly Terminal: typeof XtermTerminalType
  }
  XtermTerminal = xterm.Terminal
})

afterEach(() => {
  for (const terminal of terminals.splice(0).reverse()) terminal.dispose()
  for (const host of hosts.splice(0).reverse()) host.remove()
})

function trackedHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.height = '180px'
  host.style.width = '360px'
  document.body.append(host)
  hosts.push(host)
  return host
}

function track(
  kind: TrackedTerminal['kind'],
  terminal: InteractionTerminal,
  ready: Promise<void>,
): TrackedTerminal {
  terminals.push(terminal)
  terminal.open(trackedHost())
  return { kind, ready, terminal }
}

function trackedReference(options: TerminalConstructionOptions = {}): TrackedTerminal {
  const terminal = new XtermTerminal(options)
  return track('reference', terminal, Promise.resolve())
}

function trackedTarget(options: TerminalConstructionOptions = {}): TrackedTerminal {
  const terminal = new Terminal(options)
  const ready = Promise.all([terminal.ghosttyReady, terminal.ghosttyOpened]).then(() => {})
  return track('target', terminal, ready)
}

function requiredElement<TElement extends Element>(
  terminal: InteractionTerminal,
  selector: string,
): TElement {
  const element = terminal.element?.querySelector<TElement>(selector)
  if (element) return element
  throw new TypeError(`Missing required terminal element: ${selector}`)
}

function requiredRoot(terminal: InteractionTerminal): HTMLElement {
  const root = terminal.element
  if (root) return root
  throw new TypeError('Terminal did not expose its root after open')
}

function requiredTextarea(terminal: InteractionTerminal): HTMLTextAreaElement {
  const textarea = terminal.textarea
  if (textarea) return textarea
  throw new TypeError('Terminal did not expose its textarea after open')
}

function shellOptionsOf(terminal: InteractionTerminal): ShellOptionObservation {
  return {
    allowTransparency: terminal.options.allowTransparency,
    disableStdin: terminal.options.disableStdin,
    readOnly: requiredTextarea(terminal).readOnly,
  }
}

function focusOf(terminal: InteractionTerminal): FocusObservation {
  const textarea = requiredTextarea(terminal)
  return {
    active: textarea.ownerDocument.activeElement === textarea,
    rootClass: requiredRoot(terminal).classList.contains('focus'),
  }
}

function focusLifecycle(terminal: InteractionTerminal): readonly FocusObservation[] {
  terminal.focus()
  const focused = focusOf(terminal)
  terminal.blur()
  return [focused, focusOf(terminal)]
}

function hasAccessibilityTree(terminal: InteractionTerminal): boolean {
  const selector = '.xterm-accessibility, .ghostty-webgpu-accessibility'
  return requiredRoot(terminal).querySelector(selector) !== null
}

function printableKey(textarea: HTMLTextAreaElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: 'KeyA',
    key: 'a',
  })
  Object.defineProperties(event, {
    keyCode: { value: 65 },
    which: { value: 65 },
  })
  textarea.dispatchEvent(event)
  return event
}

async function writeComplete(terminal: InteractionTerminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve))
}

function cellCenter(
  element: HTMLElement,
  column: number,
  row: number,
  columns: number,
  rows: number,
): Readonly<{ x: number; y: number }> {
  const bounds = element.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new TypeError('Terminal selection surface has no measurable geometry')
  }
  return {
    x: bounds.left + ((column + 0.5) * bounds.width) / columns,
    y: bounds.top + ((row + 0.5) * bounds.height) / rows,
  }
}

function dispatchReferenceWordSelection(terminal: InteractionTerminal, column: number): void {
  const screen = requiredElement<HTMLElement>(terminal, '.xterm-screen')
  const point = cellCenter(screen, column, 0, 20, 4)
  screen.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      buttons: 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      detail: 2,
    }),
  )
  screen.ownerDocument.dispatchEvent(
    new MouseEvent('mouseup', {
      bubbles: true,
      button: 0,
      buttons: 0,
      clientX: point.x,
      clientY: point.y,
      detail: 2,
    }),
  )
}

function dispatchTargetClick(canvas: HTMLCanvasElement, column: number): void {
  const point = cellCenter(canvas, column, 0, 20, 4)
  canvas.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      buttons: 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      pointerId: 1,
    }),
  )
  canvas.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      pointerId: 1,
    }),
  )
}

function dispatchTargetWordSelection(terminal: InteractionTerminal, column: number): void {
  const canvas = requiredElement<HTMLCanvasElement>(terminal, 'canvas')
  dispatchTargetClick(canvas, column)
  dispatchTargetClick(canvas, column)
}

async function selectedWord(harness: TrackedTerminal, mutateSeparator?: string): Promise<string> {
  await harness.ready
  await writeComplete(harness.terminal, 'alpha-beta gamma')
  if (mutateSeparator !== undefined) harness.terminal.options.wordSeparator = mutateSeparator
  if (harness.kind === 'reference') dispatchReferenceWordSelection(harness.terminal, 7)
  if (harness.kind === 'target') dispatchTargetWordSelection(harness.terminal, 7)
  return harness.terminal.getSelection()
}

describe.sequential('released xterm browser interaction observables', () => {
  it('matches disableStdin at construction and after mutable option changes', async () => {
    const reference = trackedReference({ allowTransparency: true, disableStdin: true })
    const target = trackedTarget({ allowTransparency: true, disableStdin: true })
    await target.ready

    expect(shellOptionsOf(target.terminal)).toEqual(shellOptionsOf(reference.terminal))

    reference.terminal.options.allowTransparency = false
    reference.terminal.options.disableStdin = false
    target.terminal.options.allowTransparency = false
    target.terminal.options.disableStdin = false

    expect(shellOptionsOf(target.terminal)).toEqual(shellOptionsOf(reference.terminal))
  })

  it('matches textarea focus and the public root focus class', async () => {
    const reference = trackedReference()
    const target = trackedTarget()
    expect(focusLifecycle(target.terminal)).toEqual(focusLifecycle(reference.terminal))
    await target.ready
  })

  it('matches the mutable screenReaderMode tree and deterministic key default handling', async () => {
    const reference = trackedReference({ screenReaderMode: false })
    const target = trackedTarget({ screenReaderMode: false })
    await target.ready

    expect(hasAccessibilityTree(target.terminal)).toBe(hasAccessibilityTree(reference.terminal))
    const disabledDefaults = [reference, target].map(
      (harness) => printableKey(requiredTextarea(harness.terminal)).defaultPrevented,
    )
    expect(disabledDefaults[1]).toBe(disabledDefaults[0])

    reference.terminal.options.screenReaderMode = true
    target.terminal.options.screenReaderMode = true
    expect(hasAccessibilityTree(target.terminal)).toBe(hasAccessibilityTree(reference.terminal))
    const enabledDefaults = [reference, target].map(
      (harness) => printableKey(requiredTextarea(harness.terminal)).defaultPrevented,
    )
    expect(enabledDefaults[1]).toBe(enabledDefaults[0])
    expect(enabledDefaults[1]).toBe(false)

    reference.terminal.options.screenReaderMode = false
    target.terminal.options.screenReaderMode = false
    expect(hasAccessibilityTree(target.terminal)).toBe(hasAccessibilityTree(reference.terminal))
  })

  it('matches construction and mutable wordSeparator selection through Ghostty native state', async () => {
    const referenceInitial = trackedReference({ cols: 20, rows: 4, wordSeparator: ' -' })
    const targetInitial = trackedTarget({ cols: 20, rows: 4, wordSeparator: ' -' })
    expect(await selectedWord(targetInitial)).toBe(await selectedWord(referenceInitial))
    expect(targetInitial.terminal.getSelection()).toBe('beta')

    const referenceMutable = trackedReference({ cols: 20, rows: 4, wordSeparator: ' -' })
    const targetMutable = trackedTarget({ cols: 20, rows: 4, wordSeparator: ' -' })
    expect(await selectedWord(targetMutable, ' ')).toBe(await selectedWord(referenceMutable, ' '))
    expect(targetMutable.terminal.getSelection()).toBe('alpha-beta')
  })
})
