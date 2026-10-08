import '../../../dist/worker/entry.js'
import type { WorkerInitialize, WorkerMessage, WorkerRequest } from '../protocol.js'
import { observeDevice, type DeviceLifecycleCounts } from './device-lifecycle.js'

export type DeviceLifecycleObservation =
  | { readonly type: 'acquired'; readonly device: number }
  | { readonly type: 'waiting'; readonly device: number }
  | { readonly type: 'destroyed'; readonly device: number }
  | { readonly type: 'interrupted' | 'closed' | 'layout-armed' | 'layout-held' }
  | { readonly type: 'deadline-armed' | 'deadline-cleared'; readonly delay: number }
  | { readonly type: 'warning'; readonly value: unknown }
  | {
      readonly type: 'completed' | 'inspected' | 'abandoned'
      readonly devices: readonly DeviceLifecycleCounts[]
    }

const channel = new BroadcastChannel('packaged-worker-device-lifecycle')
const parameters = new URL(globalThis.location.href).searchParams
const mode = parameters.get('lifecycle')
const devices: DeviceLifecycleCounts[] = []
const losses: (() => void)[] = []
const fence = Promise.withResolvers<void>()
const acquisition = Promise.withResolvers<void>()
const timers = new Map<number, () => void>()
const heldLayouts: (() => void)[] = []
let holdLayout = false
const requestDevice = GPUAdapter.prototype.requestDevice
GPUAdapter.prototype.requestDevice = async function (descriptor) {
  const device = await requestDevice.call(this, descriptor)
  const identity = devices.length
  losses.push(device.destroy.bind(device))
  if (mode === 'rejected' || mode === 'rejected-held')
    device.queue.onSubmittedWorkDone = () =>
      Promise.reject(new DOMException('Fixture queue fence rejected', 'OperationError'))
  const wait = device.queue.onSubmittedWorkDone.bind(device.queue)
  if (mode === 'held' || mode === 'rejected-held' || (mode === 'retired-held' && identity === 0))
    device.queue.onSubmittedWorkDone = () => {
      channel.postMessage({ type: 'waiting', device: identity })
      return wait()
        .finally(() => fence.promise)
        .then(() => undefined)
    }
  const counts = observeDevice(device, identity)
  const destroy = device.destroy.bind(device)
  device.destroy = () => {
    destroy()
    channel.postMessage({ type: 'destroyed', device: identity })
  }
  devices.push(counts)
  channel.postMessage({ type: 'acquired', device: counts.device })
  if (mode === 'initial-held' || (mode === 'replacement-held' && identity === 1))
    await acquisition.promise
  return device
}

if (mode === 'setup-failed')
  GPUCanvasContext.prototype.configure = () => {
    throw new DOMException('Fixture canvas configuration failed', 'OperationError')
  }

channel.onmessage = ({
  data,
}: MessageEvent<
  'release' | 'lose' | 'inspect' | 'acquire' | 'deadline' | 'hold-layout' | 'release-layout'
>) => {
  if (data === 'hold-layout') {
    holdLayout = true
    channel.postMessage({ type: 'layout-armed' })
  }
  if (data === 'release-layout') {
    holdLayout = false
    for (const release of heldLayouts.splice(0)) release()
  }
  if (data === 'acquire') acquisition.resolve()
  if (data === 'release') fence.resolve()
  if (data === 'lose') losses.at(-1)?.()
  if (data === 'inspect') channel.postMessage({ type: 'inspected', devices })
  if (data === 'deadline') {
    for (const [handle, callback] of timers) {
      timers.delete(handle)
      callback()
    }
  }
}

const scope = globalThis as unknown as {
  onmessage(event: MessageEvent<WorkerInitialize>): void
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(handle: number): void
  close(): void
}
if (parameters.get('clock') === 'manual') {
  const setTimer = scope.setTimeout.bind(scope)
  const clearTimer = scope.clearTimeout.bind(scope)
  let nextTimer = -1
  scope.setTimeout = (callback, delay) => {
    if (delay !== 15_000) return setTimer(callback, delay)
    const handle = nextTimer--
    timers.set(handle, callback)
    channel.postMessage({ type: 'deadline-armed', delay })
    return handle
  }
  scope.clearTimeout = (handle) => {
    if (handle >= 0) return clearTimer(handle)
    timers.delete(handle)
    channel.postMessage({ type: 'deadline-cleared', delay: 15_000 })
  }
}
const warn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  channel.postMessage({ type: 'warning', value: args[0] })
  warn(...args)
}
const close = scope.close.bind(scope)
scope.close = () => {
  channel.postMessage({ type: 'closed' })
  close()
}
const initialize = scope.onmessage
scope.onmessage = (event) => {
  const port = event.data.port
  let opening: number | undefined
  let disposing: number | undefined
  const layouts = new Set<number>()
  port.addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
    if (data.command === 'layout') layouts.add(data.id)
    if (data.command === 'open') opening = data.id
    if (data.command === 'dispose') disposing = data.id
    if (mode === 'initial-held' && data.generation !== event.data.generation)
      queueMicrotask(() => channel.postMessage({ type: 'interrupted' }))
  })
  const send = port.postMessage.bind(port)
  port.postMessage = (message: WorkerMessage) => {
    if (message.type === 'reply' && layouts.delete(message.id) && holdLayout) {
      heldLayouts.push(() => send(message))
      channel.postMessage({ type: 'layout-held' })
      return
    }
    if (
      (message.type === 'fatal' || message.type === 'reply') &&
      message.failure?.operation === 'cleanup'
    )
      channel.postMessage({ type: 'abandoned', devices })
    else if (
      message.type === 'fatal' ||
      (message.type === 'reply' &&
        (message.id === disposing || (message.id === opening && !!message.failure)))
    )
      channel.postMessage({ type: 'completed', devices })
    send(message)
  }
  initialize(event)
}
