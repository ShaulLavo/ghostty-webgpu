import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const writeQueueFile = fileURLToPath(
  new URL('../src/dom/tests/write-queue.browser.test.ts', import.meta.url),
)

export const writeQueueCases = [
  {
    file: writeQueueFile,
    fullName:
      'flushes older batched writes before a synchronous write and preserves read-after-write',
    sourceKey: 'src/dom/tests/write-queue.browser.test.ts:43:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: writeQueueFile,
    fullName: 'parses queued output before a subsequent fitted resize',
    sourceKey: 'src/dom/tests/write-queue.browser.test.ts:58:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: writeQueueFile,
    fullName: 'cancels queued output without parsing it',
    sourceKey: 'src/dom/tests/write-queue.browser.test.ts:79:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: writeQueueFile,
    fullName: 'serializes a data-callback write behind older batched output',
    sourceKey: 'src/dom/tests/write-queue.browser.test.ts:97:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: writeQueueFile,
    fullName: 'rejects every unparsed batched write on disposal',
    sourceKey: 'src/dom/tests/write-queue.browser.test.ts:114:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

export const presentationFile = fileURLToPath(
  new URL('../src/dom/tests/presentation.browser.test.ts', import.meta.url),
)

export const presentationCases = [
  {
    file: presentationFile,
    fullName: 'paints an immediate write before the next frame (undefined)',
    sourceKey: 'src/dom/tests/presentation.browser.test.ts:37:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: presentationFile,
    fullName: 'paints an immediate write before the next frame (canvas2d-fill-text)',
    sourceKey: 'src/dom/tests/presentation.browser.test.ts:37:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: presentationFile,
    fullName: 'waits for the frame by default',
    sourceKey: 'src/dom/tests/presentation.browser.test.ts:57:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

export const scrollbarAsyncFile = fileURLToPath(
  new URL('../src/dom/tests/scrollbar-async.browser.test.ts', import.meta.url),
)

export const scrollbarAsyncCases = [
  {
    file: scrollbarAsyncFile,
    fullName: 'keeps scroll event ownership synchronous and observes a delayed transport failure',
    sourceKey: 'src/dom/tests/scrollbar-async.browser.test.ts:11:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
