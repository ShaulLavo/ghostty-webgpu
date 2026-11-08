import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const workerWriteQueueFile = fileURLToPath(
  new URL('../src/worker/write-queue.browser.test.ts', import.meta.url),
)

export const workerWriteQueueCases = [
  {
    file: workerWriteQueueFile,
    fullName: 'transfers owned batched buffers and acknowledges native parsing',
    sourceKey: 'src/worker/write-queue.browser.test.ts:30:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: workerWriteQueueFile,
    fullName: 'keeps batched output ahead of later write and appearance controls',
    sourceKey: 'src/worker/write-queue.browser.test.ts:52:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: workerWriteQueueFile,
    fullName: 'cancels a queued worker write without cancelling its neighbors',
    sourceKey: 'src/worker/write-queue.browser.test.ts:69:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: workerWriteQueueFile,
    fullName: 'rejects queued worker writes before disposal finishes',
    sourceKey: 'src/worker/write-queue.browser.test.ts:87:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
