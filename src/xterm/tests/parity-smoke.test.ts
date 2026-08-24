import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Terminal as XtermHeadlessTerminal } from '@xterm/headless'
import { GhosttyRuntime } from '../../core/runtime.js'
import { TerminalSession } from '../../term/session.js'
import {
  createSessionBehaviorDriver,
  createXtermBehaviorDriver,
  type SmokeSize,
  type TerminalBehaviorDriver,
} from './smoke-driver.js'

interface XtermHeadlessModule {
  readonly Terminal: typeof XtermHeadlessTerminal
}

const require = createRequire(import.meta.url)
const { Terminal: XtermTerminal } = require('@xterm/headless') as XtermHeadlessModule
const decoder = new TextDecoder()
const drivers: TerminalBehaviorDriver[] = []
let runtime: GhosttyRuntime

beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})

afterEach(() => {
  for (const driver of drivers.splice(0).reverse()) driver.dispose()
})

afterAll(() => {
  runtime.dispose()
})

function trackedXterm(options: ConstructorParameters<typeof XtermHeadlessTerminal>[0] = {}) {
  const driver = createXtermBehaviorDriver(new XtermTerminal(options))
  drivers.push(driver)
  return driver
}

async function trackedSession(size?: SmokeSize): Promise<TerminalBehaviorDriver> {
  const session = await TerminalSession.create({
    ...(size ? { appearance: { grid: size } } : {}),
    runtime: { kind: 'borrowed', runtime },
  })
  const driver = createSessionBehaviorDriver(session)
  drivers.push(driver)
  return driver
}

describe('released xterm differential smoke observables', () => {
  it('records matching default and custom rows and columns', async () => {
    const xtermDefault = trackedXterm()
    const nativeDefault = await trackedSession()
    const xtermCustom = trackedXterm({ cols: 91, rows: 33 })
    const nativeCustom = await trackedSession({ columns: 91, rows: 33 })

    expect(xtermDefault.size()).toEqual({ columns: 80, rows: 24 })
    expect(nativeDefault.size()).toEqual({ columns: 80, rows: 24 })
    expect(xtermCustom.size()).toEqual({ columns: 91, rows: 33 })
    expect(nativeCustom.size()).toEqual({ columns: 91, rows: 33 })
  })

  it('preserves each write completion model and ordering', async () => {
    const xterm = trackedXterm()
    const native = await trackedSession()

    const xtermWrite = await xterm.observeWrite('reference')
    const nativeWrite = await native.observeWrite('target')

    expect(xtermWrite.timeline).toEqual(['returned', 'callback', 'onWriteParsed'])
    expect(xtermWrite.returnValue).toBeUndefined()
    expect(nativeWrite.timeline).toEqual(['renderRequest', 'returned'])
    expect(nativeWrite.returnValue).toEqual({ revision: 1 })
  })

  it('records raw input payloads and honors data subscription disposal', async () => {
    const xterm = trackedXterm()
    const native = await trackedSession()

    const xtermInput = xterm.observeDataSubscription('first', 'ignored')
    const nativeInput = native.observeDataSubscription('first', 'ignored')

    expect(xtermInput.events).toEqual(['first'])
    expect(xtermInput.operationReturns).toEqual([undefined, undefined])
    expect(nativeInput.events).toHaveLength(1)
    expect(nativeInput.events[0]).toMatchObject({ bytes: new TextEncoder().encode('first') })
    expect(nativeInput.operationReturns).toHaveLength(2)
    expect(decoder.decode(nativeInput.operationReturns[0] as Uint8Array)).toBe('first')
    expect(decoder.decode(nativeInput.operationReturns[1] as Uint8Array)).toBe('ignored')
  })

  it('records raw resize payloads and honors resize subscription disposal', async () => {
    const xterm = trackedXterm()
    const native = await trackedSession()
    const first = { columns: 100, rows: 30 }
    const second = { columns: 101, rows: 31 }

    const xtermResize = xterm.observeResizeSubscription(first, second)
    const nativeResize = native.observeResizeSubscription(first, second)

    expect(xtermResize.events).toHaveLength(1)
    expect(xtermResize.events[0]).toMatchObject({ cols: 100, rows: 30 })
    expect(xtermResize.operationReturns).toEqual([undefined, undefined])
    expect(nativeResize.events).toHaveLength(1)
    expect(nativeResize.events[0]).toMatchObject({ grid: { columns: 100, rows: 30 } })
    expect(nativeResize.operationReturns).toEqual([{ revision: 1 }, { revision: 2 }])
    expect(xterm.size()).toEqual(second)
    expect(native.size()).toEqual(second)
  })

  it('allows idempotent disposal on both drivers', async () => {
    const xterm = trackedXterm()
    const native = await trackedSession()

    expect(() => {
      xterm.dispose()
      xterm.dispose()
    }).not.toThrow()
    expect(() => {
      native.dispose()
      native.dispose()
    }).not.toThrow()
  })
})
