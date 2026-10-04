import { createGhosttyError } from '../core/error.js'
import type { TerminalApi } from '../dom/terminal-api.js'
import type { GhosttyWebGpuTerminalEventMap } from '../dom/types.js'
import type { LinkProvider, LinkProviderRegistration } from '../term/links.js'
import type {
  Contributions,
  Extension,
  ExtensionHandle,
  ExtensionInput,
  ExtensionScope,
  ExtensionValue,
  OscEvent,
  OscObserver,
  TerminalCommand,
  TerminalInputEvent,
  TerminalInputHandler,
} from './types.js'

type EventType = keyof GhosttyWebGpuTerminalEventMap
type EventHandler = (event: unknown) => unknown
type ErrorSink = (cause: unknown, operation: string) => void

interface HookNode<Handler> {
  active: boolean
  readonly handler: Handler
  next?: HookNode<Handler>
  readonly order: number
  previous?: HookNode<Handler>
}

class HookList<Handler> {
  first?: HookNode<Handler>
  last?: HookNode<Handler>
  private order = 0

  append(handler: Handler): () => void {
    const node: HookNode<Handler> = {
      active: true,
      handler,
      order: ++this.order,
      previous: this.last,
    }
    if (this.last) this.last.next = node
    if (!this.first) this.first = node
    this.last = node
    return () => this.remove(node)
  }

  private remove(node: HookNode<Handler>): void {
    if (!node.active) return
    node.active = false
    if (node.previous) node.previous.next = node.next
    if (node.next) node.next.previous = node.previous
    if (this.first === node) this.first = node.next
    if (this.last === node) this.last = node.previous
    // A dispatch may hold a removed successor, so retain its forward path until that dispatch ends.
    node.previous = undefined
  }
}

function invokeHandler<Payload>(handler: (event: Payload) => unknown, event: Payload): unknown {
  return handler(event)
}

function observeResult(result: unknown, onError: ErrorSink, operation: string): void {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return
  if (typeof (result as PromiseLike<unknown>).then !== 'function') return
  void Promise.resolve(result).catch((cause: unknown) => onError(cause, operation))
}

function dispatch<Handler, Payload>(
  list: HookList<Handler>,
  payload: Payload,
  invoke: (handler: Handler, payload: Payload) => unknown,
  onError: ErrorSink,
  operation: string,
  firstClaim = false,
): boolean {
  const boundary = list.last?.order ?? 0
  let node = list.first
  while (node && node.order <= boundary) {
    const next = node.next
    if (!node.active) {
      node = next
      continue
    }
    try {
      const result = invoke(node.handler, payload)
      if (firstClaim && result === 'claim') return true
      observeResult(result, onError, operation)
    } catch (cause) {
      onError(cause, operation)
    }
    node = next
  }
  return false
}

function validateFunction(value: unknown, kind: string): void {
  if (typeof value === 'function') return
  throw createGhosttyError('extension.use', `${kind} contribution must be a function`)
}

interface AttachmentIdentity {
  current?: Attachment
}

class Attachment implements ExtensionScope, ExtensionHandle<unknown> {
  api: unknown
  next?: Attachment
  previous?: Attachment
  private controller?: AbortController
  private owned?: (() => void)[]
  private registrations?: (() => void)[]
  private state: 'setup' | 'attached' | 'disposed' = 'setup'

  constructor(
    private readonly manager: ExtensionManager,
    readonly identity: AttachmentIdentity,
  ) {}

  get terminal(): TerminalApi {
    return this.manager.terminal
  }

  get signal(): AbortSignal {
    if (!this.controller) {
      this.controller = new AbortController()
      if (this.state === 'disposed') this.controller.abort()
    }
    return this.controller.signal
  }

  get disposed(): boolean {
    return this.state === 'disposed'
  }

  own(cleanup: () => void): void {
    validateFunction(cleanup, 'Cleanup')
    if (this.disposed) {
      this.manager.clean(cleanup)
      return
    }
    ;(this.owned ??= []).push(cleanup)
  }

  register(cleanup: () => void): void {
    if (this.disposed) {
      cleanup()
      return
    }
    ;(this.registrations ??= []).push(cleanup)
  }

