import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import { WebGpuUnavailableError } from '../../render/renderer.js'
import { createCompatibleTerminalRenderer } from '../../render/selector.js'
import { TerminalSession } from '../../term/session.js'
import { createXtermTerminalElements } from '../../xterm/elements.js'
import { createTerminalElements } from '../elements.js'
import { createGhosttyWebGpuTerminalFromSession, type Terminal } from '../terminal.js'

const decoder = new TextDecoder()
const escape = '\u001b'
const cleanups: Array<() => void> = []
const originalViewport = { width: window.innerWidth, height: window.innerHeight }
let runtime: GhosttyRuntime

beforeAll(async () => {
  await page.viewport(320, 240)
  runtime = await GhosttyRuntime.create()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

afterAll(async () => {
  runtime.dispose()
  await page.viewport(originalViewport.width, originalViewport.height)
})

async function fixture(layout: 'native' | 'xterm' = 'native') {
  const host = document.createElement('div')
  host.style.width = '320px'
  host.style.height = '160px'
  host.style.backgroundColor = '#112233'
  document.body.append(host)
  cleanups.push(() => host.remove())
  const session = await TerminalSession.create<Event>({
    appearance: {
      cursor: { blink: false },
      font: { family: 'monospace', size: 16 },
      grid: { columns: 12, pixelRatio: 1, rows: 3 },
    },
    runtime: { kind: 'borrowed', runtime },
  })
  const createElements = layout === 'native' ? createTerminalElements : createXtermTerminalElements
  const elements = createElements(host, { padding: { bottom: 4, left: 5, right: 6, top: 3 } })
  const observations = { frames: 0 }
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: false,
    elements,
    rendererFactory: (options, signal) =>
      createCompatibleTerminalRenderer(
        {
          ...options,
          deviceFactory: () =>
            Promise.reject(new WebGpuUnavailableError('adapter', 'No supported adapter')),
          onFrame: (snapshot) => {
            observations.frames += 1
            options.onFrame?.(snapshot)
          },
        },
        signal,
      ),
  })
  cleanups.push(() => terminal.dispose())
  const errors: unknown[] = []
  terminal.on('error', (error) => errors.push(error))
  await terminal.open(host)
  terminal.write(`${escape}[?25l█${escape}[48;2;0;0;255m ${escape}[0m\r\nhello`)
  terminal.setTheme({ ...terminal.appearance.theme, foreground: { r: 255, g: 0, b: 0 } })
  terminal.focus()
  await settle(terminal)
  expect(terminal.diagnostics.rendererBackend).toBe('webgl2')
  return { elements, errors, host, observations, session, terminal }
}

function requiredCanvas(terminal: Terminal): HTMLCanvasElement {
  const canvas = terminal.canvas
  if (!canvas) throw new Error('Expected an open terminal canvas')
  return canvas
}

function lossExtension(canvas: HTMLCanvasElement): WEBGL_lose_context {
  const context = canvas.getContext('webgl2')
  const extension = context?.getExtension('WEBGL_lose_context')
  if (!extension) throw new Error('This test requires WebGL context loss support')
  return extension
}

async function settle(terminal: Terminal): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await expect.poll(() => terminal.hasPendingFrame).toBe(false)
}

async function loseContext(terminal: Terminal): Promise<void> {
  const canvas = requiredCanvas(terminal)
  const lost = new Promise((resolve) =>
    canvas.addEventListener('webglcontextlost', resolve, { once: true }),
  )
  lossExtension(canvas).loseContext()
  await lost
  await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('canvas2d')
  await settle(terminal)
}

async function screenshot(canvas: HTMLCanvasElement): Promise<ImageData> {
  const png = await page.screenshot({ element: canvas, save: false, scale: 'css' })
  const image = new Image()
  image.src = `data:image/png;base64,${png}`
  await image.decode()
  const bounds = canvas.getBoundingClientRect()
  expect([image.naturalWidth, image.naturalHeight]).toEqual([
    Math.round(bounds.width),
    Math.round(bounds.height),
  ])
  const decoded = document.createElement('canvas')
  decoded.width = image.naturalWidth
  decoded.height = image.naturalHeight
  const context = decoded.getContext('2d')
  if (!context) throw new Error('Screenshot decoding requires Canvas2D')
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, decoded.width, decoded.height)
}

function cellPosition(terminal: Terminal, column: number, row: number) {
  const canvas = requiredCanvas(terminal)
  const style = getComputedStyle(canvas)
  const grid = terminal.appearance.grid
  return {
    x: Number.parseFloat(style.paddingLeft) + (column + 0.5) * grid.cellWidth,
    y: Number.parseFloat(style.paddingTop) + (row + 0.5) * grid.cellHeight,
  }
}

function displayedCell(image: ImageData, terminal: Terminal, column: number, row: number) {
  const position = cellPosition(terminal, column, row)
  const offset = (Math.floor(position.y) * image.width + Math.floor(position.x)) * 4
  return [...image.data.subarray(offset, offset + 4)]
}

function typeInput(textarea: HTMLTextAreaElement, data: string): void {
  textarea.value = data
  textarea.dispatchEvent(
    new InputEvent('input', { bubbles: true, data, inputType: 'insertText', isComposing: false }),
  )
}

