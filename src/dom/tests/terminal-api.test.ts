import type { TerminalGeometry, TerminalTextMeasurement } from '../../core/types.js'
import { describe, expectTypeOf, it } from 'vitest'
import type { TerminalInputResult, TerminalMutationResult } from '../../term/types.js'
import type { TerminalApi, TerminalResult } from '../terminal-api.js'
import type { TerminalInputConnection } from '../types.js'
import type { Terminal } from '../terminal.js'
import type { Extension, ExtensionHandle } from '../../extensions/types.js'

// These assertions are checked by tsc; no worker or native session is created.
describe('shared terminal return convention', () => {
  it('matches the concrete synchronous main entry', () => {
    expectTypeOf<Terminal>().toExtend<TerminalApi<'sync'>>()
    expectTypeOf<ReturnType<TerminalApi<'sync'>['write']>>().toEqualTypeOf<TerminalMutationResult>()
    expectTypeOf<ReturnType<TerminalApi<'sync'>['key']>>().toEqualTypeOf<TerminalInputResult>()
    expectTypeOf<
      ReturnType<TerminalApi<'sync'>['connectInput']>
    >().toEqualTypeOf<TerminalInputConnection>()
    expectTypeOf<ReturnType<TerminalApi<'async'>['connectInput']>>().toEqualTypeOf<
      Promise<TerminalInputConnection>
    >()
    expectTypeOf<ReturnType<TerminalApi<'sync'>['dispose']>>().toEqualTypeOf<void>()
  })

  it('acknowledges worker authority asynchronously and permits await-style common callers', () => {
    expectTypeOf<ReturnType<TerminalApi<'async'>['write']>>().toEqualTypeOf<
      Promise<TerminalMutationResult>
    >()
    expectTypeOf<ReturnType<TerminalApi['write']>>().toEqualTypeOf<
      TerminalMutationResult | Promise<TerminalMutationResult>
    >()
    expectTypeOf<ReturnType<TerminalApi['readLines']>>().toEqualTypeOf<
      TerminalResult<'sync' | 'async', ReturnType<Terminal['readLines']>>
    >()
    expectTypeOf<ReturnType<TerminalApi['getSelection']>>().toEqualTypeOf<
      string | undefined | Promise<string | undefined>
    >()
    expectTypeOf<ReturnType<TerminalApi['dispose']>>().toEqualTypeOf<void | Promise<void>>()
    expectTypeOf<ReturnType<TerminalApi<'sync'>['geometry']>>().toEqualTypeOf<TerminalGeometry>()
    expectTypeOf<ReturnType<TerminalApi<'async'>['geometry']>>().toEqualTypeOf<
      Promise<TerminalGeometry>
    >()
    expectTypeOf<ReturnType<TerminalApi<'async'>['measureTexts']>>().toEqualTypeOf<
      Promise<TerminalTextMeasurement>
    >()
    expectTypeOf<Parameters<TerminalApi['measureTexts']>[0]>().toEqualTypeOf<readonly string[]>()
    expectTypeOf<ReturnType<TerminalApi<'async'>['writeAndReadGeometry']>>().toEqualTypeOf<
      Promise<TerminalGeometry>
    >()
  })

  it('preserves host methods and inherent asynchronous methods in both entries', () => {
    expectTypeOf<ReturnType<TerminalApi['on']>>().toEqualTypeOf<ReturnType<Terminal['on']>>()
    expectTypeOf<ReturnType<TerminalApi['focus']>>().toEqualTypeOf<void>()
    expectTypeOf<Terminal<'async'>>().toExtend<TerminalApi<'async'>>()
    expectTypeOf<TerminalApi<'sync'>['use']>().toEqualTypeOf<
      <Api = void>(extension: Extension<Api>) => ExtensionHandle<Api>
    >()
    expectTypeOf<TerminalApi<'async'>['use']>().toEqualTypeOf<
      <Api = void>(extension: Extension<Api>) => Promise<ExtensionHandle<Api>>
    >()
    expectTypeOf<TerminalApi['element']>().toEqualTypeOf<Terminal['element']>()
    expectTypeOf<ReturnType<TerminalApi['visibleLines']>>().toEqualTypeOf<readonly string[]>()
    expectTypeOf<ReturnType<TerminalApi['open']>>().toEqualTypeOf<Promise<void>>()
    expectTypeOf<ReturnType<TerminalApi['focusNextLink']>>().toEqualTypeOf<Promise<boolean>>()
  })
})
