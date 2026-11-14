import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const selectionWorkerOwnershipFile = fileURLToPath(
  new URL('../src/dom/tests/selection-worker-ownership.browser.test.ts', import.meta.url),
)

export const selectionWorkerOwnershipCases = [
  {
    file: selectionWorkerOwnershipFile,
    fullName: 'keeps real packaged native ownership when cancel interrupts a stale pending release',
    sourceKey: 'src/dom/tests/selection-worker-ownership.browser.test.ts:13:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectionWorkerOwnershipFile,
    fullName:
      'keeps real packaged native ownership when dispose interrupts a stale pending release',
    sourceKey: 'src/dom/tests/selection-worker-ownership.browser.test.ts:13:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectionWorkerOwnershipFile,
    fullName:
      'keeps real packaged native ownership when new press interrupts a stale pending release',
    sourceKey: 'src/dom/tests/selection-worker-ownership.browser.test.ts:13:2',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
