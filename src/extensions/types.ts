import type { TerminalApi } from '../dom/terminal-api.js'
import type { GhosttyWebGpuTerminalEventMap } from '../dom/types.js'
import type { LinkProvider } from '../term/links.js'
import type { TerminalInputData, TerminalKeyInput } from '../term/types.js'

export type TerminalInputEvent =
  | { readonly type: 'key'; readonly event: KeyboardEvent }
  | { readonly type: 'key'; readonly input: TerminalKeyInput }
  | { readonly type: 'paste' | 'text'; readonly data: TerminalInputData }
  | { readonly type: 'composition'; readonly text: string }

export type TerminalInputHandler = (event: TerminalInputEvent) => 'claim' | 'pass'

type TerminalEventHandlers = {
  readonly [Event in keyof GhosttyWebGpuTerminalEventMap]?: (
    event: GhosttyWebGpuTerminalEventMap[Event],
  ) => void
}

export interface OscEvent {
  readonly number: number
  readonly payload: string
  readonly terminator: 'bel' | 'st'
  readonly truncated: boolean
}

export type OscObserver = (event: OscEvent) => void
export type TerminalCommand = () => void | Promise<void>

export interface ExtensionScope {
  readonly terminal: TerminalApi
  readonly signal: AbortSignal
  own(cleanup: () => void): void
}

interface Hooks {
  readonly input?: TerminalInputHandler
  readonly events?: TerminalEventHandlers
  readonly osc?: Readonly<Record<number, OscObserver>>
  readonly links?: LinkProvider<Event>
  readonly commands?: Readonly<Record<string, TerminalCommand>>
}

export type Contributions<Api = void> = Hooks &
  ([Api] extends [void] ? { readonly api?: Api } : { readonly api: Api })

export interface Extension<Api = void> {
  readonly name: string
  setup(scope: ExtensionScope): Contributions<Api>
}

export type ExtensionValue = Extension<void> | Extension<unknown>
export type ExtensionInput = ExtensionValue | readonly ExtensionInput[]

export interface ExtensionHandle<Api = void> {
  readonly api: Api
  dispose(): void
}
