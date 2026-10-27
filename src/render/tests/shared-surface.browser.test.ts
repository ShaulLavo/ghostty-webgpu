import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { GhosttyRuntime } from '../../../dist/core/runtime.js'
import { WebGpuTerminalRenderer } from '../../../dist/render/webgpu/renderer.js'
import { WebGpuSharedSurface } from '../../../dist/render/webgpu/shared-surface.js'
import { probeFont } from '../dom/tests/probe.js'

interface Pane {
  readonly host: HTMLElement
  readonly canvas: HTMLCanvasElement
  readonly renderer: WebGpuTerminalRenderer
  write(data: string): void
}

type Build = (parent: HTMLElement, surface?: WebGpuSharedSurface) => Promise<Pane[]>

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  await runCleanup()
})

async function runCleanup(): Promise<void> {
  for (const step of cleanup.splice(0).reverse()) await step()
}

function container(css = ''): HTMLElement {
  const element = document.createElement('div')
  element.style.cssText = `position:relative;width:400px;height:200px;background:rgb(40 40 40);${css}`
  document.body.append(element)
  cleanup.push(() => element.remove())
  return element
}

async function pane(
  parent: HTMLElement,
  text: string,
  css: string,
  surface?: WebGpuSharedSurface,
): Promise<Pane> {
  const host = document.createElement('div')
  host.style.cssText = `position:absolute;line-height:0;${css}`
  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  host.append(canvas)
  parent.append(host)
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
  const renderer = await WebGpuTerminalRenderer.create({
    canvas,
    columns: 12,
    rows: 3,
    font: probeFont,
    renderState: runtime.createRenderState(terminal),
    surface,
  })
  renderer.setCursorBlinkEnabled(false)
  const write = (data: string) => {
    terminal.write(data)
    renderer.notifyWrite()
  }
  write(`\x1b[?25l\x1b[48;2;20;60;90m\x1b[2J\x1b[H${text}`)
  cleanup.push(async () => {
    await renderer.dispose()
    runtime.dispose()
  })
  return { host, canvas, renderer, write }
}

function surfaceOn(element: HTMLElement): WebGpuSharedSurface {
  const surface = new WebGpuSharedSurface(element)
  cleanup.push(() => surface.dispose())
  return surface
}

async function frames(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1)
    await new Promise((resolve) => requestAnimationFrame(resolve))
}

function shot(element: HTMLElement): Promise<string> {
  return page.screenshot({ element, save: false, scale: 'device' })
}

// Screenshots of each pane drawn to its own canvas, then the same layout on one shared surface.
async function compare(build: Build, css = '') {
  const own = await build(container(css))
  await frames()
  const expected = await Promise.all(own.map((entry) => shot(entry.canvas)))
  await runCleanup()
  const parent = container(css)
  const surface = surfaceOn(parent)
  const panes = await build(parent, surface)
  await frames()
  return { expected, panes, parent, surface }
}

const corners = ['left:0;top:0', 'left:200px;top:100px']

it('paints each pane exactly as its own canvas would', async () => {
  const { expected, panes } = await compare((parent, surface) =>
    Promise.all([
      pane(parent, 'alpha 界é🙂', corners[0]!, surface),
      pane(parent, '\x1b[1mbeta\x1b[3mfi', corners[1]!, surface),
    ]),
  )
  expect(document.querySelectorAll('canvas').length).toBe(3)
  expect(await Promise.all(panes.map((entry) => shot(entry.canvas)))).toEqual(expected)
})

it('composites once per coordinated frame however many panes changed', async () => {
  const parent = container()
  const surface = surfaceOn(parent)
  const panes = [
    await pane(parent, 'one', corners[0]!, surface),
    await pane(parent, 'two', corners[1]!, surface),
  ]
  await frames()
  const before = surface.compositedFrames
  for (const entry of panes) entry.write('\r\nmore')
  await frames(2)
  expect(surface.compositedFrames - before).toBe(1)
})

it('clips a pane to a rectangular overflow ancestor inside the container', async () => {
  const { expected, panes } = await compare(async (parent, surface) => {
    const clip = document.createElement('div')
    clip.style.cssText =
      'position:absolute;left:10px;top:10px;width:40px;height:30px;overflow:hidden'
    parent.append(clip)
    return [await pane(clip, 'WWWWWWWWWWWW\r\nWWWWWWWWWWWW', 'left:-5px;top:-5px', surface)]
  })
  expect(await shot(panes[0]!.canvas)).toBe(expected[0])
})

