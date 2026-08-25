import { describe, expect, it } from 'vitest'
import { XtermWriteQueue } from '../write-queue.js'

interface Target {
  readonly chunks: Array<string | Uint8Array>
}

interface Harness {
  readonly parsed: string[]
  readonly queue: XtermWriteQueue<Target>
  readonly target: Target
  readonly tasks: Array<() => void>
}

function harness(options: { now?: () => number; paused?: boolean } = {}): Harness {
  const parsed: string[] = []
  const target = { chunks: [] as Array<string | Uint8Array> }
  const tasks: Array<() => void> = []
  const queue = new XtermWriteQueue<Target>({
    consume: (value, data) => value.chunks.push(data),
    now: options.now,
    onWriteParsed: () => parsed.push('parsed'),
    scheduleTask: (callback) => tasks.push(callback),
  })
  if (options.paused) queue.pause()
  return { parsed, queue, target, tasks }
}

function runNextTask(tasks: Array<() => void>): void {
  const task = tasks.shift()
  if (!task) throw new Error('Expected a scheduled task')
  task()
}

function chunkText(chunks: Array<string | Uint8Array>): string[] {
  const decoder = new TextDecoder()
  return chunks.map((chunk) => (typeof chunk === 'string' ? chunk : decoder.decode(chunk)))
}

