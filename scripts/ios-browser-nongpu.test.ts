import assert from 'node:assert/strict'
import { test } from 'vitest'
import { isNativeStage } from './ios-browser-options.ts'

for (const stage of ['legacy-text', 'pointer-selection', 'hotkeys-focus'])
  test(`${stage} is a registered whole-file native stage`, () => {
    assert(isNativeStage(stage))
  })
