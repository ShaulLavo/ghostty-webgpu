import { getFrameworkTraceDocument } from 'waffle/testing/page-runner/framework-page'
import { ReportingRecorder } from './ios-browser-reporting-data.ts'

const apply = Reflect.apply
const ownDescriptor = Object.getOwnPropertyDescriptor

let recorder: ReportingRecorder | undefined

export function reportingArray<T>(): T[] {
  return recorder?.array<T>() ?? []
}

export function installReportingTrace(mode: string): void {
  const trace = getFrameworkTraceDocument()
  if (!trace || trace.kind !== 'tester') throw new Error('Actual tester trace was not armed')
  if (recorder) throw new Error('Actual tester fixture already bound')
  const recorded = new ReportingRecorder()
  recorder = recorded
  for (const name of ['Bodies', 'Hooks', 'Clocks', 'Messages'])
    Reflect.set(globalThis, `__reporting${name}`, recorded.array())
  Reflect.set(globalThis, '__reportingRefusalMode', mode)
  trace.bind({
    snapshot: () =>
      recorded.encode({
        bodies: own('__reportingBodies'),
        hooks: own('__reportingHooks'),
        clocks: own('__reportingClocks'),
        messages: own('__reportingMessages'),
        errorTrace: own('__reportingErrorTrace'),
        flush: own('__reportingFlush'),
      }),
    releaseOriginalRpc: () => {
      const release = own('__reportingReleaseRpc')
      if (typeof release !== 'function') throw new Error('Existing original RPC hold is missing')
      release()
    },
  })
  const original = BroadcastChannel.prototype.postMessage
  const fail = recorded.fail.bind(recorded)
  BroadcastChannel.prototype.postMessage = function (...args: Parameters<typeof original>) {
    try {
      const event = eventName(args[0])
      if (event) recordMessage(event)
    } catch {
      fail()
      // Recorder failure cannot replace the original post result.
    }
    return apply(original, this, args)
  }
}

function own(name: string): unknown {
  const descriptor = ownDescriptor(globalThis, name)
  if (!descriptor) return null
  if (!('value' in descriptor)) throw new Error('Fixture data accessor is not recorded data')
  return descriptor.value
}

function eventName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return
  const event = ownDescriptor(value, 'event')
  if (event && 'value' in event && typeof event.value === 'string') return event.value
}

function recordMessage(event: string): void {
  const messages = own('__reportingMessages')
  if (!Array.isArray(messages)) throw new Error('Missing recorded message array')
  messages.push(event)
}
