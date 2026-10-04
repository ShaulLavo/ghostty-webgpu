import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { TerminalSession } from '../../term/session.js'
import { NativeSelectionHistory } from '../../term/selection-history.js'
import type {
  SelectionFixtureCommand,
  SelectionFixtureReply,
} from '../../term/tests/fixtures/selection-worker.js'
import { writeUserSelectionToClipboard } from '../clipboard.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function nativeWorker() {
  const worker = new Worker(
    new URL('../../term/tests/fixtures/selection-worker.ts', import.meta.url),
    { type: 'module' },
  )
  cleanups.push(() => worker.terminate())
  const pending: Array<{
    resolve: (reply: SelectionFixtureReply | undefined) => void
    reject: (cause: unknown) => void
  }> = []
  worker.addEventListener(
    'message',
    (event: MessageEvent<{ result?: SelectionFixtureReply; failure?: string }>) => {
      const request = pending.shift()
      if (event.data.failure) request?.reject(new TypeError(event.data.failure))
      else request?.resolve(event.data.result)
    },
  )
  worker.addEventListener('error', (event) => {
    for (const request of pending.splice(0)) request.reject(event.error)
  })
  return (command: SelectionFixtureCommand) =>
    new Promise<SelectionFixtureReply | undefined>((resolve, reject) => {
      pending.push({ resolve, reject })
      worker.postMessage(command)
    })
}

function button(action: () => void) {
  const element = document.createElement('button')
  element.textContent = 'Copy selection'
  document.body.append(element)
  cleanups.push(() => element.remove())
  element.addEventListener('click', action)
  return element
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('native selection/history leaf in both execution actors', () => {
  it('matches owned atomic selection and history reads across a real worker boundary', async () => {
    const request = nativeWorker()
    const worker = await request('start')
    const session = await TerminalSession.create<Event>({
      appearance: { grid: { columns: 8, rows: 3 } },
    })
    cleanups.push(() => session.dispose())
    const main = new NativeSelectionHistory(session, () => ({ generation: 1, layout: 1 }))
    session.write('one\r\ntwo\r\nthree\r\nfour')
    await main.selectLines(0, 1)
    expect(worker?.selection).toEqual(await main.selectionSnapshot())
    expect(worker?.history).toEqual(await main.historySnapshot(0, await main.lineCount()))
    const scrolled = await request('scroll')
    await main.scrollToTop()
    await main.scrollBy(1)
    await main.scrollToBottom()
    await main.scrollToRow(0)
    expect(scrolled?.topOffset).toBe(0)
    expect(scrolled?.history).toEqual(await main.historySnapshot(0, await main.lineCount()))
    const cleared = await request('clear')
    await main.clearSelection()
    expect(cleared?.selection).toEqual(await main.selectionSnapshot())
    expect(worker?.selection.selection?.text).toBe('one\ntwo')
    expect(worker?.capture).toContain('"version":1')
    const range = await request('range')
    await main.selectRange({ x: 0, y: 0 }, { x: 2, y: 0 })
    expect(range?.selection).toEqual(await main.selectionSnapshot())
    const all = await request('all')
    await main.selectAll()
    expect(all?.selection).toEqual(await main.selectionSnapshot())
    await request('dispose')
  })

  it('writes delayed native worker readback from trusted browser activation', async (context) => {
    if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
      context.skip('This browser has no delayed ClipboardItem write support')
      return
    }
    const probe = deferred<{ error?: unknown }>()
    const probeButton = button(() => {
      void navigator.clipboard.writeText('native clipboard activation probe').then(
        () => probe.resolve({}),
        (error: unknown) => probe.resolve({ error }),
      )
    })
    await userEvent.click(probeButton)
    const probeResult = await probe.promise
    if (probeResult.error instanceof DOMException && probeResult.error.name === 'NotAllowedError') {
      context.skip(
        `This test context denies ordinary activated clipboard writes: ${probeResult.error.message}`,
      )
      return
    }
    if (probeResult.error) throw probeResult.error
    const request = nativeWorker()
    await request('start')
    const completion = deferred<{ error?: unknown }>()
    let active = false
    let settledDuringActivation = true
    const trigger = button(() => {
      active = navigator.userActivation.isActive
      let settled = false
      const text = request('read').then((reply) => {
        settled = true
        return reply?.text
      })
      const write = writeUserSelectionToClipboard(window, text)
      settledDuringActivation = settled
      void write.then(
        () => completion.resolve({}),
        (error: unknown) => completion.resolve({ error }),
      )
    })
    await userEvent.click(trigger)
    const result = await completion.promise
    if (result.error) throw result.error
    expect(active).toBe(true)
    expect(settledDuringActivation).toBe(false)
    trigger.textContent = 'Copied native worker selection'
    let engine = 'webkit'
    if (navigator.userAgent.includes('Firefox/')) engine = 'firefox'
    if (navigator.userAgent.includes('Chrome/')) engine = 'chromium'
    await page.screenshot({ path: `selection-clipboard-${engine}.png` })
  })

  it('starts the browser write before readback and rejects unavailable or disposed reads', async (context) => {
    if (typeof ClipboardItem !== 'function') {
      context.skip('This browser has no ClipboardItem support')
      return
    }
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const items: ClipboardItem[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (values: ClipboardItem[]) => {
          items.push(...values)
          await Promise.all(values.map((value) => value.getType('text/plain')))
        },
      },
    })
    cleanups.push(() => {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
      else Reflect.deleteProperty(navigator, 'clipboard')
    })
    const text = deferred<string>()
    const abort = new AbortController()
    const pending = writeUserSelectionToClipboard(window, text.promise, { signal: abort.signal })
    expect(items).toHaveLength(1)
    const rejection = expect(pending).rejects.toThrow()
    abort.abort(new DOMException('Terminal disposed', 'AbortError'))
    text.resolve('late selection')
    await rejection
    await expect(
      writeUserSelectionToClipboard(window, Promise.resolve(undefined)),
    ).rejects.toThrow()
    const accepted = writeUserSelectionToClipboard(window, Promise.resolve('owned selection'))
    await accepted
    expect(await (await items.at(-1)?.getType('text/plain'))?.text()).toBe('owned selection')
  })

  it('rejects disposal before delayed text settles', async (context) => {
    if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
      context.skip('This browser has no delayed ClipboardItem write support')
      return
    }
    const text = deferred<string>()
    const abort = new AbortController()
    const observed = deferred<unknown>()
    const trigger = button(() => {
      void writeUserSelectionToClipboard(window, text.promise, { signal: abort.signal }).then(
        () => observed.resolve('unexpected success'),
        (cause: unknown) => observed.resolve(cause),
      )
      abort.abort(new DOMException('Terminal disposed', 'AbortError'))
      text.resolve('late selection')
    })
    await userEvent.click(trigger)
    expect(await observed.promise).not.toBe('unexpected success')
  })
})
