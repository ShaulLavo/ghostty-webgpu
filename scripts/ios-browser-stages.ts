import {
  workerWriteQueueCases,
  workerWriteQueueFile,
} from './ios-browser-worker-write-queue-cases.ts'
import { managedFallbackCases, managedFallbackFile } from './ios-browser-fallback-cases.ts'
import { uiDeclarationsCases, uiDeclarationsFile } from './ios-browser-ui-declarations-cases.ts'
import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'
import { outputTimingCases, outputTimingFile } from './ios-browser-output-timing-cases.ts'
import { macKeybindingsCases, macKeybindingsFile } from './ios-browser-mac-keybindings-cases.ts'
import { ghosttyKeymapCases, ghosttyKeymapFile } from './ios-browser-hotkeys-cases.ts'
import { domAppearanceCases, domAppearanceFile } from './ios-browser-dom-appearance-cases.ts'
import { mountedScrollCases, mountedScrollFile } from './ios-browser-mounted-cases.ts'
import { pixelDamageCases, pixelDamageFile } from './ios-browser-damage-cases.ts'
import { stampCacheCases, stampCacheFile } from './ios-browser-stamp-cases.ts'
import type { NativeStage } from './ios-browser-options.ts'
import { canvasRasterizerCases, canvasRasterizerFile } from './ios-browser-rasterizer-cases.ts'
import { fontGeometryCases, fontGeometryFile } from './ios-browser-geometry-cases.ts'
import { fontFixtureCases, fontFixtureFile } from './ios-browser-fixture-cases.ts'
import { moduleMockCases, moduleMockFile } from './ios-browser-module-cases.ts'
import { viewportCases, viewportFile } from './ios-browser-cases.ts'
import { bulkSnapshotCases, bulkSnapshotFile } from './ios-browser-next-cases.ts'
import { fontResourcesCases, fontResourcesFile } from './ios-browser-font-cases.ts'

import {
  writeQueueCases,
  writeQueueFile,
  presentationCases,
  presentationFile,
  scrollbarAsyncCases,
  scrollbarAsyncFile,
} from './ios-browser-async-cases.ts'
import { measurementCases, measurementFile } from './ios-browser-measurement-cases.ts'

import {
  historyCases,
  historyFile,
  readlineLayoutCases,
  readlineLayoutFile,
} from './ios-browser-text-cases.ts'

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
  if (stage === 'worker-write-queue')
    return { file: workerWriteQueueFile, expected: workerWriteQueueCases }
  if (stage === 'managed-fallback')
    return { file: managedFallbackFile, expected: managedFallbackCases }
  if (stage === 'ui-declarations')
    return { file: uiDeclarationsFile, expected: uiDeclarationsCases }
  if (stage === 'output-timing') return { file: outputTimingFile, expected: outputTimingCases }
  if (stage === 'mac-keybindings')
    return { file: macKeybindingsFile, expected: macKeybindingsCases }
  if (stage === 'ghostty-keymap') return { file: ghosttyKeymapFile, expected: ghosttyKeymapCases }
  if (stage === 'dom-appearance') return { file: domAppearanceFile, expected: domAppearanceCases }
  if (stage === 'mounted-scroll') return { file: mountedScrollFile, expected: mountedScrollCases }
  if (stage === 'pixel-damage') return { file: pixelDamageFile, expected: pixelDamageCases }
  if (stage === 'stamp-cache') return { file: stampCacheFile, expected: stampCacheCases }
  if (stage === 'canvas-rasterizer')
    return { file: canvasRasterizerFile, expected: canvasRasterizerCases }
  if (stage === 'font-geometry') return { file: fontGeometryFile, expected: fontGeometryCases }
  if (stage === 'font-fixture') return { file: fontFixtureFile, expected: fontFixtureCases }
  if (stage === 'module-mock') return { file: moduleMockFile, expected: moduleMockCases }
  if (stage === 'history') return { file: historyFile, expected: historyCases }
  if (stage === 'readline-layout')
    return { file: readlineLayoutFile, expected: readlineLayoutCases }
  if (stage === 'write-queue') return { file: writeQueueFile, expected: writeQueueCases }
  if (stage === 'presentation') return { file: presentationFile, expected: presentationCases }
  if (stage === 'scrollbar-async')
    return { file: scrollbarAsyncFile, expected: scrollbarAsyncCases }
  if (stage === 'synthetic') return { file: frameworkStageFile, expected: frameworkStageCases }
  if (stage === 'measurement') return { file: measurementFile, expected: measurementCases }
  if (stage === 'font-resources') return { file: fontResourcesFile, expected: fontResourcesCases }
  if (stage === 'bulk-snapshot') return { file: bulkSnapshotFile, expected: bulkSnapshotCases }
  return { file: viewportFile, expected: viewportCases }
}
