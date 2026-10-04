import { afterEach, expect, it } from 'vitest'
import { TerminalSession } from '../../term/session.js'
import { NativeSelectionHistory } from '../../term/selection-history.js'
import { createTerminalScrollbar } from '../scrollbar.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

it('keeps scroll event ownership synchronous and observes a delayed transport failure', async () => {
  const session = await TerminalSession.create<Event>({
    appearance: { grid: { columns: 8, rows: 3 } },
  })
  cleanups.push(() => session.dispose())
  session.write('one\r\ntwo\r\nthree\r\nfour')
  const native = new NativeSelectionHistory(session, () => ({ generation: 1, layout: 1 }))
  const root = document.createElement('div')
  document.body.append(root)
  cleanups.push(() => root.remove())
  const failure = new TypeError('Scroll transport stopped')
  const errors: Array<{ cause: unknown; operation: string }> = []
  const controller = createTerminalScrollbar({
    root,
    snapshot: session.scrollbar,
    actions: {
      scrollBy: async (delta) => {
        native.scrollBy(delta)
        throw failure
      },
      scrollToBottom: () => native.scrollToBottom(),
      scrollToRow: (row) => native.scrollToRow(row),
      scrollToTop: () => native.scrollToTop(),
    },
    onError: (cause, operation) => errors.push({ cause, operation }),
  })
  cleanups.push(() => controller.dispose())
  const event = new WheelEvent('wheel', { cancelable: true, deltaMode: 1, deltaY: -1 })
  controller.element.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  await Promise.resolve()
  await Promise.resolve()
  expect(errors).toEqual([{ cause: failure, operation: 'wheel' }])
  expect(session.scrollbar.offset).toBe(0)
})
