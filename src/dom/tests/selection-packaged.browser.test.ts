import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Terminal as MainTerminal } from '../../../dist/index.js'
import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'
import type { TerminalApi } from '../../../dist/dom/terminal-api.js'
import { WebGlTerminalRenderer } from '../../../dist/render/webgl/renderer.js'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const family = 'PackagedSelectionTest'
const fontUrl = new URL(
  '../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2',
  import.meta.url,
).href
const assets = {
  wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
  bridge: new URL('../../../bridge.wasm', import.meta.url).href,
}

async function eventually(condition: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5000
  while (!(await condition())) {
    if (performance.now() > deadline) expect.fail('Packaged selection did not settle')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function create(mode: 'main' | 'worker') {
  const root = document.createElement('div')
  root.style.cssText = 'width:400px;height:100px;position:relative'
  document.body.append(root)
  cleanups.push(() => root.remove())
  const appearance = { font: { family, size: 16 }, cursor: { blink: false } }
  if (mode === 'main') {
    const face = await new FontFace(family, `url(${JSON.stringify(fontUrl)})`).load()
    document.fonts.add(face)
    cleanups.push(() => document.fonts.delete(face))
    const terminal = await MainTerminal.create({
      appearance,
      runtime: { kind: 'owned', options: assets },
      rendererFactory: (options) => WebGlTerminalRenderer.create(options),
    })
    cleanups.push(() => terminal.dispose())
    await terminal.open(root)
    return terminal
  }
  const terminal = await WorkerTerminal.create({
    appearance,
    assets,
    backend: 'webgl',
    fonts: [{ family, source: { url: fontUrl } }],
  })
  cleanups.push(() => terminal.dispose())
  await terminal.open(root)
  return terminal
}

function pointer(terminal: TerminalApi, type: string, column: number, buttons: number) {
  const canvas = terminal.canvas!
  const bounds = canvas.getBoundingClientRect()
  const summary = terminal.submittedFrame!
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons,
    clientX: bounds.left + summary.padding.left + summary.font.cssCellWidth * (column + 0.2),
    clientY: bounds.top + summary.padding.top + summary.font.cssCellHeight * 0.5,
  })
  canvas.dispatchEvent(event)
  return event
}

describe.each(['main', 'worker'] as const)('%s packaged native selection', (mode) => {
  it('owns pointer selection synchronously and reads history through the public entry', async () => {
    const terminal = await create(mode)
    const errors: unknown[] = []
    terminal.on('error', (error) => errors.push(error))
    await terminal.write('selected text\r\nsecond line')
    await eventually(() => terminal.visibleLines()[0]?.startsWith('selected text') === true)
    await eventually(async () => (await terminal.captureViewport()) !== undefined)
    pointer(terminal, 'pointerdown', 0, 1)
    expect(terminal.diagnostics.pointerOwner).toBe('selection')
    pointer(terminal, 'pointermove', 7, 1)
    pointer(terminal, 'pointermove', 9, 1)
    pointer(terminal, 'pointerup', 9, 0)
    expect(terminal.diagnostics.pointerOwner).toBe('none')
    await eventually(
      async () =>
        errors.length > 0 || (await terminal.getSelection())?.startsWith('selected') === true,
    )
    expect(errors).toEqual([])
    expect(terminal.diagnostics.pointerOwner).toBe('none')
    const selection = terminal.getSelection()
    expect(selection instanceof Promise).toBe(mode === 'worker')
    expect(await selection).toContain('select')
    await eventually(() => terminal.submittedFrame?.selection !== undefined)
    await page.screenshot({
      element: terminal.element!,
      path: `packaged-${mode}-pointer-selection.png`,
    })
    expect(await terminal.selectionCoordinates()).toBeDefined()
    expect((await terminal.readLines(0, await terminal.lineCount()))[0]?.text).toContain(
      'selected text',
    )
    await terminal.clearSelection()
    expect(await terminal.getSelection()).toBeUndefined()
    await terminal.write('\x1b[?1000h\x1b[?1006h')
    const output: string[] = []
    terminal.onData((data) => output.push(new TextDecoder().decode(data)))
    const down = pointer(terminal, 'pointerdown', 1, 1)
    expect(down.defaultPrevented).toBe(true)
    expect(terminal.diagnostics.pointerOwner).toBe('mouse')
    pointer(terminal, 'pointerup', 1, 0)
    await eventually(() => output.some((value) => value.startsWith('\x1b[<0;')))
    expect(terminal.diagnostics.pointerOwner).toBe('none')
  }, 15000)
})

