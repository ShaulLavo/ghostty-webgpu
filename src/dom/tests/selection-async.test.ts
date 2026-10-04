import { afterEach, describe, expect, it } from 'vitest'
import { TerminalSession } from '../../term/session.js'
import { NativeSelectionHistory } from '../../term/selection-history.js'
import {
  createTerminalSelectionController,
  type TerminalSelectionClock,
  type TerminalSelectionProjection,
} from '../selection.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function clock() {
  const timers = new Map<number, () => void>()
  let handle = 0
  return {
    timers,
    clearInterval: (id: number) => {
      timers.delete(id)
    },
    nowNanoseconds: () => 1_000_000_000n,
    setInterval: (callback: () => void) => {
      timers.set(++handle, callback)
      return handle
    },
  } satisfies TerminalSelectionClock & { timers: Map<number, () => void> }
}

const projection: TerminalSelectionProjection = {
  geometry: { cellWidth: 10, columns: 8, paddingLeft: 0, screenHeight: 60 },
  position: { x: 10, y: 20 },
  viewport: { x: 1, y: 1 },
}
const outside: TerminalSelectionProjection = {
  ...projection,
  position: { x: 30, y: 80 },
  viewport: { x: 3, y: 2 },
}

describe('native selection delayed acknowledgements', () => {
  it.each(['main', 'delayed'] as const)(
    'resets the native gesture after a stale %s release',
    async (actor) => {
      const session = await TerminalSession.create({
        appearance: { grid: { columns: 8, rows: 3 } },
      })
      cleanups.push(() => session.dispose())
      session.write('hello')
      const native = new NativeSelectionHistory(session, () => ({ generation: 1, layout: 1 }))
      const identity = { generation: 1, layout: 1, revision: session.revision }
      let resets = 0
      const controller = createTerminalSelectionController({
        clock: clock(),
        getIdentity: () => identity,
        session: {
          resetSelectionGesture: () => {
            resets++
            native.resetSelectionGesture()
          },
          selectionAutoscrollTick: (input, expected) =>
            native.selectionAutoscrollTick(input, expected),
          selectionDrag: (input, expected) => native.selectionDrag(input, expected),
          selectionPress: (input, expected) => native.selectionPress(input, expected),
          selectionRelease: (input, expected) =>
            actor === 'main'
              ? native.selectionRelease(input, expected)
              : Promise.resolve().then(() => native.selectionRelease(input, expected)),
        },
      })
      cleanups.push(() => controller.dispose())
      await controller.press(projection)
      session.write('changed')
      await expect(async () => controller.release(projection)).rejects.toThrow('identity changed')
      expect(controller.active).toBe(false)
      expect(resets).toBe(1)
    },
  )

  it.each(['cancel', 'dispose'] as const)(
    'resets the native gesture when %s interrupts a pending release',
    async (interrupt) => {
      const session = await TerminalSession.create({
        appearance: { grid: { columns: 8, rows: 3 } },
      })
      cleanups.push(() => session.dispose())
      session.write('hello')
      const native = new NativeSelectionHistory(session, () => ({ generation: 1, layout: 1 }))
      const identity = { generation: 1, layout: 1, revision: session.revision }
      const gate = deferred<void>()
      let resets = 0
      const controller = createTerminalSelectionController({
        clock: clock(),
        getIdentity: () => identity,
        session: {
          resetSelectionGesture: () => {
            resets++
            native.resetSelectionGesture()
          },
          selectionAutoscrollTick: (input, expected) =>
            native.selectionAutoscrollTick(input, expected),
          selectionDrag: (input, expected) => native.selectionDrag(input, expected),
          selectionPress: (input, expected) => native.selectionPress(input, expected),
          selectionRelease: (input, expected) =>
            gate.promise.then(() => native.selectionRelease(input, expected)),
        },
      })
      cleanups.push(() => controller.dispose())
      await controller.press(projection)
      session.write('changed')
      const pending = controller.release(projection)
      const rejection = expect(pending).rejects.toThrow('identity changed')
      expect(controller.active).toBe(false)
      controller[interrupt]()
      const resetsAtInterruption = resets
      controller[interrupt]()
      gate.resolve()
      await rejection
      const afterCancelDrag = native.selectionDrag({ ...outside, rectangle: false })
      expect(resetsAtInterruption).toBe(1)
      expect(resets).toBe(1)
      expect(afterCancelDrag.selectionInstalled).toBe(false)
      expect(controller.active).toBe(false)
    },
  )

  it.each(['release', 'cancel'] as const)(
    'keeps a newer native gesture after %s when an older release rejects',
    async (previous) => {
      const session = await TerminalSession.create({
        appearance: { grid: { columns: 8, rows: 3 } },
      })
      cleanups.push(() => session.dispose())
      session.write('hello')
      const native = new NativeSelectionHistory(session, () => ({ generation: 1, layout: 1 }))
      const gate = deferred<void>()
      let resets = 0
      const controller = createTerminalSelectionController({
        clock: clock(),
        getIdentity: () => ({ generation: 1, layout: 1, revision: session.revision }),
        session: {
          resetSelectionGesture: () => {
            resets++
            native.resetSelectionGesture()
          },
          selectionAutoscrollTick: (input, expected) =>
            native.selectionAutoscrollTick(input, expected),
          selectionDrag: (input, expected) => native.selectionDrag(input, expected),
          selectionPress: (input, expected) => native.selectionPress(input, expected),
          selectionRelease: (input, expected) =>
            gate.promise.then(() => native.selectionRelease(input, expected)),
        },
      })
      cleanups.push(() => controller.dispose())
      await controller.press(projection)
      const pending = controller.release(projection)
      const rejection = expect(pending).rejects.toThrow('identity changed')
      if (previous === 'cancel') controller.cancel()
      session.write('changed')
      await controller.press(projection)
      gate.resolve()
      await rejection
      expect(controller.active).toBe(true)
      expect(resets).toBe(previous === 'cancel' ? 1 : 0)
      const update = await controller.drag(outside, { captured: true, rectangle: false })
      expect(update?.selectionInstalled).toBe(true)
    },
  )

  it('leaves a settled asynchronous release alone during cancellation', async () => {
    const session = await TerminalSession.create({ appearance: { grid: { columns: 8, rows: 3 } } })
    cleanups.push(() => session.dispose())
    session.write('hello')
    const gate = deferred<void>()
    let resets = 0
    const controller = createTerminalSelectionController({
      clock: clock(),
      session: {
        resetSelectionGesture: () => {
          resets++
          session.resetSelectionGesture()
        },
        selectionAutoscrollTick: (input) => session.selectionAutoscrollTick(input),
        selectionDrag: (input) => session.selectionDrag(input),
        selectionPress: (input) => session.selectionPress(input),
        selectionRelease: (input) => gate.promise.then(() => session.selectionRelease(input)),
      },
    })
    cleanups.push(() => controller.dispose())
    await controller.press(projection)
    const pending = controller.release(projection)
    gate.resolve()
    await pending
    controller.cancel()
    controller.dispose()
    expect(resets).toBe(0)
    expect(controller.active).toBe(false)
  })

  it('waits for drag acknowledgement and ignores it after synchronous release', async () => {
    const session = await TerminalSession.create({ appearance: { grid: { columns: 8, rows: 3 } } })
    cleanups.push(() => session.dispose())
    session.write('one\r\ntwo\r\nthree\r\nfour')
    const time = clock()
    const gate = deferred<void>()
    const controller = createTerminalSelectionController({
      clock: time,
      session: {
        resetSelectionGesture: () => session.resetSelectionGesture(),
        selectionAutoscrollTick: (input) => session.selectionAutoscrollTick(input),
        selectionDrag: (input) => {
          const result = session.selectionDrag(input)
          return gate.promise.then(() => result)
        },
        selectionPress: (input) => session.selectionPress(input),
        selectionRelease: (input) => session.selectionRelease(input),
      },
    })
    cleanups.push(() => controller.dispose())
    await controller.press(projection)
    const pending = controller.drag(outside, { captured: true, rectangle: false })
    expect(controller.active).toBe(true)
    expect(controller.hasPendingAutoscroll).toBe(false)
    await controller.release(outside)
    gate.resolve()
    await pending
    expect(controller.active).toBe(false)
    expect(controller.hasPendingAutoscroll).toBe(false)
    expect(time.timers.size).toBe(0)
  })
  it('ignores an older drag acknowledgement after the latest drag returns inside', async () => {
    const session = await TerminalSession.create({ appearance: { grid: { columns: 8, rows: 3 } } })
    cleanups.push(() => session.dispose())
    session.write('one\r\ntwo\r\nthree\r\nfour')
    const time = clock()
    const gate = deferred<void>()
    let first = true
    const controller = createTerminalSelectionController({
      clock: time,
      session: {
        resetSelectionGesture: () => session.resetSelectionGesture(),
        selectionAutoscrollTick: (input) => session.selectionAutoscrollTick(input),
        selectionDrag: (input) => {
          const result = session.selectionDrag(input)
          if (!first) return result
          first = false
          return gate.promise.then(() => result)
        },
        selectionPress: (input) => session.selectionPress(input),
        selectionRelease: (input) => session.selectionRelease(input),
      },
    })
    cleanups.push(() => controller.dispose())
    await controller.press(projection)
    const old = controller.drag(outside, { captured: true, rectangle: false })
    await controller.drag(projection, { captured: true, rectangle: false })
    gate.resolve()
    await old
    expect(controller.active).toBe(true)
    expect(controller.hasPendingAutoscroll).toBe(false)
  })

  it('allows one outstanding native autoscroll intent and stops after disposal', async () => {
    const session = await TerminalSession.create({ appearance: { grid: { columns: 8, rows: 3 } } })
    cleanups.push(() => session.dispose())
    session.write('one\r\ntwo\r\nthree\r\nfour')
    const time = clock()
    const gate = deferred<void>()
    let ticks = 0
    const controller = createTerminalSelectionController({
      clock: time,
      session: {
        resetSelectionGesture: () => session.resetSelectionGesture(),
        selectionAutoscrollTick: (input) => {
          ticks++
          const result = session.selectionAutoscrollTick(input)
          return gate.promise.then(() => result)
        },
        selectionDrag: (input) => session.selectionDrag(input),
        selectionPress: (input) => session.selectionPress(input),
        selectionRelease: (input) => session.selectionRelease(input),
      },
    })
    await controller.press(projection)
    await controller.drag(outside, { captured: true, rectangle: false })
    const tick = time.timers.values().next().value
    expect(tick).toBeDefined()
    tick?.()
    tick?.()
    expect(ticks).toBe(1)
    controller.dispose()
    gate.resolve()
    await gate.promise
    await Promise.resolve()
    expect(controller.active).toBe(false)
    expect(time.timers.size).toBe(0)
  })
})
