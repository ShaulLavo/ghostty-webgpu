export type WorkerPoolMode = 'control' | 'pool'

export interface WorkerPoolInit {
  readonly type: 'initialize'
  readonly mode: WorkerPoolMode
  readonly terminalCount: number
  readonly columns: number
  readonly rows: number
  readonly pixelRatio: number
  readonly wasm: string
  readonly bridge: string
  readonly fontUrl: string
  readonly fontFamily: string
  readonly canvas?: OffscreenCanvas
  readonly canvases?: readonly OffscreenCanvas[]
}

export interface WorkerPoolWrite {
  readonly type: 'write'
  readonly terminal: number
  readonly sequence: number
  readonly data: string
}

export interface WorkerPoolDispose {
  readonly type: 'dispose'
}

export interface WorkerPoolCommand {
  readonly type: 'command'
  readonly id: number
  readonly terminal: number
  readonly command: 'disposeSession' | 'fontDpr' | 'lose'
}

export type WorkerPoolRequest =
  | WorkerPoolInit
  | WorkerPoolWrite
  | WorkerPoolDispose
  | WorkerPoolCommand

export interface WorkerPoolReady {
  readonly type: 'ready'
  readonly cellWidth: number
  readonly cellHeight: number
  readonly terminalCount: number
}

export interface WorkerPoolAck {
  readonly type: 'ack'
  readonly terminal: number
  readonly sequence: number
}

export interface WorkerPoolFrame {
  readonly type: 'frame'
  readonly terminal: number
  readonly sequence: number
  readonly postedAt: number
  readonly snapshot: {
    readonly rows: readonly {
      readonly y: number
      readonly text: string
      readonly cells: readonly string[]
      readonly continuations: readonly boolean[]
    }[]
  }
}

export interface WorkerPoolDelta {
  readonly type: 'delta'
  readonly terminal: number
  readonly sequence: number
  readonly postedAt: number
  readonly buffer: ArrayBuffer
}

export interface WorkerPoolStopped {
  readonly type: 'stopped'
}

export interface WorkerPoolFailure {
  readonly type: 'failure'
  readonly message: string
}

export interface WorkerPoolCommandReply {
  readonly type: 'commandReply'
  readonly id: number
}

export type WorkerPoolMessage =
  | WorkerPoolCommandReply
  | WorkerPoolReady
  | WorkerPoolAck
  | WorkerPoolFrame
  | WorkerPoolDelta
  | WorkerPoolStopped
  | WorkerPoolFailure