it('starts the packaged worker default copy during activation before native readback', async () => {
  const platform = Object.getOwnPropertyDescriptor(navigator, 'platform')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  cleanups.push(() => {
    if (platform) Object.defineProperty(navigator, 'platform', platform)
    else Reflect.deleteProperty(navigator, 'platform')
  })
  const terminal = await create('worker')
  const errors: unknown[] = []
  terminal.on('error', (error) => errors.push(error))
  await terminal.write('activated selection')
  await terminal.selectRange({ x: 0, y: 0 }, { x: 8, y: 0 })
  await eventually(() => terminal.submittedFrame?.selection !== undefined)
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  let active = false
  let pendingAtWrite = false
  let started = false
  let duringDispatch = false
  let trusted = false
  let copied: string | undefined
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: async (items: ClipboardItem[]) => {
        started = true
        active = navigator.userActivation.isActive
        pendingAtWrite = copied === undefined
        copied = await (await items[0]!.getType('text/plain')).text()
      },
    },
  })
  cleanups.push(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  terminal.textarea!.addEventListener('keydown', (event) => {
    if (event.code !== 'KeyC' || !event.metaKey) return
    trusted = event.isTrusted
    duringDispatch = started && copied === undefined
  })
  terminal.focus()
  await userEvent.keyboard('{Meta>}c{/Meta}')
  await eventually(() => copied !== undefined || errors.length > 0)
  expect(errors).toEqual([])
  expect(active).toBe(true)
  expect(pendingAtWrite).toBe(true)
  expect(trusted).toBe(true)
  expect(duringDispatch).toBe(true)
  expect(copied).toBe('activated')
  await page.screenshot({ element: terminal.element!, path: 'packaged-worker-selection-copy.png' })
}, 15000)

it('completes an activated packaged worker copy through the real browser clipboard', async ({
  skip,
}) => {
  const clipboard = navigator.clipboard
  if (!clipboard?.write || typeof ClipboardItem === 'undefined') {
    skip('Browser clipboard writes are unavailable')
    return
  }
  const button = document.createElement('button')
  button.textContent = 'Clipboard baseline'
  document.body.append(button)
  cleanups.push(() => button.remove())
  let baseline: Promise<void> | undefined
  button.addEventListener('click', () => {
    baseline = clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['baseline']) })])
    void baseline.catch(() => {})
  })
  await userEvent.click(button)
  expect(baseline).toBeDefined()
  try {
    await baseline
  } catch (cause) {
    if (!(cause instanceof DOMException) || cause.name !== 'NotAllowedError') throw cause
    skip('Browser denies ordinary activated clipboard writes')
    return
  }
  const platform = Object.getOwnPropertyDescriptor(navigator, 'platform')
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  cleanups.push(() => {
    if (platform) Object.defineProperty(navigator, 'platform', platform)
    else Reflect.deleteProperty(navigator, 'platform')
  })
  const terminal = await create('worker')
  await terminal.write('browser copy')
  await terminal.selectRange({ x: 0, y: 0 }, { x: 6, y: 0 })
  await eventually(() => terminal.submittedFrame?.selection !== undefined)
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  let active = false
  let completed = false
  let text: string | undefined
  const errors: unknown[] = []
  terminal.on('error', (error) => errors.push(error))
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: (items: ClipboardItem[]) => {
        active = navigator.userActivation.isActive
        const result = clipboard.write(items)
        return result.then(async () => {
          text = await (await items[0]!.getType('text/plain')).text()
          completed = true
        })
      },
    },
  })
  cleanups.push(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  terminal.focus()
  await userEvent.keyboard('{Meta>}c{/Meta}')
  await eventually(() => completed || errors.length > 0)
  expect(errors).toEqual([])
  expect(active).toBe(true)
  expect(text).toBe('browser')
}, 15000)
