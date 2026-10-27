import { describe, expect, it } from 'vitest'
import { TerminalWriteQueue } from '../write-queue.js'

class FakeClock {
  time = 0
  private nextHandle = 1
  private readonly timers = new Map<number, () => void>()

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void): number {
    const handle = this.nextHandle++
    this.timers.set(handle, callback)
    return handle
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle)
  }

  get pending(): number {
    return this.timers.size
  }

  flush(): void {
    const timers = Array.from(this.timers.values())
    this.timers.clear()
    for (const callback of timers) callback()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('TerminalWriteQueue', () => {
  it('accounts UTF-8 bytes, yields between budgeted batches and flushes in FIFO order', async () => {
    const clock = new FakeClock()
    const writes: string[] = []
    const decoder = new TextDecoder()
    const queue = new TerminalWriteQueue<string>(
      (data) => {
        const text = decoder.decode(data)
        writes.push(text)
        clock.time += 7
        return text
      },
      { timeBudgetMs: 12 },
      clock,
    )

    const first = queue.write('é')
    const second = queue.write('abc')
    const third = queue.write('tail')
    expect(queue.pendingBytes).toBe(9)
    expect(writes).toEqual([])
    expect(clock.pending).toBe(1)

    clock.flush()
    expect(writes).toEqual(['é', 'abc'])
    expect(queue.pendingBytes).toBe(4)
    expect(await first).toBe('é')
    expect(await second).toBe('abc')
    expect(clock.pending).toBe(1)

    queue.flush()
    expect(writes).toEqual(['é', 'abc', 'tail'])
    expect(queue.pendingBytes).toBe(0)
    expect(await third).toBe('tail')
    expect(clock.pending).toBe(0)
  })

  it('uses the input fast path once and schedules ordinary output', async () => {
    const clock = new FakeClock()
    const writes: number[] = []
    const queue = new TerminalWriteQueue<void>(
      () => {
        writes.push(1)
      },
      {},
      clock,
    )

    queue.noteInput()
    const echoed = queue.write('echo')
    expect(writes).toEqual([1])
    expect(clock.pending).toBe(0)
    await echoed

    const ordinary = queue.write('output')
    expect(writes).toEqual([1])
    expect(clock.pending).toBe(1)
    clock.flush()
    expect(writes).toEqual([1, 1])
    await ordinary
  })

  it('cancels a queued write without cancelling its neighbors', async () => {
    const clock = new FakeClock()
    const writes: string[] = []
    const queue = new TerminalWriteQueue<void>(
      (data) => {
        writes.push(new TextDecoder().decode(data))
      },
      {},
      clock,
    )
    const controller = new AbortController()
    const first = queue.write('first')
    const cancelled = queue.write('cancelled', { signal: controller.signal })
    const last = queue.write('last')
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })

    controller.abort()
    expect(queue.pendingBytes).toBe(9)
    clock.flush()
    await rejection
    await first
    await last
    expect(writes).toEqual(['first', 'last'])
    expect(queue.pendingBytes).toBe(0)
  })

  it('keeps worker-inflight bytes charged until parse acknowledgement', async () => {
    const clock = new FakeClock()
    const pending = deferred<void>()
    const queue = new TerminalWriteQueue<void>(
      (data) => {
        structuredClone(data.buffer, { transfer: [data.buffer] })
        return pending.promise
      },
      {},
      clock,
    )
    const source = new Uint8Array([1, 2, 3])
    const result = queue.write(source)
    source.fill(9)
    queue.noteInput()
    const fast = queue.write(new Uint8Array([4, 5]))

    expect(queue.pendingBytes).toBe(5)
    clock.flush()
    expect(queue.pendingBytes).toBe(5)
    queue.flush()
    expect(queue.pendingBytes).toBe(5)
    pending.resolve()
    await result
    await fast
    expect(queue.pendingBytes).toBe(0)
  })

  it('rejects overflow without charging the incoming write', async () => {
    const queue = new TerminalWriteQueue<void>(() => {}, { maxBytes: 4 }, new FakeClock())
    const first = queue.write('é')
    await expect(queue.write('abc')).rejects.toMatchObject({ operation: 'writeQueue.write' })
    expect(queue.pendingBytes).toBe(2)
    queue.flush()
    await first
    expect(queue.pendingBytes).toBe(0)
  })

  it('drains older queued writes before a reentrant synchronous write', async () => {
    const clock = new FakeClock()
    const writes: string[] = []
    const queue = new TerminalWriteQueue<void>(
      (data) => {
        const text = new TextDecoder().decode(data)
        writes.push(text)
        if (text !== 'A') return
        queue.flush()
        writes.push('C')
      },
      {},
      clock,
    )

    const first = queue.write('A')
    const second = queue.write('B')
    queue.flush()
    await first
    await second
    expect(writes).toEqual(['A', 'B', 'C'])
  })

  it('rejects queued and active writes on disposal and ignores late acknowledgements', async () => {
    const clock = new FakeClock()
    const pending = deferred<void>()
    const queue = new TerminalWriteQueue<void>(() => pending.promise, {}, clock)
    queue.noteInput()
    const active = queue.write('active')
    const queued = queue.write('queued')
    const activeRejection = active.catch((cause: unknown) => cause)
    const queuedRejection = queued.catch((cause: unknown) => cause)

    queue.dispose()
    expect(queue.pendingBytes).toBe(0)
    expect(clock.pending).toBe(0)
    pending.resolve()
    expect(await activeRejection).toMatchObject({ operation: 'writeQueue.dispose' })
    expect(await queuedRejection).toMatchObject({ operation: 'writeQueue.dispose' })
    await expect(queue.write('late')).rejects.toMatchObject({ operation: 'writeQueue.dispose' })
  })
})