  complete(api: unknown): void {
    this.api = api
    this.state = 'attached'
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.state = 'disposed'
    this.manager.detach(this)
    const registrations = this.registrations
    this.registrations = undefined
    if (registrations) {
      for (let index = registrations.length - 1; index >= 0; index -= 1) registrations[index]!()
    }
    this.controller?.abort()
    const owned = this.owned
    this.owned = undefined
    if (!owned) return
    for (let index = owned.length - 1; index >= 0; index -= 1) this.manager.clean(owned[index]!)
  }
}

export interface ExtensionManagerOptions {
  readonly terminal: TerminalApi
  readonly reservedOsc?: ReadonlySet<number>
  readonly registerLinkProvider?: (provider: LinkProvider<Event>) => LinkProviderRegistration
  readonly onError: ErrorSink
}

export class ExtensionManager {
  readonly terminal: TerminalApi
  // Reattachment reuses a weak identity slot, avoiding key-table rebuilds beside inert values.
  private readonly identities = new WeakMap<ExtensionValue, AttachmentIdentity>()
  private readonly input = new HookList<TerminalInputHandler>()
  private readonly events = new Map<EventType, HookList<EventHandler>>()
  private readonly osc = new Map<number, OscObserver>()
  private readonly commands = new Map<string, TerminalCommand>()
  private readonly links = new HookList<LinkProvider<Event>>()
  private last?: Attachment
  private disposed = false

  constructor(private readonly options: ExtensionManagerOptions) {
    this.terminal = options.terminal
  }

  get hasInput(): boolean {
    return this.input.first !== undefined
  }

  hasEvent(type: EventType): boolean {
    return this.events.has(type)
  }

  hasOsc(number: number): boolean {
    return this.osc.has(number)
  }

  use<Api = void>(extension: Extension<Api>): ExtensionHandle<Api> {
    this.ensureActive()
    const value = extension as ExtensionValue
    let identity = this.identities.get(value)
    if (!identity) {
      identity = {}
      this.identities.set(value, identity)
    }
    if (identity.current) {
      throw createGhosttyError('extension.use', `Extension ${extension.name} is already attached`)
    }
    const attachment = new Attachment(this, identity)
    identity.current = attachment
    attachment.previous = this.last
    if (this.last) this.last.next = attachment
    this.last = attachment
    try {
      const contributions = extension.setup(attachment)
      this.ensureActive()
      if (attachment.disposed) {
        throw createGhosttyError('extension.use', 'Extension was disposed during setup')
      }
      this.publish(attachment, contributions)
      return attachment as ExtensionHandle<Api>
    } catch (cause) {
      attachment.dispose()
      this.reportError(cause, 'extension.setup')
      throw cause
    }
  }

  install(values: readonly ExtensionInput[]): void {
    this.ensureActive()
    const handles: ExtensionHandle<unknown>[] = []
    try {
      this.installValues(values, handles)
    } catch (cause) {
      for (let index = handles.length - 1; index >= 0; index -= 1) handles[index]!.dispose()
      throw cause
    }
  }

  private installValues(
    values: readonly ExtensionInput[],
    handles: ExtensionHandle<unknown>[],
  ): void {
    for (const value of values) {
      if (Array.isArray(value)) {
        this.installValues(value, handles)
        continue
      }
      handles.push(this.use(value as ExtensionValue))
    }
  }

  dispatchInput(event: TerminalInputEvent): boolean {
    return dispatch(this.input, event, invokeHandler, this.reportError, 'extension.input', true)
  }

  emit<Type extends EventType>(
    type: Type,
    payload: () => GhosttyWebGpuTerminalEventMap[Type],
  ): void {
    const list = this.events.get(type)
    if (!list) return
    dispatch(list, payload(), invokeHandler, this.reportError, 'extension.event')
  }

  observeOsc(number: number, payload: () => OscEvent): void {
    const observer = this.osc.get(number)
    if (!observer) return
    try {
      observeResult(observer(payload()), this.reportError, 'extension.osc')
    } catch (cause) {
      this.reportError(cause, 'extension.osc')
    }
  }

  command(name: string): TerminalCommand | undefined {
    return this.commands.get(name)
  }

  visitLinks(visitor: (provider: LinkProvider<Event>) => void): void {
    dispatch(this.links, visitor, invokeLinkVisitor, this.reportError, 'extension.links')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    while (this.last) this.last.dispose()
  }

