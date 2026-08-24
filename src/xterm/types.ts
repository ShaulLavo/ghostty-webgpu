import type { Terminal } from './terminal.js'

// Public shapes mirror @xterm/xterm 6.0.0 without a production dependency.
export type FontWeight =
  | 'normal'
  | 'bold'
  | '100'
  | '200'
  | '300'
  | '400'
  | '500'
  | '600'
  | '700'
  | '800'
  | '900'
  | number

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'off'

export interface ITerminalOptions {
  allowProposedApi?: boolean
  allowTransparency?: boolean
  altClickMovesCursor?: boolean
  convertEol?: boolean
  cursorBlink?: boolean
  cursorStyle?: 'block' | 'underline' | 'bar'
  cursorWidth?: number
  cursorInactiveStyle?: 'outline' | 'block' | 'bar' | 'underline' | 'none'
  customGlyphs?: boolean
  disableStdin?: boolean
  documentOverride?: any | null
  drawBoldTextInBrightColors?: boolean
  fastScrollSensitivity?: number
  fontSize?: number
  fontFamily?: string
  fontWeight?: FontWeight
  fontWeightBold?: FontWeight
  ignoreBracketedPasteMode?: boolean
  letterSpacing?: number
  lineHeight?: number
  linkHandler?: ILinkHandler | null
  logLevel?: LogLevel
  logger?: ILogger | null
  macOptionIsMeta?: boolean
  macOptionClickForcesSelection?: boolean
  minimumContrastRatio?: number
  reflowCursorLine?: boolean
  rescaleOverlappingGlyphs?: boolean
  rightClickSelectsWord?: boolean
  screenReaderMode?: boolean
  scrollback?: number
  scrollOnEraseInDisplay?: boolean
  scrollOnUserInput?: boolean
  scrollSensitivity?: number
  smoothScrollDuration?: number
  tabStopWidth?: number
  theme?: ITheme
  windowsPty?: IWindowsPty
  wordSeparator?: string
  windowOptions?: IWindowOptions
  overviewRuler?: IOverviewRulerOptions
}

export interface ITerminalInitOnlyOptions {
  cols?: number
  rows?: number
}

export interface ITheme {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  selectionInactiveBackground?: string
  scrollbarSliderBackground?: string
  scrollbarSliderHoverBackground?: string
  scrollbarSliderActiveBackground?: string
  overviewRulerBorder?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
  extendedAnsi?: string[]
}

export interface IWindowsPty {
  backend?: 'conpty' | 'winpty'
  buildNumber?: number
}

export interface ILogger {
  trace(message: string, ...args: any[]): void
  debug(message: string, ...args: any[]): void
  info(message: string, ...args: any[]): void
  warn(message: string, ...args: any[]): void
  error(message: string | Error, ...args: any[]): void
}

export interface IDisposable {
  dispose(): void
}

export interface IEvent<T, U = void> {
  (listener: (arg1: T, arg2: U) => any): IDisposable
}

export interface IDisposableWithEvent extends IDisposable {
  onDispose: IEvent<void>
  readonly isDisposed: boolean
}

export interface IMarker extends IDisposableWithEvent {
  readonly id: number
  readonly line: number
}

export interface IDecoration extends IDisposableWithEvent {
  readonly marker: IMarker
  readonly onRender: IEvent<HTMLElement>
  element: HTMLElement | undefined
  options: Pick<IDecorationOptions, 'overviewRulerOptions'>
}

export interface IDecorationOverviewRulerOptions {
  color: string
  position?: 'left' | 'center' | 'right' | 'full'
}

export interface IDecorationOptions {
  readonly marker: IMarker
  readonly anchor?: 'right' | 'left'
  readonly x?: number
  readonly width?: number
  readonly height?: number
  readonly backgroundColor?: string
  readonly foregroundColor?: string
  readonly layer?: 'bottom' | 'top'
  overviewRulerOptions?: IDecorationOverviewRulerOptions
}

export interface ILocalizableStrings {
  promptLabel: string
  tooMuchOutput: string
}

export interface IOverviewRulerOptions {
  width?: number
  showTopBorder?: boolean
  showBottomBorder?: boolean
}

