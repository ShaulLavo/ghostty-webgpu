import { describe, expect, it } from 'vitest'
import { EventEmitter } from '../events.js'
import type { IDisposable } from '../types.js'

describe('EventEmitter', () => {
  it('skips a listener disposed earlier in the same emission', () => {
    const emitter = new EventEmitter<string>()
    const calls: string[] = []
    let second: IDisposable

    emitter.event((value) => {
      calls.push(`first:${value}`)
      second.dispose()
    })
    second = emitter.event((value) => calls.push(`second:${value}`))

    emitter.emit('event')

    expect(calls).toEqual(['first:event'])
  })

  it('finishes the outer listener snapshot before a recursive emission', () => {
    const emitter = new EventEmitter<string>()
    const calls: string[] = []

    emitter.event((value) => {
      calls.push(`first:${value}`)
      if (value === 'outer') emitter.emit('inner')
    })
    emitter.event((value) => calls.push(`second:${value}`))

    emitter.emit('outer')

    expect(calls).toEqual(['first:outer', 'second:outer', 'first:inner', 'second:inner'])
  })

  it('ignores listener return values without inspecting thenables', () => {
    const errors: unknown[] = []
    const emitter = new EventEmitter<void>((cause) => errors.push(cause))
    let thenCalls = 0
    emitter.event(() => ({
      then() {
        thenCalls += 1
      },
    }))

    emitter.emit(undefined)

    expect(thenCalls).toBe(0)
    expect(errors).toEqual([])
  })

  it('reports synchronous listener failures through the configured sink', () => {
    const failure = new Error('listener failed')
    const errors: unknown[] = []
    const emitter = new EventEmitter<void>((cause) => errors.push(cause))
    emitter.event(() => {
      throw failure
    })

    emitter.emit(undefined)

    expect(errors).toEqual([failure])
  })

  it('still forwards cancellation errors to an explicitly configured sink', () => {
    const failure = new Error('Canceled')
    failure.name = 'Canceled'
    const errors: unknown[] = []
    const emitter = new EventEmitter<void>((cause) => errors.push(cause))
    emitter.event(() => {
      throw failure
    })

    emitter.emit(undefined)

    expect(errors).toEqual([failure])
  })
})
