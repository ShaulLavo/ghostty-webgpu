import { afterEach, expect, test, vi } from 'vitest'

const apply = Reflect.apply
const descriptor = Object.getOwnPropertyDescriptor
const post = BroadcastChannel.prototype.postMessage

afterEach(() => {
  Reflect.apply = apply
  Object.getOwnPropertyDescriptor = descriptor
  BroadcastChannel.prototype.postMessage = post
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function install(): Promise<() => string> {
  let snapshot: (() => string) | undefined
  vi.stubGlobal('document', {})
  vi.stubGlobal(Symbol.for('waffle.framework.trace'), () => ({
    kind: 'tester',
    bind(input: { snapshot: () => string }) {
      snapshot = input.snapshot
    },
  }))
  const { installReportingTrace } = await import('./ios-browser-reporting-page.ts')
  installReportingTrace('matrix')
  if (!snapshot) throw new Error('Missing snapshot binding')
  return snapshot
}

function changingMessage(): object {
  return new Proxy(
    { event: 'response:cleanup' },
    {
      getOwnPropertyDescriptor(target, key) {
        Reflect.apply = () => {
          throw new Error('observer sentinel')
        }
        Object.getOwnPropertyDescriptor = () => {
          throw new Error('descriptor sentinel')
        }
        return descriptor(target, key)
      },
    },
  )
}

test('recording cannot replace an actual BroadcastChannel DataCloneError', async () => {
  const channel = new BroadcastChannel('ghostty-reporting-post-cpu')
  const message = changingMessage()
  expect(() => apply(post, channel, [message])).toThrow(DOMException)
  await install()
  let error: unknown
  try {
    channel.postMessage(message)
  } catch (caught) {
    error = caught
  } finally {
    Reflect.apply = apply
    Object.getOwnPropertyDescriptor = descriptor
    channel.close()
  }
  expect(error).toBeInstanceOf(DOMException)
  expect(error).toHaveProperty('name', 'DataCloneError')
})

test.each(['return', 'throw'])(
  'recording preserves the original post %s and receiver',
  async (kind) => {
    const result = Symbol('original result')
    const receivers: unknown[] = []
    let actual: unknown[] | undefined
    BroadcastChannel.prototype.postMessage = function (...args) {
      receivers.push(this)
      actual = args
      if (kind === 'throw') throw result
      return result
    }
    await install()
    const message = changingMessage()
    const extra = { retained: true }
    const owner = { postMessage: BroadcastChannel.prototype.postMessage }
    let returned: unknown
    let thrown: unknown
    try {
      returned = apply(owner.postMessage, owner, [message, extra])
    } catch (error) {
      thrown = error
    } finally {
      Reflect.apply = apply
      Object.getOwnPropertyDescriptor = descriptor
    }
    expect(receivers).toHaveLength(1)
    expect(receivers[0]).toBe(owner)
    expect(actual).toHaveLength(2)
    expect(actual?.[0]).toBe(message)
    expect(actual?.[1]).toBe(extra)
    expect(kind === 'throw' ? thrown : returned).toBe(result)
  },
)

test('a failed observer keeps failure marking nonthrowing and preserves the original return', async () => {
  const { ReportingRecorder } = await import('./ios-browser-reporting-data.ts')
  const fail = ReportingRecorder.prototype.fail
  const result = Symbol('original return')
  BroadcastChannel.prototype.postMessage = () => result
  const snapshot = await install()
  const message = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        ReportingRecorder.prototype.fail = () => {
          throw new Error('failure marker sentinel')
        }
        throw new Error('observer failure')
      },
    },
  )
  const owner = { postMessage: BroadcastChannel.prototype.postMessage }
  try {
    expect(owner.postMessage(message)).toBe(result)
    expect(snapshot).toThrow('recorder')
  } finally {
    ReportingRecorder.prototype.fail = fail
  }
})
