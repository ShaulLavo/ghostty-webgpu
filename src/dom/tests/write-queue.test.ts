import { afterEach, describe, expect, it, vi } from 'vitest'
import { GhosttyError } from '../../core/error.js'
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

afterEach(() => vi.restoreAllMocks())

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
    const writes: number[][] = []
    const queue = new TerminalWriteQueue<void>(
      (data) => {
        writes.push(Array.from(data))
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
    expect(writes).toEqual([
      [1, 2, 3],
      [4, 5],
    ])
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

  it('refuses an overflowing array without copying, executing, charging or scheduling it', async () => {
    const clock = new FakeClock()
    const execute = vi.fn(() => {})
    const queue = new TerminalWriteQueue<void>(execute, { maxBytes: 3 }, clock)
    const first = queue.write(new Uint8Array([1, 2, 3]))
    const source = new Uint8Array([4])
    const copy = vi.spyOn(Uint8Array, 'from')
    const error = await queue.write(source).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(GhosttyError)
    expect(error).toMatchObject({
      operation: 'writeQueue.write',
      cause: { incomingBytes: 1, maxBytes: 3, pendingBytes: 3 },
    })
    expect(copy.mock.calls.filter(([input]) => input === source)).toHaveLength(0)
    expect(queue.pendingBytes).toBe(3)
    expect(clock.pending).toBe(1)
    expect(execute).not.toHaveBeenCalled()
    queue.flush()
    await first
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
    expect(queue.pendingBytes).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('refuses an overflowing string without fully encoding, executing, charging or scheduling it', async () => {
    const clock = new FakeClock()
    const execute = vi.fn(() => {})
    const queue = new TerminalWriteQueue<void>(execute, { maxBytes: 2 }, clock)
    const source = 'é界'
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    const error = await queue.write(source).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(GhosttyError)
    expect(error).toMatchObject({
      operation: 'writeQueue.write',
      cause: { incomingBytes: 5, maxBytes: 2, pendingBytes: 0 },
    })
    expect(encode.mock.calls.filter(([input]) => input === source)).toHaveLength(0)
    expect(queue.pendingBytes).toBe(0)
    expect(clock.pending).toBe(0)
    queue.flush()
    clock.flush()
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    'ASCII',
    '\0',
    '\u007f',
    '\u0080',
    '\u07ff',
    '\u0800',
    '\ud7ff',
    '\udbff',
    '\udfff',
    '\ue000',
    '\uffff',
    '\udbff\udfff',
    '\udc00\ud800',
    'é',
    '界',
    '😀',
    '\ud800',
    '\udc00',
    '\ud800x',
    '\ud800\ud800\udc00',
    'aé界😀\udc00',
  ])(
    'matches platform UTF-8 lengths at exact-fit and over-by-one boundaries for %j',
    async (source) => {
      const expected = new TextEncoder().encode(source)
      const encode = vi.spyOn(TextEncoder.prototype, 'encode')
      const clock = new FakeClock()
      const execute = vi.fn((data: Uint8Array) => data)
      const queue = new TerminalWriteQueue(execute, { maxBytes: expected.byteLength + 1 }, clock)
      const first = queue.write(new Uint8Array([0]))
      const accepted = queue.write(source)
      expect(queue.pendingBytes).toBe(expected.byteLength + 1)
      queue.flush()
      await first
      expect(await accepted).toEqual(expected)
      expect(encode.mock.calls.filter(([input]) => input === source)).toHaveLength(1)
      encode.mockClear()

      const charged = queue.write(new Uint8Array([0, 0]))
      const error = await queue.write(source).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(GhosttyError)
      expect(error).toMatchObject({
        operation: 'writeQueue.write',
        cause: {
          incomingBytes: expected.byteLength,
          maxBytes: expected.byteLength + 1,
          pendingBytes: 2,
        },
      })
      expect(encode.mock.calls.filter(([input]) => input === source)).toHaveLength(0)
      expect(queue.pendingBytes).toBe(2)
      expect(clock.pending).toBe(1)
      expect(execute).toHaveBeenCalledTimes(2)
      queue.flush()
      await charged
      expect(queue.pendingBytes).toBe(0)
    },
  )

  it('copies accepted arrays once and executes owned bytes after caller mutation', async () => {
    const source = new Uint8Array([1, 2, 3])
    const copy = vi.spyOn(Uint8Array, 'from')
    const execute = vi.fn((data: Uint8Array) => Array.from(data))
    const queue = new TerminalWriteQueue(execute, {}, new FakeClock())
    const result = queue.write(source)
    source.fill(9)
    expect(copy.mock.calls.filter(([input]) => input === source)).toHaveLength(1)
    queue.flush()
    expect(await result).toEqual([1, 2, 3])
    expect(execute.mock.calls[0]?.[0]).not.toBe(source)
  })

  it('encodes ordinary accepted strings once without exact-count traversal', async () => {
    const source = 'ordinary output é界😀'
    const expected = new TextEncoder().encode(source)
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const queue = new TerminalWriteQueue((data) => data, {}, new FakeClock())
    const result = queue.write(source)
    expect(queue.pendingBytes).toBe(expected.byteLength)
    expect(encode.mock.calls.filter(([input]) => input === source)).toHaveLength(1)
    expect(charCodeAt.mock.contexts.filter((input) => String(input) === source)).toHaveLength(0)
    queue.flush()
    expect(await result).toEqual(expected)
  })

  it('keeps detached inflight charges for exact-fit admission and over-by-one refusal', async () => {
    const clock = new FakeClock()
    const pending = deferred<void>()
    const writes: number[][] = []
    const queue = new TerminalWriteQueue<void>(
      (data) => {
        writes.push(Array.from(data))
        structuredClone(data.buffer, { transfer: [data.buffer] })
        expect(data.byteLength).toBe(0)
        return pending.promise
      },
      { maxBytes: 5 },
      clock,
    )
    queue.noteInput()
    const active = queue.write(new Uint8Array([1, 2, 3]))
    const controller = new AbortController()
    const queued = queue.write('é', { signal: controller.signal })
    const cancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    const error = await queue.write('x').catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      operation: 'writeQueue.write',
      cause: { incomingBytes: 1, maxBytes: 5, pendingBytes: 5 },
    })
    expect(queue.pendingBytes).toBe(5)
    expect(clock.pending).toBe(1)
    controller.abort()
    await cancelled
    expect(queue.pendingBytes).toBe(3)
    const exactFit = queue.write(new Uint8Array([4, 5]))
    queue.flush()
    expect(queue.pendingBytes).toBe(5)
    expect(writes).toEqual([
      [1, 2, 3],
      [4, 5],
    ])
    pending.resolve()
    await active
    await exactFit
    expect(queue.pendingBytes).toBe(0)
    expect(clock.pending).toBe(0)
  })

  it('short-circuits aborted and disposed inputs before allocation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const clock = new FakeClock()
    const execute = vi.fn(() => {})
    const queue = new TerminalWriteQueue<void>(execute, {}, clock)
    const source = new Uint8Array([1])
    const copy = vi.spyOn(Uint8Array, 'from')
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    await expect(queue.write(source, { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    )
    await expect(queue.write('aborted', { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    )
    queue.dispose()
    await expect(queue.write(source)).rejects.toMatchObject({ operation: 'writeQueue.dispose' })
    await expect(queue.write('disposed')).rejects.toMatchObject({ operation: 'writeQueue.dispose' })
    expect(copy.mock.calls.filter(([input]) => input === source)).toHaveLength(0)
    expect(
      encode.mock.calls.filter(([input]) => input === 'aborted' || input === 'disposed'),
    ).toHaveLength(0)
    expect(queue.pendingBytes).toBe(0)
    expect(clock.pending).toBe(0)
    expect(execute).not.toHaveBeenCalled()
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
