import { testFontUrl } from '../../tests/fonts.js'
import {
  observeDisplayedFrame,
  displayedFrameListener,
  type DisplayedTextFrame,
} from '../../render/displayed-frame.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { Terminal as MainTerminal } from '../../../dist/index.js'
import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'
import type { TerminalApi } from '../../../dist/dom/terminal-api.js'
import { WebGlTerminalRenderer } from '../../../dist/render/webgl/renderer.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import { CanvasTerminalRenderer } from '../../render/canvas/renderer.js'
import type { RendererTextFrameSnapshot } from '../../render/renderer.js'
import type { RenderSchedulerClock } from '../../render/scheduler.js'
import { TerminalSession } from '../../term/session.js'
import type { TerminalAccessibilityController } from '../accessibility.js'
import { createTerminalElements } from '../elements.js'
import type { TerminalSubmittedSnapshot } from '../submitted-frame.js'
import { createGhosttyWebGpuTerminalFromSession } from '../terminal.js'

const escape = '\u001b'
const cleanups: Array<() => void | Promise<void>> = []
let runtime: GhosttyRuntime

class DeferredFrameClock implements RenderSchedulerClock {
  private nextHandle = 0
  readonly frames = new Map<number, () => void>()

  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }

  clearTimer(handle: number): void {
    window.clearTimeout(handle)
  }

  requestFrame(callback: () => void): number {
    const handle = ++this.nextHandle
    this.frames.set(handle, callback)
    return handle
  }

  setTimer(callback: () => void, delayMs: number): number {
    return window.setTimeout(callback, delayMs)
  }

  flush(): void {
    const frames = [...this.frames.values()]
    this.frames.clear()
    for (const callback of frames) callback()
  }
}

beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

afterAll(() => {
  runtime.dispose()
})

async function fixture() {
  const host = document.createElement('div')
  host.style.cssText = 'width:400px;height:180px;position:relative'
  document.body.append(host)
  cleanups.push(() => host.remove())
  const session = await TerminalSession.create<Event>({
    appearance: {
      cursor: { blink: false },
      font: { family: 'monospace', size: 16 },
      grid: { columns: 20, pixelRatio: 1, rows: 3 },
    },
    runtime: { kind: 'borrowed', runtime },
  })
  cleanups.push(() => session.dispose())
  const background = session.appearance.rendererTheme.background
  host.style.backgroundColor = `rgb(${background.r} ${background.g} ${background.b})`
  const elements = createTerminalElements(host, {
    padding: { bottom: 4, left: 5, right: 6, top: 3 },
  })
  elements.textarea.setAttribute('aria-label', 'Existing input')
  elements.textarea.setAttribute('aria-controls', 'existing-screen')
  elements.textarea.setAttribute('aria-describedby', 'existing-description')
  const clock = new DeferredFrameClock()
  let renderer: CanvasTerminalRenderer | undefined
  const snapshots: RendererTextFrameSnapshot[] = []
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    accessibility: {},
    autoFit: false,
    elements,
    rendererFactory: async (options) => {
      renderer = await CanvasTerminalRenderer.create({
        ...options,
        schedulerClock: clock,
        ...{
          [observeDisplayedFrame]: (snapshot: DisplayedTextFrame) => {
            displayedFrameListener(options)?.(snapshot)
            snapshots.push(snapshot)
          },
        },
      })
      return renderer
    },
  })
  cleanups.push(() => terminal.dispose())
  const errors: unknown[] = []
  terminal.on('error', (error) => errors.push(error))
  observeText(terminal)
  await terminal.open(host)
  clock.flush()
  expect(renderer).toBeDefined()
  expect(publishedFrame(terminal)).toBeDefined()
  return { clock, elements, errors, host, renderer: renderer!, session, snapshots, terminal }
}

const publications = new WeakMap<object, TerminalSubmittedSnapshot>()
function observeText(terminal: TerminalApi): void {
  terminal.onText((text) => {
    publications.set(terminal, { ...terminal.submittedFrame!, ...text })
  })
}
function publishedFrame(terminal: TerminalApi): TerminalSubmittedSnapshot | undefined {
  return publications.get(terminal)
}

function controller(terminal: object): TerminalAccessibilityController {
  const value = Reflect.get(terminal, 'accessibility') as
    | TerminalAccessibilityController
    | undefined
  expect(value).toBeDefined()
  return value!
}

