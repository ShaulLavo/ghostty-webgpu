import type { WorkerMessage, WorkerRequest } from '../../src/worker/protocol.js'
import { RowEncoder, RowDecoder, type DeltaFrame } from './codec.js'

type Timing = {
  readonly terminal: string
  readonly control: number
  readonly frame?: number
  readonly kind: string
  readonly at: number
  readonly end?: number
  readonly queue?: number
  readonly execute?: number
}
type Instrumented = WorkerMessage & { readonly experimentTiming: Timing }
type FrameSnapshotWithRevisions = Extract<WorkerMessage, { type: 'frame' }>['snapshot'] & {
  readonly nativeFrame?: { readTextRevisions(): readonly number[] }
}
const now = () => performance.timeOrigin + performance.now()
export class Publication {
  private readonly encoder = new RowEncoder()
  private readonly requests = new Map<number, { queue: number; execute?: number }>()
  private readonly verifier: RowDecoder | undefined
  constructor(
    private readonly binary: boolean,
    verify = false,
  ) {
    this.verifier = verify ? new RowDecoder() : undefined
  }
  queue(request: WorkerRequest): void {
    this.requests.set(request.control, { queue: now() })
  }
  execute(request: WorkerRequest): void {
    const entry = this.requests.get(request.control)
    if (entry) entry.execute = now()
  }
  post(port: MessagePort, message: WorkerMessage): void {
    const start = now()
    const request = this.requests.get(message.control)
    const timing: Timing = {
      terminal: message.terminal,
      control: message.control,
      kind: message.type,
      frame: message.type === 'frame' ? message.summary.frame : undefined,
      at: start,
      ...request,
    }
    if (this.binary && message.type === 'frame') {
      const { nativeFrame, ...snapshot } = message.snapshot as FrameSnapshotWithRevisions
      if (!nativeFrame) throw new Error('revision transport requires a retained native frame')
      const delta = this.encoder.encode(message, nativeFrame.readTextRevisions())
      if (this.verifier) {
        const decoded = this.verifier.decode(structuredClone(delta))
        if (
          JSON.stringify({ summary: decoded.summary, snapshot: decoded.snapshot }) !==
          JSON.stringify({ summary: message.summary, snapshot })
        )
          throw new Error('complete frame roundtrip diverged')
      }
      port.postMessage({ ...delta, experimentTiming: { ...timing, end: now() } }, [delta.buffer])
    } else port.postMessage({ ...message, experimentTiming: { ...timing, end: now() } })
    // Only the newest request can be included by a future frame.
    for (const control of this.requests.keys()) {
      if (control < message.control) this.requests.delete(control)
    }
  }
}
export class Reception {
  private readonly decoders = new Map<string, RowDecoder>()
  constructor(private readonly binary: boolean) {}
  receive(
    message: Instrumented | (DeltaFrame & { readonly experimentTiming: Timing }),
    consume: (message: WorkerMessage) => void,
  ): void {
    const start = now()
    let decoded: WorkerMessage
    if ('buffer' in message) {
      window.__deltaBytes += message.buffer.byteLength
      if (!this.binary) throw new Error('binary packet delivered to control')
      let decoder = this.decoders.get(message.terminal)
      if (!decoder) {
        decoder = new RowDecoder()
        this.decoders.set(message.terminal, decoder)
      }
      decoded = decoder.decode(message)
    } else decoded = message
    consume(decoded)
    window.__deltaTimings.push({ ...message.experimentTiming, received: start, completed: now() })
  }
}
declare global {
  interface Window {
    __deltaBytes: number
    __deltaTimings: (Timing & { received: number; completed: number })[]
  }
}