describe('runtime renderer fallback in the DOM host', () => {
  it.each(['native', 'xterm'] as const)(
    'preserves %s elements, pixels, input, selection, links, and layout after WebGL loss',
    async (layout) => {
      const { elements, errors, observations, session, terminal } = await fixture(layout)
      const canvas = requiredCanvas(terminal)
      const root = terminal.element
      const textarea = elements.textarea
      const padding = canvas.style.padding
      const parent = canvas.parentElement
      const nextSibling = canvas.nextSibling
      canvas.dataset.owner = 'retained'
      terminal.selectRange({ x: 0, y: 1 }, { x: 2, y: 1 })
      expect(terminal.getSelection()).toBe('hel')
      const initial = await screenshot(canvas)
      expect(displayedCell(initial, terminal, 0, 0)).toEqual([255, 0, 0, 255])
      expect(displayedCell(initial, terminal, 1, 0)).toEqual([0, 0, 255, 255])

      await loseContext(terminal)
      const replacement = requiredCanvas(terminal)
      expect(replacement).not.toBe(canvas)
      expect(replacement.parentElement).toBe(parent)
      expect(replacement.nextSibling).toBe(nextSibling)
      expect(replacement.dataset.owner).toBe('retained')
      expect(replacement.style.padding).toBe(padding)
      expect(canvas.isConnected).toBe(false)
      expect(elements.canvas).toBe(replacement)
      expect(terminal.element).toBe(root)
      expect(terminal.textarea).toBe(textarea)
      expect(document.activeElement).toBe(textarea)
      expect(terminal.getSelection()).toBe('hel')
      const recovered = await screenshot(replacement)
      expect(displayedCell(recovered, terminal, 0, 0)).toEqual([255, 0, 0, 255])
      expect(displayedCell(recovered, terminal, 1, 0)).toEqual([0, 0, 255, 255])

      const previousFrames = observations.frames
      terminal.setTheme({ ...terminal.appearance.theme, foreground: { r: 0, g: 255, b: 0 } })
      terminal.write(`${escape}[1;2H${escape}[48;2;255;255;0m ${escape}[0m`)
      await settle(terminal)
      const updated = await screenshot(replacement)
      expect(displayedCell(updated, terminal, 0, 0)).toEqual([0, 255, 0, 255])
      expect(displayedCell(updated, terminal, 1, 0)).toEqual([255, 255, 0, 255])
      expect(observations.frames).toBeGreaterThan(previousFrames)

      const data: string[] = []
      terminal.onData((bytes) => data.push(decoder.decode(bytes)))
      typeInput(textarea, 'hello')
      expect(data).toEqual(['hello'])
      terminal.clearSelection()
      await page.elementLocator(replacement).dblClick({ position: cellPosition(terminal, 1, 1) })
      expect(terminal.getSelection()).toBe('hello')

      let activations = 0
      terminal.registerLinkProvider({
        provideLinks: (line) =>
          line.text.startsWith('hello')
            ? [
                {
                  activate: () => {
                    activations += 1
                  },
                  range: { start: 0, end: 4 },
                  text: 'hello link',
                },
              ]
            : undefined,
      })
      await expect(terminal.focusNextLink()).resolves.toBe(true)
      const link = root?.querySelector('[role="link"]')
      expect(document.activeElement).toBe(link)
      link?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expect(activations).toBe(1)

      const width = replacement.width
      session.resize({ columns: 16, rows: 4 })
      await settle(terminal)
      expect(replacement.width).toBeGreaterThan(width)
      expect(replacement.style.padding).toBe(padding)
      expect(errors).toEqual([])
      terminal.dispose()
      expect(terminal.lifecycle).toBe('disposed')
      expect(terminal.hasPendingFrame).toBe(false)
      expect(terminal.hasPendingTimer).toBe(false)
      expect(replacement.isConnected).toBe(false)
      typeInput(textarea, 'ignored')
      expect(data).toEqual(['hello'])
    },
  )

  it('cancels an active pointer gesture when its WebGL canvas is lost', async () => {
    const { errors, terminal } = await fixture()
    const canvas = requiredCanvas(terminal)
    const extension = lossExtension(canvas)
    let ownerAtLoss = 'none'
    canvas.addEventListener(
      'pointerdown',
      () => {
        ownerAtLoss = terminal.diagnostics.pointerOwner
        extension.loseContext()
      },
      { once: true },
    )

    await page.elementLocator(canvas).click({ delay: 100, position: cellPosition(terminal, 1, 1) })
    await expect.poll(() => terminal.diagnostics.rendererBackend).toBe('canvas2d')
    expect(ownerAtLoss).toBe('selection')
    expect(terminal.diagnostics.pointerOwner).toBe('none')
    expect(terminal.diagnostics.pressedButtonCount).toBe(0)
    expect(requiredCanvas(terminal)).not.toBe(canvas)
    expect(errors).toEqual([])
  })

  it('returns focused link navigation to the same input after replacing its canvas', async () => {
    const { elements, errors, terminal } = await fixture()
    terminal.registerLinkProvider({
      provideLinks: (line) =>
        line.text.startsWith('hello')
          ? [{ activate: () => {}, range: { start: 0, end: 4 }, text: 'hello link' }]
          : undefined,
    })
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    expect(document.activeElement?.classList.contains('ghostty-webgpu-link')).toBe(true)

    await loseContext(terminal)
    expect(document.activeElement).toBe(elements.textarea)
    await expect(terminal.focusNextLink()).resolves.toBe(true)
    expect(document.activeElement?.classList.contains('ghostty-webgpu-link')).toBe(true)
    expect(errors).toEqual([])
  })
})
