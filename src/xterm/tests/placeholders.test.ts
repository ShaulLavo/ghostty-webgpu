import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  EMPTY_MARKERS,
  Plan009UnavailableError,
  createBufferPlaceholder,
  createModesPlaceholder,
  createParserPlaceholder,
  createUnicodePlaceholder,
} from '../placeholders.js'
import type {
  IBufferNamespace,
  IModes,
  IParser,
  IUnicodeHandling,
  IUnicodeVersionProvider,
} from '../types.js'

const unavailableMessage = 'unavailable until Plan 009 provides native-backed extension surfaces'
const proposedApiMessage = 'You must set the allowProposedApi option to true to use proposed API'

const unicodeProvider: IUnicodeVersionProvider = {
  version: 'test',
  wcwidth: () => 1,
  charProperties: () => 0,
}

describe('xterm extension placeholders', () => {
  it('exposes one frozen empty marker array', () => {
    const first = EMPTY_MARKERS
    const second = EMPTY_MARKERS

    expect(first).toBe(second)
    expect(first).toEqual([])
    expect(Object.isFrozen(first)).toBe(true)
    expect(() => (first as unknown[]).push({})).toThrow(TypeError)
  })

  it('keeps a stable buffer namespace while rejecting unsupported reads and subscriptions', () => {
    const buffer = createBufferPlaceholder()

    expectTypeOf(buffer).toEqualTypeOf<IBufferNamespace>()
    expect(Object.isFrozen(buffer)).toBe(true)
    expect(buffer).toBe(buffer)
    expect(() => buffer.active).toThrow(unavailableMessage)
    expect(() => buffer.normal).toThrow(unavailableMessage)
    expect(() => buffer.alternate).toThrow(unavailableMessage)
    expect(() => buffer.onBufferChange(() => {})).toThrow(unavailableMessage)
  })

  it('keeps a stable parser while rejecting every unsupported registration', () => {
    const parser = createParserPlaceholder()

    expectTypeOf(parser).toEqualTypeOf<IParser>()
    expect(Object.isFrozen(parser)).toBe(true)
    expect(parser).toBe(parser)
    expect(() => parser.registerCsiHandler({ final: 'm' }, () => true)).toThrow(
      Plan009UnavailableError,
    )
    expect(() => parser.registerDcsHandler({ final: 'q' }, () => true)).toThrow(unavailableMessage)
    expect(() => parser.registerEscHandler({ final: 'c' }, () => true)).toThrow(unavailableMessage)
    expect(() => parser.registerOscHandler(0, () => true)).toThrow(unavailableMessage)
  })

  it('checks the live proposed-API option before rejecting unavailable Unicode behavior', () => {
    let allowed = false
    let checks = 0
    const unicode = createUnicodePlaceholder(() => {
      checks += 1
      return allowed
    })

    expectTypeOf(unicode).toEqualTypeOf<IUnicodeHandling>()
    expect(Object.isFrozen(unicode)).toBe(true)
    expect(unicode).toBe(unicode)
    expect(() => unicode.versions).toThrow(proposedApiMessage)
    expect(() => unicode.register(unicodeProvider)).toThrow(proposedApiMessage)
    expect(() => {
      unicode.activeVersion = 'test'
    }).toThrow(proposedApiMessage)
    expect(checks).toBe(3)

    allowed = true
    expect(() => unicode.versions).toThrow(unavailableMessage)
    expect(() => unicode.activeVersion).toThrow(unavailableMessage)
    expect(() => unicode.register(unicodeProvider)).toThrow(unavailableMessage)
    expect(() => {
      unicode.activeVersion = 'test'
    }).toThrow(unavailableMessage)
    expect(checks).toBe(7)
  })

  it('rejects a non-callable proposed-API allowance', () => {
    expect(() => createUnicodePlaceholder(false as never)).toThrow(
      'Proposed API allowance must be a function',
    )
  })

  it('updates supplied mode fields without changing facade identity or inventing defaults', () => {
    const initial: { bracketedPasteMode: boolean } = { bracketedPasteMode: false }
    const placeholder = createModesPlaceholder(initial)
    const modes = placeholder.modes

    expectTypeOf(modes).toEqualTypeOf<IModes>()
    expect(Object.isFrozen(modes)).toBe(true)
    expect(modes.bracketedPasteMode).toBe(false)
    expect(() => modes.insertMode).toThrow(unavailableMessage)

    initial.bracketedPasteMode = true
    expect(modes.bracketedPasteMode).toBe(false)

    const update = {
      bracketedPasteMode: true,
      insertMode: false,
      mouseTrackingMode: 'drag',
    } as const
    placeholder.update(update)
    expect(placeholder.modes).toBe(modes)
    expect(modes.bracketedPasteMode).toBe(true)
    expect(modes.insertMode).toBe(false)
    expect(modes.mouseTrackingMode).toBe('drag')

    expect(() => modes.applicationCursorKeysMode).toThrow(unavailableMessage)
    expect(() => modes.applicationKeypadMode).toThrow(unavailableMessage)
    expect(() => modes.originMode).toThrow(unavailableMessage)
    expect(() => modes.reverseWraparoundMode).toThrow(unavailableMessage)
    expect(() => modes.sendFocusMode).toThrow(unavailableMessage)
    expect(() => modes.synchronizedOutputMode).toThrow(unavailableMessage)
    expect(() => modes.wraparoundMode).toThrow(unavailableMessage)
  })

  it('can explicitly make an updated mode unavailable again', () => {
    const placeholder = createModesPlaceholder({ insertMode: true })
    expect(placeholder.modes.insertMode).toBe(true)

    placeholder.update({ insertMode: undefined })
    expect(() => placeholder.modes.insertMode).toThrow(unavailableMessage)
  })

  it('rejects invalid modes snapshots', () => {
    expect(() => createModesPlaceholder(null as never)).toThrow('Modes snapshot must be an object')
    const placeholder = createModesPlaceholder()
    expect(() => placeholder.update(null as never)).toThrow('Modes snapshot must be an object')
  })
})