export interface IWindowOptions {
  restoreWin?: boolean
  minimizeWin?: boolean
  setWinPosition?: boolean
  setWinSizePixels?: boolean
  raiseWin?: boolean
  lowerWin?: boolean
  refreshWin?: boolean
  setWinSizeChars?: boolean
  maximizeWin?: boolean
  fullscreenWin?: boolean
  getWinState?: boolean
  getWinPosition?: boolean
  getWinSizePixels?: boolean
  getScreenSizePixels?: boolean
  getCellSizePixels?: boolean
  getWinSizeChars?: boolean
  getScreenSizeChars?: boolean
  getIconTitle?: boolean
  getWinTitle?: boolean
  pushTitle?: boolean
  popTitle?: boolean
  setWinLines?: boolean
}

export interface ITerminalAddon extends IDisposable {
  activate(terminal: Terminal): void
}

export interface IViewportRange {
  start: IViewportRangePosition
  end: IViewportRangePosition
}

export interface IViewportRangePosition {
  x: number
  y: number
}

export interface ILinkHandler {
  activate(event: MouseEvent, text: string, range: IBufferRange): void
  hover?(event: MouseEvent, text: string, range: IBufferRange): void
  leave?(event: MouseEvent, text: string, range: IBufferRange): void
  allowNonHttpProtocols?: boolean
}

export interface ILinkProvider {
  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void
}

export interface ILink {
  range: IBufferRange
  text: string
  decorations?: ILinkDecorations
  activate(event: MouseEvent, text: string): void
  hover?(event: MouseEvent, text: string): void
  leave?(event: MouseEvent, text: string): void
  dispose?(): void
}

export interface ILinkDecorations {
  pointerCursor: boolean
  underline: boolean
}

export interface IBufferRange {
  start: IBufferCellPosition
  end: IBufferCellPosition
}

export interface IBufferCellPosition {
  x: number
  y: number
}

export interface IBuffer {
  readonly type: 'normal' | 'alternate'
  readonly cursorY: number
  readonly cursorX: number
  readonly viewportY: number
  readonly baseY: number
  readonly length: number
  getLine(y: number): IBufferLine | undefined
  getNullCell(): IBufferCell
}

export interface IBufferElementProvider {
  provideBufferElements(): DocumentFragment | HTMLElement
}

export interface IBufferNamespace {
  readonly active: IBuffer
  readonly normal: IBuffer
  readonly alternate: IBuffer
  onBufferChange: IEvent<IBuffer>
}

export interface IBufferLine {
  readonly isWrapped: boolean
  readonly length: number
  getCell(x: number, cell?: IBufferCell): IBufferCell | undefined
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string
}

export interface IBufferCell {
  getWidth(): number
  getChars(): string
  getCode(): number
  getFgColorMode(): number
  getBgColorMode(): number
  getFgColor(): number
  getBgColor(): number
  isBold(): number
  isItalic(): number
  isDim(): number
  isUnderline(): number
  isBlink(): number
  isInverse(): number
  isInvisible(): number
  isStrikethrough(): number
  isOverline(): number
  isFgRGB(): boolean
  isBgRGB(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  isFgDefault(): boolean
  isBgDefault(): boolean
  isAttributeDefault(): boolean
}

export interface IFunctionIdentifier {
  prefix?: string
  intermediates?: string
  final: string
}

export interface IParser {
  registerCsiHandler(
    id: IFunctionIdentifier,
    callback: (params: (number | number[])[]) => boolean | Promise<boolean>,
  ): IDisposable
  registerDcsHandler(
    id: IFunctionIdentifier,
    callback: (data: string, params: (number | number[])[]) => boolean | Promise<boolean>,
  ): IDisposable
  registerEscHandler(
    id: IFunctionIdentifier,
    handler: () => boolean | Promise<boolean>,
  ): IDisposable
  registerOscHandler(
    ident: number,
    callback: (data: string) => boolean | Promise<boolean>,
  ): IDisposable
}

export interface IUnicodeVersionProvider {
  readonly version: string
  wcwidth(codepoint: number): 0 | 1 | 2
  charProperties(codepoint: number, preceding: number): number
}

export interface IUnicodeHandling {
  register(provider: IUnicodeVersionProvider): void
  readonly versions: ReadonlyArray<string>
  activeVersion: string
}

export interface IModes {
  readonly applicationCursorKeysMode: boolean
  readonly applicationKeypadMode: boolean
  readonly bracketedPasteMode: boolean
  readonly insertMode: boolean
  readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  readonly originMode: boolean
  readonly reverseWraparoundMode: boolean
  readonly sendFocusMode: boolean
  readonly synchronizedOutputMode: boolean
  readonly wraparoundMode: boolean
}
