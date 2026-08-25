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

  it('retains ownership when a non-writable dispose method rejects wrapping', () => {
    const manager = new AddonManager({ name: 'target' })
    let disposeCount = 0
    const addon: TerminalAddon<TestTerminal> = {
      activate() {},
      dispose() {
        disposeCount += 1
      },
    }
    Object.defineProperty(addon, 'dispose', { writable: false })

    expect(() => manager.load(addon)).toThrow(TypeError)
    expect(manager.loadedCount).toBe(1)

    manager.dispose()
    expect(disposeCount).toBe(1)
    expect(manager.loadedCount).toBe(1)
  })

  it('disposes in reverse load order and stops at the first failure', () => {
    const order: string[] = []
    const manager = new AddonManager({ name: 'target' })
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

    expect(() => manager.dispose()).toThrow(failure)
    expect(order).toEqual(['third', 'second'])
    expect(manager.loadedCount).toBe(2)
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

  it('activates addons loaded after disposal like released xterm', () => {
    const manager = new AddonManager({ name: 'target' })
    let activationCount = 0
    manager.dispose()
    manager.load({
      activate() {
        activationCount += 1
      },
      dispose() {},
    })

    expect(activationCount).toBe(1)
    expect(manager.loadedCount).toBe(1)
  })
})
