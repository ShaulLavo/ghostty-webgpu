import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomTerminalRenderer } from '../../render/dom/renderer.js'
import { TerminalSession } from '../../term/session.js'
import { Terminal as WorkerTerminal } from '../../worker/index.js'
import { createTerminalElements, type TerminalElements } from '../elements.js'
import { createGhosttyWebGpuTerminalFromSession } from '../terminal.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function mountedHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.width = '400px'
  host.style.height = '320px'
  document.body.append(host)
  cleanups.push(() => host.remove())
  return host
}

function observeStyles(element: HTMLElement): () => MutationRecord[] {
  const records: MutationRecord[] = []
  const observer = new MutationObserver((changes) => records.push(...changes))
  observer.observe(element, { attributes: true, attributeFilter: ['style'] })
  cleanups.push(() => observer.disconnect())
  return () => records.splice(0).concat(observer.takeRecords())
}

async function compositionProbe(inert = false, active = true) {
  const host = mountedHost()
  host.style.fontSize = '31px'
  const elements = createTerminalElements(host)
  let composition: HTMLDivElement | undefined = inert
    ? document.implementation.createHTMLDocument().createElement('div')
    : elements.compositionView!
  let peer: (() => void) | undefined
  const supplied: TerminalElements = {
    root: elements.root,
    textarea: elements.textarea,
    signal: elements.signal,
    get canvas() {
      return elements.canvas
    },
    get compositionView() {
      return composition
    },
    get padding() {
      return elements.padding
    },
    dispose: () => elements.dispose(),
    setPadding: (padding) => elements.setPadding(padding),
    positionTextarea: (position) => {
      elements.positionTextarea(position)
      if (!composition) return
      composition.style.left = elements.textarea.style.left
      composition.style.top = elements.textarea.style.top
    },
  }
  const session = await TerminalSession.create<Event>({
    appearance: {
      cursor: { blink: false },
      font: { family: 'monospace', size: 15 },
      grid: { columns: 40, rows: 12 },
    },
  })
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    accessibility: false,
    autoFit: false,
    elements: supplied,
    rendererFactory: (options) =>
      DomTerminalRenderer.create({ ...options, onFrame: () => peer?.() }),
  })
  cleanups.push(() => terminal.dispose())
  await terminal.open(host)
  terminal.focus()
  if (active) {
    elements.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    elements.textarea.value = '漢'
    elements.textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '漢',
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    )
    expect(composition!.style.fontSize).toBe('15px')
  }
  const frame = host.querySelector<HTMLDivElement>('.ghostty-webgpu-frame')!
  terminal.write('\x1b[6;1H\x1b[2Kedit 0000')
  await vi.waitFor(() => expect(frame.textContent).toContain('edit 0000'))
  return {
    terminal,
    elements,
    host,
    setPeer: (callback: () => void) => {
      peer = callback
    },
    composition: () => composition!,
    remove: () => {
      composition?.remove()
      composition = undefined
    },
    update: async () => {
      terminal.write('\x1b[6;1H\x1b[2Kedit 0001')
      await vi.waitFor(() => expect(frame.textContent).toContain('edit 0001'))
    },
    replace: () => {
      const next = document.createElement('div')
      next.className = 'ghostty-webgpu-composition'
      next.hidden = true
      composition?.replaceWith(next)
      composition = next
      return next
    },
  }
}

