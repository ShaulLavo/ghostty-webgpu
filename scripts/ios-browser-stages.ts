import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'
import type { NativeStage } from './ios-browser-options.ts'
import { viewportCases, viewportFile } from './ios-browser-cases.ts'
import { bulkSnapshotCases, bulkSnapshotFile } from './ios-browser-next-cases.ts'

export const frameworkStageFile = fileURLToPath(
  new URL('./ios-browser-stage.browser.test.ts', import.meta.url),
)
const frameworkStageCases = [
  {
    file: frameworkStageFile,
    fullName: 'framework staging > completes normal hooks and logical viewport',
    sourceKey: 'scripts/ios-browser-stage.browser.test.ts::normal lifecycle',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

export function nativeStage(stage: NativeStage): {
  file: string
  expected: readonly ExpectedCase[]
} {
  if (stage === 'synthetic') return { file: frameworkStageFile, expected: frameworkStageCases }
  if (stage === 'bulk-snapshot') return { file: bulkSnapshotFile, expected: bulkSnapshotCases }
  return { file: viewportFile, expected: viewportCases }
}
