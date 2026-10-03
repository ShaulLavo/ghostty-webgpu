import { expectTypeOf, it } from 'vitest'
import type { Terminal } from '../../index.js'
import type { TerminalApi } from '../../dom/terminal-api.js'
import type { TerminalLine } from '../../core/types.js'
import type {
  Contributions,
  Extension,
  ExtensionHandle,
  ExtensionInput,
  ExtensionScope,
} from '../types.js'

interface ReaderApi {
  read(): Promise<string>
}

async function readAuthority(
  terminal: ExtensionScope['terminal'],
): Promise<readonly TerminalLine[]> {
  return await terminal.readLines(0, await terminal.lineCount())
}

it('accepts both execution entries and lets extensions await authoritative reads', () => {
  expectTypeOf<Terminal>().toExtend<ExtensionScope['terminal']>()
  expectTypeOf<TerminalApi<'sync'>>().toExtend<ExtensionScope['terminal']>()
  expectTypeOf<TerminalApi<'async'>>().toExtend<ExtensionScope['terminal']>()
  expectTypeOf<Awaited<ReturnType<TerminalApi['lineCount']>>>().toEqualTypeOf<number>()
  expectTypeOf<Awaited<ReturnType<TerminalApi['readLines']>>>().toEqualTypeOf<
    readonly TerminalLine[]
  >()
  expectTypeOf<ReturnType<typeof readAuthority>>().toEqualTypeOf<Promise<readonly TerminalLine[]>>()
})

it('requires non-void extension APIs while allowing inert void extensions', () => {
  expectTypeOf<{}>().toExtend<Contributions<void>>()
  expectTypeOf<{}>().not.toExtend<Contributions<ReaderApi>>()
  expectTypeOf<{ api: ReaderApi }>().toExtend<Contributions<ReaderApi>>()
  expectTypeOf<ExtensionHandle<ReaderApi>['api']>().toEqualTypeOf<ReaderApi>()
  expectTypeOf<ExtensionScope['terminal']>().toEqualTypeOf<TerminalApi>()
  expectTypeOf<readonly [Extension, readonly [Extension<ReaderApi>]]>().toExtend<
    readonly ExtensionInput[]
  >()
})