function submittedSnapshot(terminal: object): RendererTextFrameSnapshot {
  const value = Reflect.get(terminal, 'lastFrame') as RendererTextFrameSnapshot | undefined
  expect(value).toBeDefined()
  return value!
}

function expectDisplayed(
  harness: { readonly terminal: Pick<TerminalApi, 'textarea'> },
  summary: TerminalSubmittedSnapshot,
): void {
  const accessibility = controller(harness.terminal)
  const textarea = harness.terminal.textarea!
  const rows = accessibility.rowElements
  expect(accessibility.mirror.getAttribute('role')).toBe('list')
  expect(accessibility.mirror.hasAttribute('aria-hidden')).toBe(false)
  expect(rows.every((row) => row.getAttribute('role') === 'listitem')).toBe(true)
  expect(rows.map((row) => row.textContent)).toEqual(summary.rows.map((row) => row.text.trimEnd()))
  expect(rows.map((row) => row.getAttribute('aria-posinset'))).toEqual(
    summary.rows.map((row) => String(summary.scrollbar.offset + row.y + 1)),
  )
  expect(rows.map((row) => row.getAttribute('aria-setsize'))).toEqual(
    summary.rows.map(() => String(summary.scrollbar.total)),
  )
  expect(rows.map((row) => row.getAttribute('data-row'))).toEqual(
    summary.rows.map((row) => String(summary.scrollbar.offset + row.y)),
  )
  expect(summary.grid.cellWidth).toBe(summary.font.cssCellWidth)
  expect(summary.grid.cellHeight).toBe(summary.font.cssCellHeight)
  const viewport = summary.cursor.viewport
  if (!viewport || !summary.cursor.visible) {
    expect(accessibility.cursorStatus.textContent).toBe('Cursor location unavailable')
    expect(textarea.hasAttribute('aria-activedescendant')).toBe(false)
    expect(rows.every((row) => !row.hasAttribute('aria-current'))).toBe(true)
    return
  }
  const column = viewport.wideTail ? Math.max(0, viewport.x - 1) : viewport.x
  const row = rows[viewport.y]!
  expect(accessibility.cursorStatus.textContent).toBe(
    `Cursor at row ${summary.scrollbar.offset + viewport.y + 1}, column ${column + 1}`,
  )
  expect(textarea.getAttribute('aria-activedescendant')).toBe(row.id)
  expect(row.getAttribute('aria-current')).toBe('true')
  expect(rows.filter((row) => row.hasAttribute('aria-current'))).toHaveLength(1)
  expect(Number.parseFloat(textarea.style.left)).toBeCloseTo(
    summary.padding.left + column * summary.grid.cellWidth,
  )
  expect(Number.parseFloat(textarea.style.top)).toBeCloseTo(
    summary.padding.top + viewport.y * summary.grid.cellHeight,
  )
}

