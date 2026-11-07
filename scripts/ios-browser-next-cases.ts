import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const bulkSnapshotFile = fileURLToPath(
  new URL('../src/core/tests/bulk-snapshot.browser.test.ts', import.meta.url),
)

export const bulkSnapshotCases = [
  {
    file: bulkSnapshotFile,
    fullName:
      'keeps packed/per-cell parity across default styles, palette changes, and screen switches',
    sourceKey: 'src/core/tests/bulk-snapshot.browser.test.ts:5:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
