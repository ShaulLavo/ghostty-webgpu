import type {
  TerminalClipboardWrite,
  TerminalClipboardWritePolicy,
  TerminalClipboardWriteResult,
} from '../term/types.js'

export interface DomClipboardWriteDecision {
  /** Reports policy acceptance only; it does not report asynchronous browser completion. */
  readonly result: TerminalClipboardWriteResult
  readonly completion?: PromiseLike<unknown>
}

export type DomClipboardWritePolicy = (
  write: TerminalClipboardWrite,
) => DomClipboardWriteDecision | TerminalClipboardWriteResult

export interface DomClipboardPolicyAdapterOptions {
  readonly onError: (cause: unknown, operation: string) => void
  readonly policy?: DomClipboardWritePolicy
}

const clipboardResults: ReadonlySet<TerminalClipboardWriteResult> = new Set([
  'busy',
  'denied',
  'invalid-data',
  'io-error',
  'success',
  'unsupported',
])

function validatedResult(value: unknown): TerminalClipboardWriteResult {
  if (typeof value === 'string' && clipboardResults.has(value as TerminalClipboardWriteResult)) {
    return value as TerminalClipboardWriteResult
  }
  throw new TypeError(`Unknown clipboard write result: ${String(value)}`)
}

function observeCompletion(
  completion: PromiseLike<unknown> | undefined,
  onError: (cause: unknown, operation: string) => void,
): void {
  if (!completion) return
  try {
    void Promise.resolve(completion).catch((cause: unknown) => {
      reportError(onError, cause)
    })
  } catch (cause) {
    reportError(onError, cause)
  }
}

function reportError(onError: (cause: unknown, operation: string) => void, cause: unknown): void {
  try {
    onError(cause, 'clipboardWrite.completion')
  } catch {
    return
  }
}

function normalizeDecision(
  value: DomClipboardWriteDecision | TerminalClipboardWriteResult,
  onError: (cause: unknown, operation: string) => void,
): TerminalClipboardWriteResult {
  if (typeof value === 'string') return validatedResult(value)
  if (!value || typeof value !== 'object') {
    throw new TypeError('clipboard write policy must return a result or decision')
  }
  const result = validatedResult(value.result)
  observeCompletion(value.completion, onError)
  return result
}

export function createDomClipboardPolicyAdapter(
  options: DomClipboardPolicyAdapterOptions,
): TerminalClipboardWritePolicy | undefined {
  const policy = options.policy
  if (!policy) return undefined
  return (write) => normalizeDecision(policy(write), options.onError)
}

export function writeUserSelectionToClipboard(view: Window, text: string): Promise<void> {
  const clipboard = view.navigator.clipboard
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return Promise.reject(new TypeError('The Clipboard API is unavailable'))
  }
  return clipboard.writeText(text)
}
