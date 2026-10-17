import type { EvlogError } from 'evlog'
import { defineErrorCatalog } from 'evlog/catalog'

const errors = defineErrorCatalog('line-editor', {
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
})

export function createLineEditorError(
  code: Exclude<keyof typeof errors, `_${string}`>,
  internal: Record<string, unknown>,
): EvlogError {
  return errors[code]({ internal })
}
