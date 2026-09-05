import type {
  IBuffer,
  IBufferNamespace,
  IEvent,
  IMarker,
  IModes,
  IParser,
  IUnicodeHandling,
  IUnicodeVersionProvider,
} from './types.js'

export type ProposedApiAllowance = () => boolean

export type ModesSnapshot = Readonly<Partial<IModes>>

export interface ModesPlaceholder {
  readonly modes: IModes
  update(snapshot: ModesSnapshot): void
}

const proposedApiErrorMessage =
  'You must set the allowProposedApi option to true to use proposed API'

export const EMPTY_MARKERS: ReadonlyArray<IMarker> = Object.freeze([])

export class CapabilityUnavailableError extends Error {
  readonly surface: string

  constructor(surface: string) {
    super(`xterm ${surface} is not supported by this compatibility API`)
    this.name = 'CapabilityUnavailableError'
    this.surface = surface
  }
}

function unavailable(surface: string): never {
  throw new CapabilityUnavailableError(surface)
}

function requireProposedApi(isAllowed: ProposedApiAllowance): void {
  if (isAllowed()) return
  throw new Error(proposedApiErrorMessage)
}

function unavailableProposedApi(isAllowed: ProposedApiAllowance, surface: string): never {
  requireProposedApi(isAllowed)
  return unavailable(surface)
}

function validateAllowance(isAllowed: ProposedApiAllowance): void {
  if (typeof isAllowed === 'function') return
  throw new TypeError('Proposed API allowance must be a function')
}

function validateModesSnapshot(snapshot: ModesSnapshot): void {
  if (snapshot && typeof snapshot === 'object') return
  throw new TypeError('Modes snapshot must be an object')
}

function readMode<Key extends keyof IModes>(snapshot: ModesSnapshot, key: Key): IModes[Key] {
  const value = snapshot[key]
  if (value !== undefined) return value
  return unavailable(`modes.${key}`)
}

export function createBufferPlaceholder(): IBufferNamespace {
  const onBufferChange: IEvent<IBuffer> = () => unavailable('buffer.onBufferChange')
  return Object.freeze({
    get active(): IBuffer {
      return unavailable('buffer.active')
    },
    get normal(): IBuffer {
      return unavailable('buffer.normal')
    },
    get alternate(): IBuffer {
      return unavailable('buffer.alternate')
    },
    onBufferChange,
  })
}

export function createParserPlaceholder(): IParser {
  return Object.freeze({
    registerCsiHandler() {
      return unavailable('parser.registerCsiHandler')
    },
    registerDcsHandler() {
      return unavailable('parser.registerDcsHandler')
    },
    registerEscHandler() {
      return unavailable('parser.registerEscHandler')
    },
    registerOscHandler() {
      return unavailable('parser.registerOscHandler')
    },
  })
}

export function createUnicodePlaceholder(
  isProposedApiAllowed: ProposedApiAllowance,
): IUnicodeHandling {
  validateAllowance(isProposedApiAllowed)
  return Object.freeze({
    register(_provider: IUnicodeVersionProvider) {
      return unavailableProposedApi(isProposedApiAllowed, 'unicode.register')
    },
    get versions(): ReadonlyArray<string> {
      return unavailableProposedApi(isProposedApiAllowed, 'unicode.versions')
    },
    get activeVersion(): string {
      return unavailableProposedApi(isProposedApiAllowed, 'unicode.activeVersion')
    },
    set activeVersion(_version: string) {
      unavailableProposedApi(isProposedApiAllowed, 'unicode.activeVersion')
    },
  })
}

export function createModesPlaceholder(initialSnapshot: ModesSnapshot = {}): ModesPlaceholder {
  validateModesSnapshot(initialSnapshot)
  let snapshot = { ...initialSnapshot }
  const modes: IModes = Object.freeze({
    get applicationCursorKeysMode() {
      return readMode(snapshot, 'applicationCursorKeysMode')
    },
    get applicationKeypadMode() {
      return readMode(snapshot, 'applicationKeypadMode')
    },
    get bracketedPasteMode() {
      return readMode(snapshot, 'bracketedPasteMode')
    },
    get insertMode() {
      return readMode(snapshot, 'insertMode')
    },
    get mouseTrackingMode() {
      return readMode(snapshot, 'mouseTrackingMode')
    },
    get originMode() {
      return readMode(snapshot, 'originMode')
    },
    get reverseWraparoundMode() {
      return readMode(snapshot, 'reverseWraparoundMode')
    },
    get sendFocusMode() {
      return readMode(snapshot, 'sendFocusMode')
    },
    get synchronizedOutputMode() {
      return readMode(snapshot, 'synchronizedOutputMode')
    },
    get wraparoundMode() {
      return readMode(snapshot, 'wraparoundMode')
    },
  })
  const update = (nextSnapshot: ModesSnapshot): void => {
    validateModesSnapshot(nextSnapshot)
    snapshot = { ...snapshot, ...nextSnapshot }
  }
  return Object.freeze({ modes, update })
}
