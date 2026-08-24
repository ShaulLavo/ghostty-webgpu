import type { FontWeight, ITerminalInitOnlyOptions, ITerminalOptions } from './types.js'

export type TerminalOptionKey = keyof ITerminalOptions

export type TerminalOptionValues = Required<ITerminalOptions>

export interface TerminalOptionChange {
  readonly keys: readonly TerminalOptionKey[]
  readonly values: TerminalOptionValues
}

export type TerminalOptionChangeHandler = (change: TerminalOptionChange) => void

const fontWeights = new Set<FontWeight>([
  'normal',
  'bold',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
])

function isMacPlatform(): boolean {
  if (typeof navigator !== 'object') return false
  return /Macintosh|Mac OS X|iPad|iPhone/u.test(navigator.userAgent)
}

function defaultValues(): TerminalOptionValues {
  return {
    allowProposedApi: false,
    allowTransparency: false,
    altClickMovesCursor: true,
    convertEol: false,
    cursorBlink: false,
    cursorInactiveStyle: 'outline',
    cursorStyle: 'block',
    cursorWidth: 1,
    customGlyphs: true,
    disableStdin: false,
    documentOverride: null,
    drawBoldTextInBrightColors: true,
    fastScrollSensitivity: 5,
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    ignoreBracketedPasteMode: false,
    letterSpacing: 0,
    lineHeight: 1,
    linkHandler: null,
    logger: null,
    logLevel: 'info',
    macOptionClickForcesSelection: false,
    macOptionIsMeta: false,
    minimumContrastRatio: 1,
    overviewRuler: {},
    reflowCursorLine: false,
    rescaleOverlappingGlyphs: false,
    rightClickSelectsWord: isMacPlatform(),
    screenReaderMode: false,
    scrollback: 1000,
    scrollOnEraseInDisplay: false,
    scrollOnUserInput: true,
    scrollSensitivity: 1,
    smoothScrollDuration: 0,
    tabStopWidth: 8,
    theme: {},
    windowOptions: {},
    windowsPty: {},
    wordSeparator: ' ()[]{}\',"`',
  }
}

const terminalOptionKeys = Object.keys(defaultValues()) as TerminalOptionKey[]

function invalidMinimum(key: string, value: unknown, minimum: number): RangeError {
  return new RangeError(`${key} cannot be less than ${minimum}, value: ${String(value)}`)
}

function positiveNumber(key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${key} must be a finite number`)
  }
  if (value > 0) return value
  throw new RangeError(`${key} cannot be less than or equal to 0, value: ${String(value)}`)
}

function atLeastOne(key: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${key} must be a finite number`)
  }
  if (value >= 1) return value
  throw invalidMinimum(key, value, 1)
}

function cursorStyle(value: unknown): TerminalOptionValues['cursorStyle'] {
  if (!value) return 'block'
  if (value === 'block' || value === 'underline' || value === 'bar') return value
  throw new TypeError(`"${String(value)}" is not a valid value for cursorStyle`)
}

function fontWeight(key: 'fontWeight' | 'fontWeightBold', value: unknown): FontWeight {
  if (typeof value === 'number' && value >= 1 && value <= 1000) return value
  if (fontWeights.has(value as FontWeight)) return value as FontWeight
  return key === 'fontWeight' ? 'normal' : 'bold'
}

function sanitizeOption(
  key: TerminalOptionKey,
  value: unknown,
  defaults: TerminalOptionValues,
): TerminalOptionValues[TerminalOptionKey] {
  if (value === undefined) return defaults[key]
  if (key === 'cursorStyle') return cursorStyle(value)
  if (key === 'wordSeparator') return value ? String(value) : defaults.wordSeparator
  if (key === 'fontWeight' || key === 'fontWeightBold') return fontWeight(key, value)
  if (key === 'cursorWidth') return atLeastOne(key, Math.floor(Number(value)))
  if (key === 'lineHeight' || key === 'tabStopWidth') return atLeastOne(key, value)
  if (key === 'minimumContrastRatio') {
    const ratio = Number(value)
    if (!Number.isFinite(ratio)) return defaults.minimumContrastRatio
    return Math.max(1, Math.min(21, Math.round(ratio * 10) / 10))
  }
  if (key === 'scrollback') {
    const amount = Number(value)
    if (!Number.isFinite(amount)) throw new TypeError('scrollback must be a finite number')
    if (amount < 0) throw invalidMinimum(key, value, 0)
    return Math.min(amount, 4_294_967_295)
  }
  if (key === 'fastScrollSensitivity' || key === 'scrollSensitivity') {
    return positiveNumber(key, value)
  }
  if (key === 'windowsPty') return value ?? {}
  return value as TerminalOptionValues[TerminalOptionKey]
}

