import type {
  ProducerObservation,
  WorkerCleanup,
  WorkerObservation,
  WorkerRenderMessage,
} from './worker-protocol.js'

export interface WorkerRun {
  readonly observation: WorkerObservation
  readonly cleanup: WorkerCleanup
  readonly error?: string
  readonly producer: ProducerObservation
  readonly messageTypes: readonly string[]
}

type TerminalSignal =
  | { readonly type: 'complete' }
  | { readonly type: 'error'; readonly error: string }

export class WorkerRunCollector {
  private observation?: WorkerObservation
  private cleanup?: WorkerCleanup
  private producer?: ProducerObservation
  private signal?: TerminalSignal | { readonly type: 'invalid' }
  private readonly messageTypes: string[] = []

  constructor(private readonly expectedSignal: TerminalSignal['type']) {}

  recordMessage(message: WorkerRenderMessage): void {
    this.messageTypes.push(message.type)
    if (message.type === 'result') this.observation = message.observation
    if (message.type === 'disposed') this.cleanup = message.cleanup
    if (message.type === 'complete') this.recordSignal(message)
  }

  recordProducer(observation: ProducerObservation): void {
    this.producer = observation
  }

  recordError(error: string): void {
    this.recordSignal({ type: 'error', error })
  }

  private recordSignal(signal: TerminalSignal): void {
    if (this.signal?.type === 'invalid') return
    this.signal = signal.type === this.expectedSignal ? signal : { type: 'invalid' }
  }

  result(): WorkerRun | undefined {
    if (this.signal?.type !== this.expectedSignal) return
    if (!this.observation || !this.cleanup || !this.producer) return
    return {
      observation: this.observation,
      cleanup: this.cleanup,
      producer: this.producer,
      messageTypes: this.messageTypes,
      error: this.signal.type === 'error' ? this.signal.error : undefined,
    }
  }
}
