const errors = {
  INVALID_HISTORY_LIMIT: {
    message: 'The history limit must be a nonnegative integer.',
    status: 400,
    why: 'History uses a bounded number of entries.',
    fix: 'Choose a finite whole-number history limit.',
  },
  READ_PENDING: {
    message: 'A line read is already active.',
    status: 409,
    why: 'Each editor owns one prompt at a time.',
    fix: 'Await or abort the active read before reading again.',
  },
  READ_ABORTED: {
    message: 'The line read was aborted.',
    status: 499,
    why: 'The host cancelled the read signal.',
    fix: 'Start another read when the host is ready.',
  },
  DISPOSED: {
    message: 'The line editor was disposed.',
    status: 410,
    why: 'The editor lifecycle has ended.',
    fix: 'Create an editor for the active terminal.',
  },
}

type ErrorCode = keyof typeof errors

export class LineEditorError extends Error {
  readonly code: `line-editor.${ErrorCode}`
  readonly status: number
  readonly why: string
  readonly fix: string
  readonly #internal: Readonly<Record<string, unknown>>

  constructor(code: ErrorCode, internal: Record<string, unknown>) {
    const { message, status, why, fix } = errors[code]
    super(message)
    this.name = 'LineEditorError'
    this.code = `line-editor.${code}`
    this.status = status
    this.why = why
    this.fix = fix
    this.#internal = internal
  }

  get internal(): Readonly<Record<string, unknown>> {
    return this.#internal
  }
}

export function createLineEditorError(
  code: ErrorCode,
  internal: Record<string, unknown>,
): LineEditorError {
  return new LineEditorError(code, internal)
}