it('scrolls with its container without another composite', async () => {
  const { expected, panes, parent, surface } = await compare(
    async (parent, surface) => [await pane(parent, 'scrolled', 'left:0;top:300px', surface)],
    'overflow:auto',
  )
  const composited = surface.compositedFrames
  parent.scrollTop = 150
  await frames()
  expect(surface.compositedFrames).toBe(composited)
  expect(await shot(panes[0]!.canvas)).toBe(expected[0])
})

it('lands a fractional pane offset on the same device pixels as its own canvas', async () => {
  const { expected, panes } = await compare(async (parent, surface) => [
    await pane(parent, 'fraction', 'left:10.3px;top:7.6px', surface),
  ])
  expect(await shot(panes[0]!.canvas)).toBe(expected[0])
})

it('drops hidden and disposed panes and repaints re-entered ones', async () => {
  const parent = container()
  const surface = surfaceOn(parent)
  const blank = await shot(parent)
  const first = await pane(parent, 'first', corners[0]!, surface)
  await frames()
  const painted = await shot(parent)
  expect(painted).not.toBe(blank)
  first.host.style.display = 'none'
  await frames()
  expect(await shot(parent)).toBe(blank)
  first.host.style.display = ''
  await frames()
  expect(await shot(parent)).toBe(painted)
  first.host.style.visibility = 'hidden'
  surface.invalidate()
  await frames()
  expect(await shot(parent)).toBe(blank)
  first.host.style.visibility = ''
  surface.invalidate()
  await frames()
  await first.renderer.dispose()
  await frames()
  expect(await shot(parent)).toBe(blank)
  first.host.remove()
  await pane(parent, 'first', corners[0]!, surface)
  await frames()
  expect(await shot(parent)).toBe(painted)
})

it('follows a pane resize', async () => {
  const { expected, panes } = await compare(async (parent, surface) => [
    await pane(parent, 'wide', 'left:0;top:0', surface),
  ])
  const resized = panes[0]!
  resized.renderer.resize({ columns: 20, rows: 5 })
  resized.write('\x1b[48;2;20;60;90m\x1b[2J\x1b[Hwide')
  await frames()
  const grown = await shot(resized.canvas)
  resized.renderer.resize({ columns: 12, rows: 3 })
  resized.write('\x1b[48;2;20;60;90m\x1b[2J\x1b[Hwide')
  await frames()
  expect(grown).not.toBe(expected[0])
  expect(await shot(resized.canvas)).toBe(expected[0])
})

it('recovers every pane after the shared device is lost', async () => {
  const { expected, panes } = await compare((parent, surface) =>
    Promise.all([
      pane(parent, 'lost one', corners[0]!, surface),
      pane(parent, 'lost two', corners[1]!, surface),
    ]),
  )
  const device = (panes[0]!.renderer as unknown as { device: GPUDevice }).device
  device.destroy()
  await device.lost
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (panes.every((entry) => entry.renderer.metrics.deviceRestores === 1)) break
    await frames(1)
  }
  await frames()
  expect(panes.map((entry) => entry.renderer.metrics.deviceRestores)).toEqual([1, 1])
  expect(await Promise.all(panes.map((entry) => shot(entry.canvas)))).toEqual(expected)
})

it('keeps each Terminal host its own input and pointer target', async () => {
  const { Terminal } = await import('../../../dist/index.js')
  const parent = container('width:800px;height:200px;display:flex')
  const surface = surfaceOn(parent)
  const typed: string[][] = [[], []]
  const terminals = await Promise.all(
    [0, 1].map(async (index) => {
      const root = document.createElement('div')
      root.style.cssText = 'width:390px;height:180px'
      parent.append(root)
      const terminal = await Terminal.create({
        appearance: { cursor: { blink: false } },
        rendererFactory: (options) => WebGpuTerminalRenderer.create({ ...options, surface }),
      })
      cleanup.push(() => terminal.dispose())
      terminal.onData((data) => typed[index]!.push(new TextDecoder().decode(data)))
      await terminal.open(root)
      terminal.write(`terminal ${index}`)
      return { root, terminal }
    }),
  )
  await frames()
  expect(parent.querySelectorAll('canvas').length).toBe(3)
  expect(document.elementFromPoint(600, parent.getBoundingClientRect().top + 50)).not.toBe(
    surface.canvas,
  )
  terminals[1]!.terminal.focus()
  await userEvent.keyboard('b')
  terminals[0]!.terminal.focus()
  await userEvent.keyboard('a')
  expect(typed).toEqual([['a'], ['b']])
  expect(terminals.map(({ root }) => root.contains(document.activeElement))).toEqual([true, false])
})