describe('accessibility from real submitted native frames', () => {
  it('retains one displayed subject through pending output and font layout, then announces the new submission', async () => {
    const harness = await fixture()
    const { clock, terminal } = harness
    const accessibility = controller(terminal)
    expect(terminal.write('displayed') instanceof Promise).toBe(false)
    clock.flush()
    const displayed = publishedFrame(terminal)!
    const rowIds = accessibility.rowElements.map((row) => row.id)
    expectDisplayed(harness, displayed)
    expect(accessibility.liveRegion.textContent).toBe('displayed')
    accessibility.liveRegion.replaceChildren()

    terminal.write('!')
    harness.session.renderState.update()
    terminal.setFont({ size: 20 })
    expect(publishedFrame(terminal)).toBe(displayed)
    expectDisplayed(harness, displayed)
    expect(accessibility.liveRegion.textContent).toBe('')
    clock.flush()

    const next = publishedFrame(terminal)!
    expect(next.frame).toBeGreaterThan(displayed.frame)
    expect(next.layout).toBeGreaterThan(displayed.layout)
    expect(next.font.settings.size).toBe(20)
    expect(next.padding).toEqual({ bottom: 4, left: 5, right: 6, top: 3 })
    expect(next.rows[0]?.text.trimEnd()).toBe('displayed!')
    expect(displayed.rows[0]?.text.trimEnd()).toBe('displayed')
    expectDisplayed(harness, next)
    expect(accessibility.rowElements.map((row) => row.id)).toEqual(rowIds)
    expect(accessibility.liveRegion.textContent).toBe('!')
    expect(harness.errors).toEqual([])
    await page.screenshot({
      element: harness.elements.root,
      path: '../../../.artifacts/submitted-accessibility.png',
      scale: 'css',
    })
  })

  it('uses submitted scroll positions and keeps resized grid, font and cursor together until paint', async () => {
    const harness = await fixture()
    const { clock, renderer, session, terminal } = harness
    terminal.write('alpha\r\nbeta\r\ngamma\r\ndelta\r\nepsilon\r\nzeta')
    clock.flush()
    const bottom = publishedFrame(terminal)!
    expect(bottom.scrollbar.offset).toBeGreaterThan(0)
    expect(bottom.rows.map((row) => row.text.trimEnd())).toEqual(['delta', 'epsilon', 'zeta'])
    expectDisplayed(harness, bottom)
    const liveRegion = controller(terminal).liveRegion
    liveRegion.replaceChildren()

    expect(terminal.scrollToTop() instanceof Promise).toBe(false)
    expect(session.scrollbar.offset).toBe(0)
    expect(publishedFrame(terminal)).toBe(bottom)
    expectDisplayed(harness, bottom)
    clock.flush()
    const top = publishedFrame(terminal)!
    expect(top.scrollbar.offset).toBe(0)
    expect(top.rows.map((row) => row.text.trimEnd())).toEqual(['alpha', 'beta', 'gamma'])
    expectDisplayed(harness, top)
    expect(liveRegion.textContent).toBe('')
    expect(terminal.readLines(0, 1)[0]?.text.trimEnd()).toBe('alpha')

    terminal.scrollToBottom()
    clock.flush()
    const beforeResize = publishedFrame(terminal)!
    renderer.setDocumentVisible(false)
    terminal.setAppearance({ grid: { columns: 24, rows: 4 } })
    terminal.setFont({ size: 18 })
    expect(publishedFrame(terminal)).toBe(beforeResize)
    expectDisplayed(harness, beforeResize)
    renderer.setDocumentVisible(true)
    clock.flush()
    const resized = publishedFrame(terminal)!
    expect(resized.layout).toBeGreaterThan(beforeResize.layout)
    expect(resized.grid).toMatchObject({ columns: 24, rows: 4 })
    expect(resized.font.settings.size).toBe(18)
    expect(resized.rows).toHaveLength(4)
    expectDisplayed(harness, resized)
    expect(liveRegion.textContent).toBe('')
    expect(harness.errors).toEqual([])
  })

  it('projects native wide-tail, hidden and restored cursors onto accessible rows and the input caret', async () => {
    const harness = await fixture()
    const { clock, terminal } = harness
    terminal.write(`AB界Z\r\nnext${escape}[1;4H`)
    clock.flush()
    const wide = publishedFrame(terminal)!
    expect(wide.rows[0]?.text.trimEnd()).toBe('AB界Z')
    expect(wide.cursor.viewport).toEqual({ x: 3, y: 0, wideTail: true })
    expectDisplayed(harness, wide)
    expect(controller(terminal).cursorStatus.textContent).toBe('Cursor at row 1, column 3')

    terminal.write(`${escape}[?25l`)
    clock.flush()
    expect(publishedFrame(terminal)!.cursor.visible).toBe(false)
    expectDisplayed(harness, publishedFrame(terminal)!)
    terminal.write(`${escape}[?25h${escape}[2;3H`)
    clock.flush()
    expect(publishedFrame(terminal)!.cursor.viewport).toMatchObject({ x: 2, y: 1 })
    expectDisplayed(harness, publishedFrame(terminal)!)
    expect(controller(terminal).rowElements[0]?.hasAttribute('aria-current')).toBe(false)
    expect(harness.errors).toEqual([])
  })

  it('hydrates toggles without native queries and rejects late leaf updates and cancelled frame callbacks after disposal', async () => {
    const harness = await fixture()
    const { clock, elements, session, terminal } = harness
    terminal.write('owned rows')
    clock.flush()
    const old = controller(terminal)
    const oldSnapshot = submittedSnapshot(terminal)
    const oldSummary = publishedFrame(terminal)!
    const readRows = vi.spyOn(session.renderState, 'readRows')
    const readTextRows = vi.spyOn(session.renderState, 'readTextRows')
    const readLines = vi.spyOn(session, 'readLines')
    const getSelection = vi.spyOn(session, 'getSelection')
    cleanups.push(() => {
      readRows.mockRestore()
      readTextRows.mockRestore()
      readLines.mockRestore()
      getSelection.mockRestore()
    })

    terminal.setAccessibilityEnabled(false)
    expect(elements.textarea.getAttribute('aria-label')).toBe('Existing input')
    expect(elements.textarea.getAttribute('aria-controls')).toBe('existing-screen')
    expect(elements.textarea.getAttribute('aria-describedby')).toBe('existing-description')
    expect(elements.textarea.hasAttribute('aria-activedescendant')).toBe(false)
    terminal.write('!')
    terminal.setAccessibilityEnabled(true)
    expectDisplayed(harness, oldSummary)
    const replacement = controller(terminal)
    expect(replacement).not.toBe(old)
    const attributes = elements.textarea.outerHTML
    old.notifyOutput()
    expect(old.update(oldSnapshot, oldSummary.scrollbar)).toEqual({
      announced: false,
      full: false,
      updatedRows: 0,
    })
    expect(elements.textarea.outerHTML).toBe(attributes)
    expect(replacement.liveRegion.textContent).toBe('')
    expect(readRows).not.toHaveBeenCalled()
    expect(readTextRows).not.toHaveBeenCalled()
    expect(readLines).not.toHaveBeenCalled()
    expect(getSelection).not.toHaveBeenCalled()
    clock.flush()
    expect(publishedFrame(terminal)!.rows[0]?.text.trimEnd()).toBe('owned rows!')
    expectDisplayed(harness, publishedFrame(terminal)!)

    const snapshot = submittedSnapshot(terminal)
    const summary = publishedFrame(terminal)!
    const mirror = replacement.mirror
    terminal.write('late')
    const cancelled = [...clock.frames.values()]
    expect(cancelled.length).toBeGreaterThan(0)
    const frameCount = harness.snapshots.length
    terminal.dispose()
    for (const callback of cancelled) callback()
    replacement.notifyOutput()
    expect(replacement.update(snapshot, summary.scrollbar)).toEqual({
      announced: false,
      full: false,
      updatedRows: 0,
    })
    expect(harness.snapshots).toHaveLength(frameCount)
    expect(mirror.isConnected).toBe(false)
    expect(harness.host.querySelector('[role="list"]')).toBeNull()
    expect(elements.textarea.getAttribute('aria-label')).toBe('Existing input')
    expect(elements.textarea.getAttribute('aria-controls')).toBe('existing-screen')
    expect(elements.textarea.getAttribute('aria-describedby')).toBe('existing-description')
    expect(harness.errors).toEqual([])
  })
})

