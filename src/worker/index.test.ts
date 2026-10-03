import { expect, expectTypeOf, it } from 'vitest'
import {
  Terminal,
  TerminalWorkerError,
  type TerminalApi,
  type TerminalResult,
  type TerminalSubmittedFrame,
  type TerminalOutputMessage,
  type TerminalOutputReady,
  type TerminalOutputAck,
  type WorkerTerminalOptions,
  type WorkerAssets,
  type WorkerBackend,
  type WorkerFontFace,
} from './index.js'
import type { TerminalMutationResult } from '../term/types.js'
import type { TerminalGeometry, TerminalTextMeasurement } from '../core/types.js'

it('exports the concrete worker factory and its asynchronous authority contract', () => {
  expect(typeof Terminal.create).toBe('function')
  expect(typeof TerminalWorkerError).toBe('function')
  expectTypeOf<ReturnType<typeof Terminal.create>>().toEqualTypeOf<Promise<Terminal>>()
  expectTypeOf<Terminal>().toExtend<TerminalApi<'async'>>()
  expectTypeOf<ReturnType<Terminal['write']>>().toEqualTypeOf<
    TerminalResult<'async', TerminalMutationResult>
  >()
  expectTypeOf<ReturnType<Terminal['geometry']>>().toEqualTypeOf<Promise<TerminalGeometry>>()
  expectTypeOf<ReturnType<Terminal['measure']>>().toEqualTypeOf<Promise<number>>()
  expectTypeOf<ReturnType<Terminal['measureTexts']>>().toEqualTypeOf<
    Promise<TerminalTextMeasurement>
  >()
  expectTypeOf<Parameters<Terminal['measureTexts']>[0]>().toEqualTypeOf<readonly string[]>()
  expectTypeOf<ReturnType<Terminal['writeAndReadGeometry']>>().toEqualTypeOf<
    Promise<TerminalGeometry>
  >()
  expectTypeOf<ReturnType<Terminal['dispose']>>().toEqualTypeOf<Promise<void>>()
  expectTypeOf<Terminal['submittedFrame']>().toEqualTypeOf<TerminalSubmittedFrame | undefined>()
  expectTypeOf<WorkerTerminalOptions['assets']>().toEqualTypeOf<WorkerAssets | undefined>()
  expectTypeOf<WorkerTerminalOptions['backend']>().toEqualTypeOf<WorkerBackend | undefined>()
  expectTypeOf<WorkerTerminalOptions['fonts']>().toEqualTypeOf<readonly WorkerFontFace[]>()
})

it('exports producer identities, transferred bytes and sequence acknowledgements', () => {
  expectTypeOf<TerminalOutputMessage['data']>().toEqualTypeOf<Uint8Array>()
  expectTypeOf<TerminalOutputReady>().toEqualTypeOf<{
    readonly type: 'ready'
    readonly terminal: string
    readonly generation: number
  }>()
  expectTypeOf<TerminalOutputAck>().toEqualTypeOf<{
    readonly type: 'output-ack'
    readonly terminal: string
    readonly generation: number
    readonly sequence: number
  }>()
})