  detach(attachment: Attachment): void {
    attachment.identity.current = undefined
    if (attachment.previous) attachment.previous.next = attachment.next
    if (attachment.next) attachment.next.previous = attachment.previous
    if (this.last === attachment) this.last = attachment.previous
    attachment.previous = undefined
    attachment.next = undefined
  }

  clean(cleanup: () => void): void {
    try {
      observeResult(cleanup(), this.reportError, 'extension.cleanup')
    } catch (cause) {
      this.reportError(cause, 'extension.cleanup')
    }
  }

  readonly reportError: ErrorSink = (cause, operation) => {
    try {
      this.options.onError(cause, operation)
    } catch {
      return
    }
  }

  private ensureActive(): void {
    if (!this.disposed) return
    throw createGhosttyError('extension.use', 'Extension manager is disposed')
  }

  private publish(
    attachment: Attachment,
    contributions: Contributions<unknown> | Contributions<void>,
  ): void {
    const {
      api,
      input,
      links,
      events: eventHooks,
      osc: oscHooks,
      commands: commandHooks,
    } = contributions
    const osc = oscHooks && Object.entries(oscHooks)
    const commands = commandHooks && Object.entries(commandHooks)
    const events = eventHooks && Object.entries(eventHooks)
    if (events) for (const [, handler] of events) validateFunction(handler, 'Event')
    if (input) validateFunction(input, 'Input')
    if (links) validateFunction(links.provideLinks, 'Links')
    // Contribution getters can attach another owner; check conflicts after all property reads.
    if (osc) this.validateOsc(osc)
    if (commands) this.validateCommands(commands)
    this.ensureActive()
    if (attachment.disposed)
      throw createGhosttyError('extension.use', 'Extension was disposed during setup')
    if (input) attachment.register(this.input.append(input))
    if (events)
      for (const [type, handler] of events)
        this.registerEvent(attachment, type as EventType, handler as EventHandler)
    if (osc)
      for (const [key, handler] of osc) {
        const number = Number(key)
        this.osc.set(number, handler)
        attachment.register(() => this.osc.delete(number))
      }
    if (commands)
      for (const [name, command] of commands) {
        this.commands.set(name, command)
        attachment.register(() => this.commands.delete(name))
      }
    if (links) {
      const registration = this.options.registerLinkProvider?.(links)
      if (registration) attachment.register(() => registration.dispose())
      this.ensureActive()
      if (attachment.disposed)
        throw createGhosttyError('extension.use', 'Extension was disposed during setup')
      attachment.register(this.links.append(links))
    }
    attachment.complete(api)
  }

  private validateOsc(entries: readonly [string, OscObserver][]): void {
    const reserved = this.options.reservedOsc
    if (entries.length > 0 && !reserved) {
      throw createGhosttyError('extension.use', 'Custom OSC observation is unavailable')
    }
    for (const [key, observer] of entries) {
      const number = Number(key)
      if (!Number.isSafeInteger(number) || number < 0 || String(number) !== key) {
        throw createGhosttyError('extension.use', 'OSC number must be a non-negative safe integer')
      }
      if (reserved?.has(number) || this.osc.has(number)) {
        throw createGhosttyError('extension.use', `OSC ${number} already has an owner`)
      }
      validateFunction(observer, 'OSC')
    }
  }

  private validateCommands(entries: readonly [string, TerminalCommand][]): void {
    for (const [name, command] of entries) {
      if (name.length === 0 || this.commands.has(name)) {
        throw createGhosttyError('extension.use', `Command ${name} already has an owner`)
      }
      validateFunction(command, 'Command')
    }
  }

  private registerEvent(attachment: Attachment, type: EventType, handler: EventHandler): void {
    let list = this.events.get(type)
    if (!list) {
      list = new HookList<EventHandler>()
      this.events.set(type, list)
    }
    const remove = list.append(handler)
    attachment.register(() => {
      remove()
      if (!list.first) this.events.delete(type)
    })
  }
}

function invokeLinkVisitor(
  provider: LinkProvider<Event>,
  visitor: (provider: LinkProvider<Event>) => void,
): unknown {
  return visitor(provider)
}
