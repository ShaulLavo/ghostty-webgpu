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
})
