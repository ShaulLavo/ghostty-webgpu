import { describe, expect, it } from 'vitest'
import { AddonManager, type TerminalAddon } from '../addons.js'

interface TestTerminal {
  readonly name: string
}

describe('AddonManager', () => {
  it('activates synchronously and binds the terminal', () => {
    const terminal = { name: 'target' }
    const manager = new AddonManager(terminal)
    const activated: TestTerminal[] = []
    const addon: TerminalAddon<TestTerminal> = {
      activate(value) {
        activated.push(value)
      },
      dispose() {},
    }

    manager.load(addon)
    expect(activated).toEqual([terminal])
    expect(manager.loadedCount).toBe(1)
  })

  it('wraps self-disposal idempotently and removes the addon', () => {
    const manager = new AddonManager({ name: 'target' })
    let disposeCount = 0
    const addon: TerminalAddon<TestTerminal> = {
      activate() {},
      dispose() {
        disposeCount += 1
      },
    }
    const originalDispose = addon.dispose

    manager.load(addon)
    expect(addon.dispose).not.toBe(originalDispose)
    addon.dispose()
    addon.dispose()
    expect(disposeCount).toBe(1)
    expect(manager.loadedCount).toBe(0)
    manager.dispose()
    expect(disposeCount).toBe(1)
  })

  it('removes an addon that disposes itself during activation', () => {
    const manager = new AddonManager({ name: 'target' })
    let disposeCount = 0
    const addon: TerminalAddon<TestTerminal> = {
      activate() {
        addon.dispose()
      },
      dispose() {
        disposeCount += 1
      },
    }

    manager.load(addon)
    expect(disposeCount).toBe(1)
    expect(manager.loadedCount).toBe(0)
    manager.dispose()
    expect(disposeCount).toBe(1)
  })

  it('keeps failed activations registered and wrapped for terminal disposal', () => {
    const manager = new AddonManager({ name: 'target' })
    const activationFailure = new Error('activate failed')
    let disposeCount = 0
    const addon: TerminalAddon<TestTerminal> = {
      activate() {
        throw activationFailure
      },
      dispose() {
        disposeCount += 1
      },
    }
    const originalDispose = addon.dispose

    expect(() => manager.load(addon)).toThrow(activationFailure)
    expect(addon.dispose).not.toBe(originalDispose)
    expect(manager.loadedCount).toBe(1)
    expect(disposeCount).toBe(0)

    manager.dispose()
    expect(disposeCount).toBe(1)
    expect(manager.loadedCount).toBe(0)
  })

  it('disposes in reverse load order and continues after failures', () => {
    const order: string[] = []
    const reports: { cause: unknown; operation: string }[] = []
    const manager = new AddonManager({ name: 'target' }, (cause, operation) =>
      reports.push({ cause, operation }),
    )
    const failure = new Error('middle dispose failed')
    const addon = (name: string, cause?: unknown): TerminalAddon<TestTerminal> => ({
      activate() {},
      dispose() {
        order.push(name)
        if (cause) throw cause
      },
    })
    manager.load(addon('first'))
    manager.load(addon('second', failure))
    manager.load(addon('third'))

    manager.dispose()
    manager.dispose()
    expect(order).toEqual(['third', 'second', 'first'])
    expect(reports).toEqual([{ cause: failure, operation: 'dispose' }])
    expect(manager.loadedCount).toBe(0)
  })

  it('continues reverse disposal when the error sink fails', () => {
    const order: string[] = []
    const manager = new AddonManager({ name: 'target' }, () => {
      throw new Error('sink failed')
    })
    manager.load({
      activate() {},
      dispose() {
        order.push('first')
      },
    })
    manager.load({
      activate() {},
      dispose() {
        order.push('second')
        throw new Error('dispose failed')
      },
    })

    expect(() => manager.dispose()).not.toThrow()
    expect(order).toEqual(['second', 'first'])
  })

  it('supports loading the same addon more than once', () => {
    const manager = new AddonManager({ name: 'target' })
    let activationCount = 0
    let disposeCount = 0
    const addon: TerminalAddon<TestTerminal> = {
      activate() {
        activationCount += 1
      },
      dispose() {
        disposeCount += 1
      },
    }

    manager.load(addon)
    manager.load(addon)
    expect(activationCount).toBe(2)
    expect(manager.loadedCount).toBe(2)
    addon.dispose()
    expect(disposeCount).toBe(1)
    expect(manager.loadedCount).toBe(0)
  })

  it('rejects loads after disposal', () => {
    const manager = new AddonManager({ name: 'target' })
    manager.dispose()
    expect(() =>
      manager.load({
        activate() {},
        dispose() {},
      }),
    ).toThrow('disposed')
  })
})