describe('terminal UI declarations', () => {
  it('styles the first visible preedit synchronously and leaves idle appearance untouched', async () => {
    const probe = await compositionProbe(false, false)
    const composition = probe.composition()
    expect(composition.hidden).toBe(true)
    expect(composition.style.fontSize).toBe('')
    probe.elements.textarea.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    )
    expect(composition.hidden).toBe(true)
    probe.elements.textarea.value = '漢'
    probe.elements.textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: '漢',
        inputType: 'insertCompositionText',
        isComposing: true,
      }),
    )
    expect(composition.hidden).toBe(false)
    expect(composition.style.fontSize).toBe('15px')
    expect(composition.style.minHeight).not.toBe('')
    probe.elements.textarea.dispatchEvent(
      new CompositionEvent('compositionend', {
        bubbles: true,
        data: '漢',
      }),
    )
    expect(composition.hidden).toBe(true)
    composition.style.fontSize = '31px'
    await probe.update()
    expect(composition.style.fontSize).toBe('31px')
  })

  it.each([false, true])(
    'styles the first worker preedit with actor metrics (host font loaded: %s)',
    async (hostLoaded) => {
      const family = hostLoaded ? 'PreeditWorkerHost' : 'PreeditWorkerOnly'
      const source = new URL(
        '../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2',
        import.meta.url,
      ).href
      expect(Array.from(document.fonts).some((face) => face.family === family)).toBe(false)
      if (hostLoaded) {
        const face = await new FontFace(family, `url(${JSON.stringify(source)})`).load()
        document.fonts.add(face)
        cleanups.push(() => {
          document.fonts.delete(face)
        })
      }
      let first: { width: string; height: string } | undefined
      const terminal = await WorkerTerminal.create({
        accessibility: {},
        autoFit: false,
        appearance: { font: { family, size: 15 }, cursor: { blink: false } },
        backend: 'webgl',
        fonts: [{ family, source: { url: source } }],
        workerUrl: new URL('../../../dist/worker/entry.js', import.meta.url),
        inputHooks: {
          inputReady: () => {
            const textarea = terminal.textarea!
            textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
            textarea.value = '漢'
            textarea.dispatchEvent(
              new InputEvent('input', {
                bubbles: true,
                data: '漢',
                inputType: 'insertCompositionText',
                isComposing: true,
              }),
            )
            const composition = terminal.element!.querySelector<HTMLElement>(
              '.ghostty-webgpu-composition',
            )!
            expect(composition.hidden).toBe(false)
            expect(composition.style.fontSize).toBe('15px')
            expect(terminal.submittedFrame).toBeUndefined()
            first = { width: composition.style.minWidth, height: composition.style.minHeight }
          },
        },
      })
      cleanups.push(() => terminal.dispose())
      await terminal.open(mountedHost())
      await vi.waitFor(() => expect(terminal.submittedFrame).toBeDefined())
      const font = terminal.submittedFrame!.font
      expect(first).toEqual({ width: `${font.cssCellWidth}px`, height: `${font.cssCellHeight}px` })
      expect(Array.from(document.fonts).some((face) => face.family === family)).toBe(hostLoaded)
    },
  )

  it('restores active preedit after a renderer peer in the same callback', async () => {
    const probe = await compositionProbe()
    let first = true
    probe.setPeer(() => {
      if (!first) return
      first = false
      probe.composition().style.removeProperty('font-size')
    })
    await probe.update()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(probe.composition().hidden).toBe(false)
    expect(probe.composition().style.fontSize).toBe('15px')
    expect(getComputedStyle(probe.composition()).fontSize).toBe('15px')
  })

  it('restores priority-only changes to owned preedit and caret declarations', async () => {
    const probe = await compositionProbe()
    const composition = probe.composition()
    const rules = document.createElement('style')
    rules.textContent = '.priority-font { font-size: 25px !important }'
    document.head.append(rules)
    cleanups.push(() => rules.remove())
    composition.classList.add('priority-font')
    expect(getComputedStyle(composition).fontSize).toBe('25px')
    composition.style.setProperty('font-size', composition.style.fontSize, 'important')
    for (const property of ['left', 'top']) {
      probe.elements.textarea.style.setProperty(
        property,
        probe.elements.textarea.style.getPropertyValue(property),
        'important',
      )
    }
    await probe.update()
    expect(composition.style.getPropertyPriority('font-size')).toBe('')
    expect(getComputedStyle(composition).fontSize).toBe('25px')
    expect(probe.elements.textarea.style.getPropertyPriority('left')).toBe('')
    expect(probe.elements.textarea.style.getPropertyPriority('top')).toBe('')
  })

  it('supports active preedit in a supplied inert-document element', async () => {
    const probe = await compositionProbe(true)
    expect(probe.composition().ownerDocument.defaultView).toBeNull()
    expect(probe.composition().style.fontSize).toBe('15px')
    probe.composition().style.removeProperty('font-size')
    await probe.update()
    expect(probe.composition().style.fontSize).toBe('15px')
  })

  it('releases preedit cache and observer ownership when the optional element disappears', async () => {
    const probe = await compositionProbe()
    probe.remove()
    await probe.update()
    expect(Reflect.get(probe.terminal, 'preeditAppearance')).toBeUndefined()
    expect(Reflect.get(probe.terminal, 'preeditObserver')).toBeUndefined()
  })

  it('restores caret declarations after exposed inline styles change', () => {
    const elements = createTerminalElements(mountedHost())
    cleanups.push(() => elements.dispose())
    elements.positionTextarea({ x: 10, y: 20 })
    elements.textarea.style.removeProperty('left')
    elements.compositionView!.style.top = '0px'
    elements.positionTextarea({ x: 10, y: 20 })
    expect(elements.textarea.style.left).toBe('10px')
    expect(elements.compositionView!.style.top).toBe('20px')
  })

  it('restores preedit appearance after exposed inline styles change', async () => {
    const probe = await compositionProbe()
    expect(probe.composition().style.fontSize).toBe('15px')
    probe.composition().style.removeProperty('font-size')
    await probe.update()
    expect(probe.composition().style.fontSize).toBe('15px')
  })

  it('restores preedit appearance after a peer callback in the same native frame', async () => {
    const probe = await compositionProbe()
    requestAnimationFrame(() => probe.composition().style.removeProperty('font-size'))
    await probe.update()
    expect(probe.composition().style.fontSize).toBe('15px')
  })

  it('applies appearance to a replacement supplied composition element', async () => {
    const probe = await compositionProbe()
    expect(probe.composition().style.fontSize).toBe('15px')
    const next = probe.replace()
    await probe.update()
    expect(next.style.fontSize).toBe('15px')
    expect(next.style.minWidth).not.toBe('')
  })
  it('retains preedit appearance during row edits with unchanged font and theme', async () => {
    const session = await TerminalSession.create<Event>({
      appearance: {
        cursor: { blink: false },
        font: { family: 'monospace', size: 15 },
        grid: { columns: 40, rows: 12 },
      },
    })
    const terminal = createGhosttyWebGpuTerminalFromSession(session, {
      accessibility: {},
      autoFit: false,
      rendererFactory: (options) => DomTerminalRenderer.create(options),
    })
    cleanups.push(() => terminal.dispose())
    const host = mountedHost()
    await terminal.open(host)
    const preedit = host.querySelector<HTMLDivElement>('.ghostty-webgpu-composition')!
    const frame = host.querySelector<HTMLDivElement>('.ghostty-webgpu-frame')!
    terminal.write('\x1b[6;1H\x1b[2Kedit 0000')
    await vi.waitFor(() => expect(frame.textContent).toContain('edit 0000'))
    const before = preedit.getAttribute('style')
    const changes = observeStyles(preedit)
    const declaration = preedit.style
    const styleReads = vi.spyOn(preedit, 'style', 'get')
    expect(preedit.style).toBe(declaration)
    styleReads.mockClear()
    expect(terminal.measure('漢')).toBe(2)
    expect(styleReads).not.toHaveBeenCalled()
    terminal.write('\x1b[6;1H\x1b[2Kedit 0001')
    await vi.waitFor(() => expect(frame.textContent).toContain('edit 0001'))
    expect(preedit.getAttribute('style')).toBe(before)
    expect(changes()).toEqual([])
    // The one read belongs to caret positioning; appearance does no declaration work.
    expect(styleReads).toHaveBeenCalledTimes(1)
  })

  it('keeps owned caret declarations until validated coordinates change', () => {
    const elements = createTerminalElements(mountedHost())
    cleanups.push(() => elements.dispose())
    elements.positionTextarea({ x: 10, y: 20 })
    const inputChanges = observeStyles(elements.textarea)
    const compositionChanges = observeStyles(elements.compositionView!)
    elements.positionTextarea({ x: 10, y: 20 })
    expect(inputChanges()).toEqual([])
    expect(compositionChanges()).toEqual([])
    elements.positionTextarea({ x: 12, y: 24 })
    expect(elements.textarea.style.left).toBe('12px')
    expect(elements.compositionView!.style.top).toBe('24px')
    elements.positionTextarea({ x: -1, y: -2 })
    expect(elements.textarea.style.left).toBe('0px')
    expect(elements.compositionView!.style.top).toBe('0px')
    inputChanges()
    compositionChanges()
    elements.positionTextarea({ x: 0, y: 0 })
    expect(inputChanges()).toEqual([])
    expect(compositionChanges()).toEqual([])
    expect(() => elements.positionTextarea({ x: Number.NaN, y: 0 })).toThrow(RangeError)
    expect(() => elements.positionTextarea({ x: 0, y: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    )
  })
})
