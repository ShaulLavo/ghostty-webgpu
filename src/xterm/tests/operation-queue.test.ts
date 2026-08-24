import { describe, expect, it } from 'vitest'
import { DeferredTargetQueue } from '../operation-queue.js'

interface RecordingTarget {
  readonly values: string[]
}

describe('DeferredTargetQueue', () => {
  it('binds once and drains pre-ready operations in FIFO order', () => {
    const queue = new DeferredTargetQueue<RecordingTarget>()
    const target = { values: [] as string[] }
    queue.enqueue((value) => value.values.push('first'))
    queue.enqueue((value) => value.values.push('second'))

    expect(queue.pendingCount).toBe(2)
    expect(queue.isBound).toBe(false)
    expect(queue.bind(target)).toBe(true)
    expect(target.values).toEqual(['first', 'second'])
    expect(queue.pendingCount).toBe(0)
    expect(queue.isBound).toBe(true)
    expect(() => queue.bind({ values: [] })).toThrow('already bound')
  })

  it('flushes post-bind operations synchronously and preserves reentrant FIFO order', () => {
    const queue = new DeferredTargetQueue<RecordingTarget>()
    const target = { values: [] as string[] }
    queue.enqueue((value) => {
      value.values.push('first')
      queue.enqueue((nested) => nested.values.push('third'))
    })
    queue.enqueue((value) => value.values.push('second'))
    queue.bind(target)

    expect(target.values).toEqual(['first', 'second', 'third'])
    queue.enqueue((value) => value.values.push('fourth'))
    expect(target.values).toEqual(['first', 'second', 'third', 'fourth'])
    expect(() => queue.flush()).not.toThrow()
  })

  it('reports operation failures and continues with later operations', () => {
    const failures: unknown[] = []
    const queue = new DeferredTargetQueue<RecordingTarget>((cause) => failures.push(cause))
    const target = { values: [] as string[] }
    const failed = new Error('write failed')
    let callbackCount = 0
    queue.enqueue(() => {
      throw failed
    })
    queue.enqueue((value) => {
      value.values.push('completed')
      callbackCount += 1
    })

    queue.bind(target)
    expect(failures).toEqual([failed])
    expect(target.values).toEqual(['completed'])
    expect(callbackCount).toBe(1)
  })

  it('continues draining when the error sink itself fails', () => {
    const queue = new DeferredTargetQueue<RecordingTarget>(() => {
      throw new Error('sink failed')
    })
    const target = { values: [] as string[] }
    queue.enqueue(() => {
      throw new Error('operation failed')
    })
    queue.enqueue((value) => value.values.push('later'))

    expect(() => queue.bind(target)).not.toThrow()
    expect(target.values).toEqual(['later'])
  })

  it('reports post-bind failures without blocking later enqueues', () => {
    const failures: unknown[] = []
    const queue = new DeferredTargetQueue<RecordingTarget>((cause) => failures.push(cause))
    const target = { values: [] as string[] }
    const failure = new Error('post-bind failure')
    queue.bind(target)

    queue.enqueue(() => {
      throw failure
    })
    queue.enqueue((value) => value.values.push('later'))

    expect(failures).toEqual([failure])
    expect(target.values).toEqual(['later'])
  })

  it('does not run a completion placed after a failed target operation', () => {
    const failures: unknown[] = []
    const queue = new DeferredTargetQueue<{ write(): void }>((cause) => failures.push(cause))
    const targetError = new Error('target failed')
    let callbackCount = 0
    queue.enqueue((target) => {
      target.write()
      callbackCount += 1
    })

    queue.bind({
      write() {
        throw targetError
      },
    })
    expect(callbackCount).toBe(0)
    expect(failures).toEqual([targetError])
  })

  it('cancels a copied pending set once and immediately cancels later enqueues', () => {
    const cancellations: [string, unknown][] = []
    const reason = new Error('creation failed')
    const queue = new DeferredTargetQueue<RecordingTarget>()
    queue.enqueue(
      () => {},
      (cause) => {
        cancellations.push(['first', cause])
        queue.enqueue(
          () => {},
          (nestedCause) => cancellations.push(['nested', nestedCause]),
        )
      },
    )
    queue.enqueue(
      () => {},
      (cause) => cancellations.push(['second', cause]),
    )

    queue.cancel(reason)
    queue.cancel(new Error('ignored'))
    expect(cancellations).toEqual([
      ['first', reason],
      ['nested', reason],
      ['second', reason],
    ])
    expect(queue.pendingCount).toBe(0)
    expect(queue.isCancelled).toBe(true)
    expect(queue.bind({ values: [] })).toBe(false)
  })

  it('reports cancellation callback failures without skipping later callbacks', () => {
    const failures: unknown[] = []
    const queue = new DeferredTargetQueue<RecordingTarget>((cause) => failures.push(cause))
    const failure = new Error('cancel failed')
    let laterCancellation = false
    queue.enqueue(
      () => {},
      () => {
        throw failure
      },
    )
    queue.enqueue(
      () => {},
      () => {
        laterCancellation = true
      },
    )

    queue.cancel()
    expect(failures).toEqual([failure])
    expect(laterCancellation).toBe(true)
  })

  it('rejects invalid callbacks and flushing before readiness', () => {
    const queue = new DeferredTargetQueue<RecordingTarget>()
    expect(() => queue.flush()).toThrow('not bound')
    expect(() => queue.enqueue(undefined as never)).toThrow('operation must be a function')
    expect(() => queue.enqueue(() => {}, 'invalid' as never)).toThrow(
      'cancellation must be a function',
    )
  })
})
