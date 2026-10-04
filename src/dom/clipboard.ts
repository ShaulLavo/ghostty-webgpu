import { createGhosttyError } from '../core/error.js'
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

export interface UserSelectionClipboardOptions {
  readonly signal?: AbortSignal
}

function selectionBlob(
  text: PromiseLike<string | undefined>,
  signal: AbortSignal | undefined,
): Promise<Blob> {
  const selection = Promise.resolve(text).then((value) => {
    if (value === undefined) {
      throw createGhosttyError('clipboard.selection', 'The selected text is unavailable')
    }
    return new Blob([value], { type: 'text/plain' })
  })
  if (!signal) return selection
  const abort = () => rejectAbort(signal.reason)
  let rejectAbort: (reason: unknown) => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return Promise.race([selection, cancelled]).finally(() => {
    signal.removeEventListener('abort', abort)
  })
}

export async function writeUserSelectionToClipboard(
  view: Window,
  text: string | PromiseLike<string | undefined>,
  options: UserSelectionClipboardOptions = {},
): Promise<void> {
  const clipboard = view.navigator.clipboard
  if (typeof text !== 'string') void Promise.resolve(text).catch(() => {})
  options.signal?.throwIfAborted()
  if (!clipboard) throw createGhosttyError('clipboard.write', 'The Clipboard API is unavailable')
  if (typeof text === 'string') {
    if (typeof clipboard.writeText !== 'function') {
      throw createGhosttyError('clipboard.write', 'Text clipboard writes are unavailable')
    }
    return clipboard.writeText(text)
  }
  if (typeof clipboard.write !== 'function' || typeof ClipboardItem !== 'function') {
    throw createGhosttyError('clipboard.write', 'Delayed clipboard writes are unavailable')
  }
  // Calling write before readback settles retains the trusted event's browser activation.
  const blob = selectionBlob(text, options.signal)
  void blob.catch(() => {})
  return clipboard.write([new ClipboardItem({ 'text/plain': blob })])
}
