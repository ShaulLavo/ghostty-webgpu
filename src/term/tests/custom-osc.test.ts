import { afterEach, expect, it } from 'vitest'
import { TerminalSession } from '../session.js'
import type { CustomOscObservation } from '../../core/types.js'

const sessions: TerminalSession[] = []
const decoder = new TextDecoder()

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
})

async function createSession(): Promise<TerminalSession> {
  const session = await TerminalSession.create({})
  sessions.push(session)
  return session
}

it('publishes native-owned observations after execution and committed state, before write completion', async () => {
  const session = await createSession()
  const subscription = session.subscribeCustomOsc(7400)
  const order: string[] = []
  session.on('customOSC', (event) => {
    expect(event.generation).toBe(subscription.generation)
    expect(session.geometry().graphemeClustering).toBe(true)
    order.push(`osc:${decoder.decode(event.payload)}:${session.revision}`)
  })
  session.on('renderRequest', (event) => order.push(`render:${event.revision}`))
  const result = session.write('\x1b[?2027h\x1b]7400;complete\x07')
  order.push(`return:${result.revision}`)
  expect(order).toEqual(['osc:complete:1', 'render:1', 'return:1'])
})

it('captures the generation at native execution and drops queued old captures on replacement', async () => {
  const session = await createSession()
  const previous = session.subscribeCustomOsc(7400)
  const events: CustomOscObservation[] = []
  session.on('customOSC', (event) => events.push(event))
  const bell = session.on('bell', () => {
    bell.dispose()
    previous.dispose()
    const next = session.subscribeCustomOsc(7400)
    expect(next.generation).toBeGreaterThan(previous.generation)
    session.write('\x1b]7400;new owner\x07')
  })
  session.write('\x07\x1b]7400;old owner\x07')
  expect(events.map((event) => decoder.decode(event.payload))).toEqual(['new owner'])
  expect(events[0]!.generation).toBeGreaterThan(previous.generation)
  previous.dispose()
  session.write('\x1b]7400;still new\x07')
  expect(events.map((event) => decoder.decode(event.payload))).toEqual(['new owner', 'still new'])
})

it('drops queued observations when their subscription detaches during earlier event publication', async () => {
  const session = await createSession()
  const subscription = session.subscribeCustomOsc(7400)
  const events: CustomOscObservation[] = []
  session.on('customOSC', (event) => events.push(event))
  session.on('bell', () => subscription.dispose())
  session.write('\x07\x1b]7400;captured before detach\x07')
  session.write('\x1b]7400;detached\x07')
  expect(events).toHaveLength(0)
})

it('supports reentrant observers only after the native write and isolates observer failures', async () => {
  const session = await createSession()
  session.subscribeCustomOsc(7400)
  const order: string[] = []
  const errors: string[] = []
  session.on('error', (event) => errors.push(event.operation))
  session.on('customOSC', (event) => {
    const text = decoder.decode(event.payload)
    order.push(`${text}:${session.revision}`)
    if (text !== 'outer') return
    const result = session.write('\x1b]7400;inner\x07')
    order.push(`inner return:${result.revision}`)
  })
  const throwing = session.on('customOSC', () => {
    throw 'observer failure'
  })
  const result = session.write('\x1b]7400;outer\x07')
  order.push(`outer return:${result.revision}`)
  expect(order).toEqual(['outer:1', 'inner:2', 'inner return:2', 'outer return:2'])
  expect(errors).toEqual(['event.customOSC', 'event.customOSC'])
  throwing.dispose()
  session.write('\x1b]7400;recovered\x07')
  expect(order.at(-1)).toBe('recovered:3')
})

it('preserves native reset and parser semantics and never publishes incomplete sequences on disposal', async () => {
  const session = await createSession()
  const subscription = session.subscribeCustomOsc(7400)
  const events: CustomOscObservation[] = []
  session.on('customOSC', (event) => events.push(event))
  session.write('\x1b]7400;partial')
  session.reset()
  session.write('abandoned\x07\x1b]7400;after reset\x07')
  expect(events.map((event) => decoder.decode(event.payload))).toEqual([
    'partialabandoned',
    'after reset',
  ])
  expect(events[0]!.generation).toBe(subscription.generation)
  session.write('\x1b]7400;unfinished')
  session.dispose()
  subscription.dispose()
  expect(events).toHaveLength(2)
})

it('suppresses remaining queued custom observations when an earlier observer disposes the session', async () => {
  const session = await createSession()
  session.subscribeCustomOsc(7400)
  const events: CustomOscObservation[] = []
  session.on('customOSC', (event) => events.push(event))
  session.on('bell', () => session.dispose())
  session.write('\x07\x1b]7400;obsolete\x07')
  expect(events).toHaveLength(0)
  expect(() => session.subscribeCustomOsc(7400)).toThrow('disposed')
})

it('bounds pending observation copies, reports overflow once and recovers on the next write', async () => {
  const session = await createSession()
  session.subscribeCustomOsc(7400)
  const events: CustomOscObservation[] = []
  const errors: string[] = []
  session.on('customOSC', (event) => events.push(event))
  session.on('error', (event) => errors.push(event.operation))
  session.write('\x1b]7400;x\x07'.repeat(1030))
  expect(events).toHaveLength(1024)
  expect(errors).toEqual(['customOSC.capture'])
  session.write('\x1b]7400;recovered\x07')
  expect(events).toHaveLength(1025)
  expect(decoder.decode(events.at(-1)!.payload)).toBe('recovered')
  expect(errors).toHaveLength(1)
})