const packagedFamily = 'SubmittedAccessibilityTest'
const packagedFontUrl = testFontUrl
const packagedAssets = {
  wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
  bridge: new URL('../../../bridge.wasm', import.meta.url).href,
}

async function packagedFixture(mode: 'main' | 'webgl' | 'webgpu') {
  const host = document.createElement('div')
  host.style.cssText = 'width:400px;height:120px;position:relative'
  document.body.append(host)
  cleanups.push(() => host.remove())
  const options = {
    accessibility: { label: 'Packaged accessible input' },
    appearance: { cursor: { blink: false }, font: { family: packagedFamily, size: 16 } },
    padding: { bottom: 4, left: 5, right: 6, top: 3 },
  }
  let terminal: TerminalApi
  if (mode === 'main') {
    const face = await new FontFace(
      packagedFamily,
      `url(${JSON.stringify(packagedFontUrl)})`,
    ).load()
    document.fonts.add(face)
    cleanups.push(() => {
      document.fonts.delete(face)
    })
    terminal = await MainTerminal.create({
      ...options,
      runtime: { kind: 'owned', options: packagedAssets },
      rendererFactory: (rendererOptions) => WebGlTerminalRenderer.create(rendererOptions),
    })
  } else {
    terminal = await WorkerTerminal.create({
      ...options,
      backend: mode,
      fonts: [{ family: packagedFamily, source: { url: packagedFontUrl } }],
    })
  }
  cleanups.push(() => terminal.dispose())
  const background = terminal.appearance.rendererTheme.background
  host.style.backgroundColor = `rgb(${background.r} ${background.g} ${background.b})`
  const errors: unknown[] = []
  terminal.on('error', (error) => errors.push(error))
  observeText(terminal)
  await terminal.open(host)
  await expect.poll(() => publishedFrame(terminal), { timeout: 5_000 }).toBeDefined()
  expectDisplayed({ terminal }, publishedFrame(terminal)!)
  return { terminal, host, errors }
}