describe('XtermWriteQueue', () => {
  it('runs ordinary writes in the next task and snapshots bytes before a readiness wait', () => {
    const { parsed, queue, target, tasks } = harness({ paused: true })
    const bytes = new Uint8Array([0x41])
    const timeline: string[] = []
    queue.bind(target)

    queue.write(bytes, () => timeline.push('callback'))
    bytes[0] = 0x42
    timeline.push('returned')
    expect(tasks).toHaveLength(1)
    expect(target.chunks).toEqual([])

    runNextTask(tasks)
    bytes[0] = 0x43
    queue.resume()
    runNextTask(tasks)

    expect(chunkText(target.chunks)).toEqual(['B'])
    expect(timeline).toEqual(['returned', 'callback'])
    expect(parsed).toEqual(['parsed'])
  })

  it('queues writeln payload and CRLF as separate entries with one batch event', () => {
    const { parsed, queue, target, tasks } = harness()
    const timeline: string[] = []
    queue.bind(target)

    queue.writeln('payload', () => timeline.push('callback'))
    expect(tasks).toHaveLength(1)
    runNextTask(tasks)

    expect(chunkText(target.chunks)).toEqual(['payload', '\r\n'])
    expect(timeline).toEqual(['callback'])
    expect(parsed).toEqual(['parsed'])
  })

  it('uses the synchronous fast path after user input when delivery is ready', () => {
    const { parsed, queue, target, tasks } = harness()
    const timeline: string[] = []
    queue.bind(target)
    queue.handleUserInput()

    queue.write('response', () => timeline.push('callback'))
    timeline.push('returned')

    expect(tasks).toEqual([])
    expect(chunkText(target.chunks)).toEqual(['response'])
    expect(timeline).toEqual(['callback', 'returned'])
    expect(parsed).toEqual(['parsed'])
  })

  it('keeps writeln CRLF deferred after a synchronous user-input payload', () => {
    const { parsed, queue, target, tasks } = harness()
    const timeline: string[] = []
    queue.bind(target)
    queue.handleUserInput()

    queue.writeln('payload', () => timeline.push('callback'))

    expect(chunkText(target.chunks)).toEqual(['payload'])
    expect(parsed).toEqual(['parsed'])
    expect(timeline).toEqual([])
    runNextTask(tasks)
    expect(chunkText(target.chunks)).toEqual(['payload', '\r\n'])
    expect(parsed).toEqual(['parsed', 'parsed'])
    expect(timeline).toEqual(['callback'])
  })

  it('snapshots a blocked user-input fast-path write immediately', () => {
    const { parsed, queue, target, tasks } = harness({ paused: true })
    const bytes = new Uint8Array([0x41])
    queue.bind(target)
    queue.handleUserInput()

    queue.write(bytes)
    bytes[0] = 0x42
    queue.resume()
    runNextTask(tasks)

    expect(tasks).toEqual([])
    expect(chunkText(target.chunks)).toEqual(['A'])
    expect(parsed).toEqual(['parsed'])
  })

  it('keeps callback-reentrant writes in the current batch', () => {
    const { parsed, queue, target, tasks } = harness()
    const timeline: string[] = []
    queue.bind(target)
    queue.write('A', () => {
      timeline.push('A')
      queue.write('B', () => timeline.push('B'))
    })

    runNextTask(tasks)

    expect(chunkText(target.chunks)).toEqual(['A', 'B'])
    expect(timeline).toEqual(['A', 'B'])
    expect(parsed).toEqual(['parsed'])
    expect(tasks).toEqual([])
  })

  it('starts a new task when onWriteParsed writes again', () => {
    const target = { chunks: [] as Array<string | Uint8Array> }
    const tasks: Array<() => void> = []
    const timeline: string[] = []
    let parsed = 0
    const queue = new XtermWriteQueue<Target>({
      consume: (value, data) => value.chunks.push(data),
      onWriteParsed: () => {
        parsed += 1
        timeline.push(`parsed:${parsed}`)
        if (parsed === 1) queue.write('B', () => timeline.push('B'))
      },
      scheduleTask: (callback) => tasks.push(callback),
    })
    queue.bind(target)
    queue.write('A', () => timeline.push('A'))

    runNextTask(tasks)
    expect(timeline).toEqual(['A', 'parsed:1'])
    runNextTask(tasks)

    expect(chunkText(target.chunks)).toEqual(['A', 'B'])
    expect(timeline).toEqual(['A', 'parsed:1', 'B', 'parsed:2'])
  })

  it('runs a user-input write synchronously inside onWriteParsed', () => {
    const target = { chunks: [] as Array<string | Uint8Array> }
    const tasks: Array<() => void> = []
    const timeline: string[] = []
    let parsed = 0
    const queue = new XtermWriteQueue<Target>({
      consume: (value, data) => value.chunks.push(data),
      onWriteParsed: () => {
        parsed += 1
        const event = parsed
        timeline.push(`parsed:${event}:start`)
        if (event === 1) {
          queue.handleUserInput()
          timeline.push('before')
          queue.write('B', () => timeline.push('B'))
          timeline.push('after')
        }
        timeline.push(`parsed:${event}:end`)
      },
      scheduleTask: (callback) => tasks.push(callback),
    })
    queue.bind(target)
    queue.write('A', () => timeline.push('A'))

    runNextTask(tasks)

    expect(chunkText(target.chunks)).toEqual(['A', 'B'])
    expect(timeline).toEqual([
      'A',
      'parsed:1:start',
      'before',
      'B',
      'parsed:2:start',
      'parsed:2:end',
      'after',
      'parsed:1:end',
    ])
    expect(tasks).toEqual([])
  })

  it('strands a nested user-input callback failure before its listener can swallow it', () => {
    const target = { chunks: [] as Array<string | Uint8Array> }
    const tasks: Array<() => void> = []
    const failure = new Error('nested callback failed')
    let caught: unknown
    let parsed = 0
    const queue = new XtermWriteQueue<Target>({
      consume: (value, data) => value.chunks.push(data),
      onWriteParsed: () => {
        parsed += 1
        if (parsed !== 1) return
        queue.handleUserInput()
        try {
          queue.write('B', () => {
            throw failure
          })
        } catch (cause) {
          caught = cause
        }
      },
      scheduleTask: (callback) => tasks.push(callback),
    })
    queue.bind(target)
    queue.write('A')

    runNextTask(tasks)
    queue.write('C')

    expect(caught).toBe(failure)
    expect(chunkText(target.chunks)).toEqual(['A', 'B'])
    expect(queue.isStranded).toBe(true)
    expect(queue.pendingCount).toBe(2)
    expect(tasks).toEqual([])
  })

  it('preserves a time-sliced remainder from a nested user-input write', () => {
    const target = { chunks: [] as Array<string | Uint8Array> }
    const tasks: Array<() => void> = []
    let parsed = 0
    let time = 0
    const queue = new XtermWriteQueue<Target>({
      consume: (value, data) => value.chunks.push(data),
      now: () => time,
      onWriteParsed: () => {
        parsed += 1
        if (parsed !== 1) return
        queue.handleUserInput()
        queue.write('B', () => {
          time = 12
          queue.write('C')
        })
      },
      scheduleTask: (callback) => tasks.push(callback),
    })
    queue.bind(target)
    queue.write('A')

    runNextTask(tasks)
    expect(chunkText(target.chunks)).toEqual(['A', 'B'])
    expect(parsed).toBe(2)
    expect(tasks).toHaveLength(1)

    runNextTask(tasks)
    expect(chunkText(target.chunks)).toEqual(['A', 'B', 'C'])
    expect(parsed).toBe(3)
    expect(tasks).toEqual([])
  })

  it('emits once per time slice and resumes the remainder in another task', () => {
    let time = 0
    const { parsed, queue, target, tasks } = harness({ now: () => time })
    queue.bind(target)
    queue.write('A', () => {
      time = 12
    })
    queue.write('B')

    runNextTask(tasks)
    expect(chunkText(target.chunks)).toEqual(['A'])
    expect(parsed).toEqual(['parsed'])
    expect(tasks).toHaveLength(1)

    runNextTask(tasks)
    expect(chunkText(target.chunks)).toEqual(['A', 'B'])
    expect(parsed).toEqual(['parsed', 'parsed'])
  })

  it('appends writes arriving between slices without adding a task or parsed event', () => {
    let time = 0
    const { parsed, queue, target, tasks } = harness({ now: () => time })
    queue.bind(target)
    queue.write('A', () => {
      time = 12
    })
    queue.write('R')

    runNextTask(tasks)
    expect(chunkText(target.chunks)).toEqual(['A'])
    expect(parsed).toEqual(['parsed'])
    expect(tasks).toHaveLength(1)

    queue.write('B')
    expect(chunkText(target.chunks)).toEqual(['A'])
    expect(parsed).toEqual(['parsed'])
    expect(tasks).toHaveLength(1)

    runNextTask(tasks)
    expect(chunkText(target.chunks)).toEqual(['A', 'R', 'B'])
    expect(parsed).toEqual(['parsed', 'parsed'])
    expect(tasks).toEqual([])
  })

  it('preserves user-input state when its response appends to a yielded remainder', () => {
    let time = 0
    const { parsed, queue, target, tasks } = harness({ now: () => time })
    const timeline: string[] = []
    queue.bind(target)
    queue.write('A', () => {
      time = 12
    })
    queue.write('R')
    runNextTask(tasks)

    queue.handleUserInput()
    queue.write('B', () => timeline.push('B'))
    timeline.push('returned:B')

    expect(chunkText(target.chunks)).toEqual(['A'])
    expect(timeline).toEqual(['returned:B'])
    expect(tasks).toHaveLength(1)

    runNextTask(tasks)
    expect(chunkText(target.chunks)).toEqual(['A', 'R', 'B'])
    expect(timeline).toEqual(['returned:B', 'B'])
    expect(parsed).toEqual(['parsed', 'parsed'])

    queue.write('C', () => timeline.push('C'))
    timeline.push('returned:C')

    expect(chunkText(target.chunks)).toEqual(['A', 'R', 'B', 'C'])
    expect(timeline).toEqual(['returned:B', 'B', 'C', 'returned:C'])
    expect(parsed).toEqual(['parsed', 'parsed', 'parsed'])
    expect(tasks).toEqual([])
  })

  it('retains caller-owned bytes until their actual later parse slice', () => {
    let time = 0
    const { parsed, queue, target, tasks } = harness({ now: () => time })
    const bytes = new Uint8Array([0x41])
    queue.bind(target)
    queue.write('A', () => {
      time = 12
    })
    queue.write(bytes)

    runNextTask(tasks)
    bytes[0] = 0x42
    runNextTask(tasks)

    expect(chunkText(target.chunks)).toEqual(['A', 'B'])
    expect(parsed).toEqual(['parsed', 'parsed'])
  })

  it('snapshots bytes when a later parse slice encounters a readiness wait', () => {
    let time = 0
    const { parsed, queue, target, tasks } = harness({ now: () => time })
    const bytes = new Uint8Array([0x41])
    queue.bind(target)
    queue.write('A', () => {
      time = 12
    })
    queue.write(bytes)
    runNextTask(tasks)

    queue.pause()
    bytes[0] = 0x42
    runNextTask(tasks)
    bytes[0] = 0x43
    queue.resume()
    runNextTask(tasks)

    expect(chunkText(target.chunks)).toEqual(['A', 'B'])
    expect(parsed).toEqual(['parsed', 'parsed'])
  })

  it('snapshots reentrant bytes before a callback-created readiness wait', () => {
    const { parsed, queue, target, tasks } = harness()
    const bytes = new Uint8Array([0x41])
    queue.bind(target)
    queue.write('ready', () => {
      queue.pause()
      queue.write(bytes)
    })

    runNextTask(tasks)
    bytes[0] = 0x42
    queue.resume()
    runNextTask(tasks)

    expect(chunkText(target.chunks)).toEqual(['ready', 'A'])
    expect(parsed).toEqual(['parsed'])
  })

  it('lets callback failures escape and strands the current remainder', () => {
    const { parsed, queue, target, tasks } = harness()
    const failure = new Error('callback failed')
    queue.bind(target)
    queue.write('A', () => {
      throw failure
    })
    queue.write('B')

    expect(() => runNextTask(tasks)).toThrow(failure)
    queue.write('C')

    expect(chunkText(target.chunks)).toEqual(['A'])
    expect(parsed).toEqual([])
    expect(queue.isStranded).toBe(true)
    expect(queue.pendingCount).toBe(3)
    expect(tasks).toEqual([])
  })

  it('defers a due batch when binding and lets callback failures escape the task', () => {
    const { parsed, queue, target, tasks } = harness()
    const failure = new Error('pre-ready callback failed')
    queue.write('A', () => {
      throw failure
    })
    queue.write('B')
    runNextTask(tasks)

    expect(() => queue.bind(target)).not.toThrow()
    expect(target.chunks).toEqual([])
    expect(() => runNextTask(tasks)).toThrow(failure)
    expect(chunkText(target.chunks)).toEqual(['A'])
    expect(parsed).toEqual([])
    expect(queue.isStranded).toBe(true)
  })

  it('abandons deferred work without inventing callback completion', () => {
    const { parsed, queue, target, tasks } = harness()
    let callbacks = 0
    queue.write('pending', () => {
      callbacks += 1
    })

    queue.abandon()
    queue.bind(target)
    runNextTask(tasks)

    expect(callbacks).toBe(0)
    expect(parsed).toEqual([])
    expect(target.chunks).toEqual([])
    expect(queue.pendingCount).toBe(0)
    expect(queue.isAbandoned).toBe(true)
  })

  it('allows a callback to abandon the remaining batch without a fake parsed event', () => {
    const { parsed, queue, target, tasks } = harness()
    const timeline: string[] = []
    queue.bind(target)
    queue.write('A', () => {
      timeline.push('A')
      queue.abandon()
    })
    queue.write('B', () => timeline.push('B'))

    expect(() => runNextTask(tasks)).not.toThrow()

    expect(chunkText(target.chunks)).toEqual(['A'])
    expect(timeline).toEqual(['A'])
    expect(parsed).toEqual([])
    expect(queue.pendingCount).toBe(0)
    expect(queue.isAbandoned).toBe(true)
  })

  it('applies xterm pending-data watermark semantics', () => {
    const tasks: Array<() => void> = []
    const queue = new XtermWriteQueue<Target>({
      consume: (target, data) => target.chunks.push(data),
      maxPendingData: 1,
      onWriteParsed: () => {},
      scheduleTask: (callback) => tasks.push(callback),
    })

    queue.write('AB')

    expect(() => queue.write('C')).toThrow(
      'write data discarded, use flow control to avoid losing data',
    )
    expect(queue.pendingCount).toBe(1)
  })
})
