import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import type { FrameworkResult } from 'waffle/testing/page-runner/framework'

const monotonicNow = performance.now.bind(performance)
const schedule = setTimeout
const unschedule = clearTimeout

type Settlement = 'pending' | 'fulfilled' | 'rejected'
type Resource = {
  readonly kind: 'context' | 'execution' | 'fixture' | 'dispatcher'
  readonly identity: string
  settlement: Settlement
  closeRequests: number
  closeInvocations: number
}
type Dispatcher = Pick<Agent, 'close'>
type OwnedContext = { close(): Promise<void> }
export type ReportingOwnership = {
  readonly status: 'confirmed' | 'unconfirmed'
  readonly exit: number
  readonly cleanupDeadlineAt: number
  readonly observedAt: number
  readonly resources: readonly Readonly<Resource>[]
  readonly sdkUnconfirmed: readonly string[]
}

export class ReportingNodeOwner {
  private readonly resources: Resource[] = []
  private context: { actual: OwnedContext; resource: Resource; closing?: Promise<void> } | undefined
  private readonly dispatcher: Dispatcher
  private readonly dispatcherResource: Resource
  private readonly restore: () => void
  private returned = false
  private closingDispatcher: Promise<void> | undefined
  private finishing: Promise<ReportingOwnership> | undefined

  constructor(
    private readonly now: () => number = monotonicNow,
    transport?: { actual: Dispatcher; identity: string; restore(): void },
  ) {
    if (transport) {
      this.dispatcher = transport.actual
      this.restore = transport.restore
      this.dispatcherResource = this.add('dispatcher', transport.identity)
      return
    }
    const previous = getGlobalDispatcher()
    const actual = new Agent()
    setGlobalDispatcher(actual)
    this.dispatcher = actual
    this.restore = () => setGlobalDispatcher(previous)
    this.dispatcherResource = this.add('dispatcher', `undici-agent:${process.pid}`)
  }

  ownContext(actual: OwnedContext, identity: string): void {
    if (this.context) throw new Error('Actual context already registered')
    this.context = { actual, resource: this.add('context', identity) }
  }

  readonly closeContext = (): Promise<void> => {
    const context = this.context
    if (!context) return Promise.resolve()
    context.resource.closeRequests++
    if (context.closing) return context.closing
    context.resource.closeInvocations++
    const ticket = Promise.withResolvers<void>()
    context.closing = ticket.promise
    this.observe(ticket.promise, context.resource)
    try {
      ticket.resolve(context.actual.close())
    } catch (error) {
      ticket.reject(error)
    }
    return ticket.promise
  }

  ownExecution<T>(actual: Promise<T>, identity: string): Promise<T> {
    this.observe(actual, this.add('execution', identity))
    return actual
  }

  ownFixture<T>(actual: Promise<T>, identity: string): Promise<T> {
    this.observe(actual, this.add('fixture', identity))
    return actual
  }

  finish(result: FrameworkResult): Promise<ReportingOwnership> {
    if (this.finishing) return this.finishing
    this.returned = true
    this.finishing = Promise.resolve().then(() => this.finishOnce(result))
    return this.finishing
  }

  observations(): readonly Readonly<Resource>[] {
    return this.resources.map((resource) => ({ ...resource }))
  }

  private add(kind: Resource['kind'], identity: string): Resource {
    const resource: Resource = {
      kind,
      identity,
      settlement: 'pending',
      closeRequests: 0,
      closeInvocations: 0,
    }
    this.resources.push(resource)
    return resource
  }

  private observe(actual: Promise<unknown>, resource: Resource): void {
    void actual.then(
      () => {
        resource.settlement = 'fulfilled'
      },
      () => {
        resource.settlement = 'rejected'
      },
    )
  }

  private closeDispatcher(): Promise<void> {
    if (!this.returned) throw new Error('Host still owns session deletion')
    if (this.closingDispatcher) return this.closingDispatcher
    const ticket = Promise.withResolvers<void>()
    this.closingDispatcher = ticket.promise
    this.dispatcherResource.closeRequests++
    this.dispatcherResource.closeInvocations++
    this.observe(ticket.promise, this.dispatcherResource)
    try {
      ticket.resolve(this.dispatcher.close())
    } catch (error) {
      ticket.reject(error)
    }
    return ticket.promise
  }

  private async finishOnce(result: FrameworkResult): Promise<ReportingOwnership> {
    try {
      const closing = this.closeDispatcher()
      await this.remaining(closing, result.cleanupDeadlineAt)
      const resources = this.observations()
      const sdkUnconfirmed = Object.entries(result.cleanup)
        .filter(([, step]) => typeof step === 'object' && step.status === 'unconfirmed')
        .map(([name]) => name)
      const confirmed =
        sdkUnconfirmed.length === 0 && resources.every((item) => item.settlement === 'fulfilled')
      return Object.freeze({
        status: confirmed ? 'confirmed' : 'unconfirmed',
        exit: confirmed ? result.exit : 2,
        cleanupDeadlineAt: result.cleanupDeadlineAt,
        observedAt: this.now(),
        resources: Object.freeze(resources.map((item) => Object.freeze(item))),
        sdkUnconfirmed: Object.freeze(sdkUnconfirmed),
      })
    } finally {
      this.restore()
    }
  }

  private async remaining(actual: Promise<void>, deadlineAt: number): Promise<void> {
    const ms = deadlineAt - this.now()
    if (ms <= 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        actual.catch(() => {}),
        new Promise<void>((resolve) => {
          timer = schedule(resolve, ms)
        }),
      ])
    } finally {
      unschedule(timer)
    }
  }
}