describe.each(['main', 'webgl', 'webgpu'] as const)(
  '%s packaged submitted accessibility',
  (mode) => {
    it('pairs accessible rows, scroll positions and the caret with submitted font and grid changes', async () => {
      const harness = await packagedFixture(mode)
      const { terminal } = harness
      const rowCount = publishedFrame(terminal)!.grid.rows + 3
      const lines = Array.from({ length: rowCount }, (_, row) => `line ${row + 1}`)
      const output = terminal.write(lines.join('\r\n'))
      expect(output instanceof Promise).toBe(mode !== 'main')
      await output
      await expect
        .poll(() => publishedFrame(terminal)?.scrollbar.offset, { timeout: 5_000 })
        .toBeGreaterThan(0)
      const bottom = publishedFrame(terminal)!
      expectDisplayed(harness, bottom)
      const live = controller(terminal).liveRegion
      const announcements = live.textContent
      const top = terminal.scrollToTop()
      expect(top instanceof Promise).toBe(mode !== 'main')
      await top
      await expect
        .poll(() => publishedFrame(terminal)?.scrollbar.offset, { timeout: 5_000 })
        .toBe(0)
      expect(publishedFrame(terminal)!.rows[0]?.text.trimEnd()).toBe('line 1')
      expectDisplayed(harness, publishedFrame(terminal)!)
      expect(live.textContent).toBe(announcements)
      const history = terminal.readLines(0, 1)
      expect(history instanceof Promise).toBe(mode !== 'main')
      expect((await history)[0]?.text.trimEnd()).toBe('line 1')
      await terminal.scrollToBottom()
      await expect
        .poll(() => publishedFrame(terminal)?.scrollbar.offset, { timeout: 5_000 })
        .toBe(bottom.scrollbar.offset)
      const previousLayout = publishedFrame(terminal)!
      await terminal.setFont({ size: 20 })
      await expect
        .poll(() => publishedFrame(terminal)?.font.settings.size, { timeout: 5_000 })
        .toBe(20)
      const nextLayout = publishedFrame(terminal)!
      expect(nextLayout.layout).toBeGreaterThan(previousLayout.layout)
      expect(nextLayout.grid.rows).toBeLessThan(previousLayout.grid.rows)
      expect(nextLayout.padding).toEqual({ bottom: 4, left: 5, right: 6, top: 3 })
      expect(previousLayout.font.settings.size).toBe(16)
      expectDisplayed(harness, nextLayout)
      expect(live.textContent).toBe(announcements)
      await terminal.write('\r\nAB界Z\x1b[4G')
      await expect
        .poll(() => publishedFrame(terminal)?.cursor.viewport, { timeout: 5_000 })
        .toMatchObject({ x: 3, wideTail: true })
      expectDisplayed(harness, publishedFrame(terminal)!)
      await terminal.write('\x1b[?25l')
      await expect
        .poll(() => publishedFrame(terminal)?.cursor.visible, { timeout: 5_000 })
        .toBe(false)
      expectDisplayed(harness, publishedFrame(terminal)!)
      await terminal.write('\x1b[?25h')
      await expect
        .poll(() => publishedFrame(terminal)?.cursor.visible, { timeout: 5_000 })
        .toBe(true)
      expectDisplayed(harness, publishedFrame(terminal)!)
      expect(harness.errors).toEqual([])
      await page.screenshot({
        element: terminal.element!,
        path: `../../../.artifacts/submitted-accessibility-packaged-${mode}.png`,
        scale: 'css',
      })
    }, 20_000)

    it('hydrates synchronous controls without native queries and announces output after observer toggle reentry', async () => {
      const harness = await packagedFixture(mode)
      const { terminal } = harness
      await terminal.write('owned rows')
      await expect
        .poll(() => terminal.visibleLines()[0]?.trimEnd(), { timeout: 5_000 })
        .toBe('owned rows')
      const old = controller(terminal)
      const snapshot = submittedSnapshot(terminal)
      const summary = publishedFrame(terminal)!
      const execution = Reflect.get(terminal, 'execution') as {
        request: (...args: unknown[]) => Promise<unknown>
      }
      const requests = mode === 'main' ? undefined : vi.spyOn(execution, 'request')
      if (requests) cleanups.push(() => requests.mockRestore())
      const originalAttributes = terminal.textarea!.outerHTML
      expect(terminal.setAccessibilityEnabled(false)).toBe(true)
      expect(terminal.setAccessibilityEnabled(false)).toBe(false)
      expect(old.mirror.isConnected).toBe(false)
      expect(terminal.textarea!.hasAttribute('aria-activedescendant')).toBe(false)
      expect(terminal.setAccessibilityEnabled(true)).toBe(true)
      expect(terminal.setAccessibilityEnabled(true)).toBe(false)
      expectDisplayed(harness, summary)
      expect(terminal.textarea!.getAttribute('aria-label')).toBe('Packaged accessible input')
      expect(terminal.visibleLines()).toEqual(summary.rows.map((row) => row.text))
      expect(requests?.mock.calls ?? []).toHaveLength(0)
      const replacement = controller(terminal)
      expect(replacement).not.toBe(old)
      expect(replacement.liveRegion.textContent).toBe('')
      const replacementAttributes = terminal.textarea!.outerHTML
      expect(replacementAttributes).not.toBe(originalAttributes)
      old.notifyOutput()
      expect(old.update(snapshot, summary.scrollbar)).toEqual({
        announced: false,
        full: false,
        updatedRows: 0,
      })
      expect(terminal.textarea!.outerHTML).toBe(replacementAttributes)
      let toggled = false
      terminal.on('title', (title) => {
        if (title !== 'toggle accessibility') return
        const count = requests?.mock.calls.length
        expect(terminal.setAccessibilityEnabled(false)).toBe(true)
        expect(terminal.setAccessibilityEnabled(true)).toBe(true)
        expectDisplayed(harness, publishedFrame(terminal)!)
        expect(requests?.mock.calls.length).toBe(count)
        toggled = true
      })
      const output = terminal.write('!\x1b]0;toggle accessibility\x07')
      expect(output instanceof Promise).toBe(mode !== 'main')
      await output
      expect(toggled).toBe(true)
      await expect
        .poll(() => terminal.visibleLines()[0]?.trimEnd(), { timeout: 5_000 })
        .toBe('owned rows!')
      expectDisplayed(harness, publishedFrame(terminal)!)
      expect(controller(terminal).liveRegion.textContent).toBe('!')
      expect(harness.errors).toEqual([])
    }, 20_000)

    it('rejects late accessibility work after disposal reentry from a real submitted frame observer', async () => {
      const harness = await packagedFixture(mode)
      const { terminal, host } = harness
      const old = controller(terminal)
      const snapshot = submittedSnapshot(terminal)
      const summary = publishedFrame(terminal)!
      const textarea = terminal.textarea!
      let armed = false
      let disposal: ReturnType<TerminalApi['dispose']> | undefined
      terminal.on('title', (title) => {
        armed = title === 'dispose accessible frame'
      })
      terminal.onFrame(() => {
        if (!armed) return
        armed = false
        disposal = terminal.dispose()
      })
      const output = Promise.resolve(
        terminal.write('late\x1b]0;dispose accessible frame\x07'),
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      )
      await expect.poll(() => terminal.lifecycle, { timeout: 5_000 }).toBe('disposed')
      await disposal
      const failure = await output
      if (failure !== undefined) expect(failure).toMatchObject({ code: 'disposed' })
      expect(terminal.element).toBeUndefined()
      expect(host.children).toHaveLength(0)
      expect(old.mirror.isConnected).toBe(false)
      const attributes = textarea.outerHTML
      old.notifyOutput()
      expect(old.update(snapshot, summary.scrollbar)).toEqual({
        announced: false,
        full: false,
        updatedRows: 0,
      })
      expect(textarea.outerHTML).toBe(attributes)
      expect(textarea.hasAttribute('aria-activedescendant')).toBe(false)
      expect(() => terminal.setAccessibilityEnabled(true)).toThrow('disposed')
      expect(harness.errors).toEqual([])
    }, 20_000)
  },
)
