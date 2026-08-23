export const MAX_PTY_COLS = 1_000
export const MAX_PTY_ROWS = 500
export const MAX_PTY_INPUT_BYTES = 1024 * 1024

export type DemoClientMessage =
  | { readonly type: 'input'; readonly bytes: Uint8Array }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number }

export function parseClientMessage(
  message: string | ArrayBuffer | ArrayBufferView,
): DemoClientMessage {
  if (typeof message !== 'string') return parseInput(message)
  return parseResize(message)
}

function parseInput(message: ArrayBuffer | ArrayBufferView): DemoClientMessage {
  const bytes = ArrayBuffer.isView(message)
    ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
    : new Uint8Array(message)
  if (bytes.byteLength > MAX_PTY_INPUT_BYTES) {
    throw new RangeError(`PTY input must not exceed ${MAX_PTY_INPUT_BYTES} bytes`)
  }
  return { type: 'input', bytes: bytes.slice() }
}

function parseResize(message: string): DemoClientMessage {
  let value: unknown
  try {
    value = JSON.parse(message) as unknown
  } catch {
    throw new TypeError('Text WebSocket messages must be valid resize JSON')
  }

  if (!isRecord(value) || !hasExactResizeKeys(value)) {
    throw new TypeError('Resize messages must contain exactly type, cols, and rows')
  }
  if (value.type !== 'resize') {
    throw new TypeError('Text WebSocket messages must have type resize')
  }
  validateDimension(value.cols, 'cols', MAX_PTY_COLS)
  validateDimension(value.rows, 'rows', MAX_PTY_ROWS)
  return { type: 'resize', cols: value.cols, rows: value.rows }
}

function hasExactResizeKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === 3 && keys[0] === 'cols' && keys[1] === 'rows' && keys[2] === 'type'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateDimension(value: unknown, name: string, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}`)
  }
}