function initialDimension(key: 'cols' | 'rows', value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${key} must be an integer`)
  }
  return Math.max(key === 'cols' ? 2 : 1, value)
}

function initialDimensionOption(key: 'cols' | 'rows', value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${key} must be an integer`)
  }
  return value
}

function initialDimensionOrFallback(
  key: 'cols' | 'rows',
  value: unknown,
  fallback: number,
): number {
  try {
    return initialDimensionOption(key, value, fallback)
  } catch (cause) {
    console.error(cause)
    return fallback
  }
}

function readonlyDimensionSetter(key: 'cols' | 'rows'): () => never {
  return () => {
    throw new Error(`Option "${key}" can only be set in the constructor`)
  }
}

function definePublicDimension(
  result: ITerminalOptions,
  store: TerminalOptionsStore,
  key: 'cols' | 'rows',
): void {
  Object.defineProperty(result, key, {
    configurable: true,
    enumerable: true,
    get: () => store.initialDimensionOption(key),
    set: readonlyDimensionSetter(key),
  })
}

function publicOptions(store: TerminalOptionsStore): ITerminalOptions {
  const result: ITerminalOptions = {}
  for (const key of terminalOptionKeys) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      get: () => store.values[key],
      set: (value: unknown) => store.set({ [key]: value } as ITerminalOptions),
    })
  }
  definePublicDimension(result, store, 'cols')
  definePublicDimension(result, store, 'rows')
  return result
}

function rejectInitOnlyOptions(options: ITerminalOptions): void {
  if (Object.hasOwn(options, 'cols')) readonlyDimensionSetter('cols')()
  if (Object.hasOwn(options, 'rows')) readonlyDimensionSetter('rows')()
}

export class TerminalOptionsStore {
  private columnsValue: number
  private readonly initialColumnsValue: number
  private readonly defaults = defaultValues()
  private readonly onChange?: TerminalOptionChangeHandler
  private readonly publicValue: ITerminalOptions
  private readonly initialRowsValue: number
  private rowsValue: number
  values: TerminalOptionValues

  constructor(
    options: ITerminalOptions & ITerminalInitOnlyOptions = {},
    onChange?: TerminalOptionChangeHandler,
  ) {
    this.onChange = onChange
    this.values = { ...this.defaults }
    this.initialColumnsValue = initialDimensionOrFallback('cols', options.cols, 80)
    this.initialRowsValue = initialDimensionOrFallback('rows', options.rows, 24)
    this.columnsValue = initialDimension('cols', this.initialColumnsValue, 80)
    this.rowsValue = initialDimension('rows', this.initialRowsValue, 24)
    this.applyInitial(options)
    this.publicValue = publicOptions(this)
  }

  get cols(): number {
    return this.columnsValue
  }

  get options(): ITerminalOptions {
    return this.publicValue
  }

  get rows(): number {
    return this.rowsValue
  }

  initialDimensionOption(key: 'cols' | 'rows'): number {
    if (key === 'cols') return this.initialColumnsValue
    return this.initialRowsValue
  }

  resize(cols: number, rows: number): boolean {
    const nextCols = initialDimension('cols', cols, this.columnsValue)
    const nextRows = initialDimension('rows', rows, this.rowsValue)
    if (nextCols === this.columnsValue && nextRows === this.rowsValue) return false
    this.columnsValue = nextCols
    this.rowsValue = nextRows
    return true
  }

  set(options: ITerminalOptions): void {
    if (!options || typeof options !== 'object') {
      throw new TypeError('Terminal options must be an object')
    }
    rejectInitOnlyOptions(options)
    const next = { ...this.values }
    const changed: TerminalOptionKey[] = []
    for (const key of terminalOptionKeys) {
      if (!Object.hasOwn(options, key)) continue
      const value = sanitizeOption(key, options[key], this.defaults)
      if (next[key] === value) continue
      ;(next as Record<TerminalOptionKey, unknown>)[key] = value
      changed.push(key)
    }
    if (changed.length === 0) return
    const previous = this.values
    this.values = next
    try {
      this.onChange?.({ keys: Object.freeze(changed.slice()), values: next })
    } catch (cause) {
      this.values = previous
      throw cause
    }
  }

  private applyInitial(options: ITerminalOptions): void {
    const next = { ...this.values }
    for (const key of terminalOptionKeys) {
      if (!Object.hasOwn(options, key)) continue
      try {
        ;(next as Record<TerminalOptionKey, unknown>)[key] = sanitizeOption(
          key,
          options[key],
          this.defaults,
        )
      } catch (cause) {
        console.error(cause)
      }
    }
    this.values = next
  }
}
