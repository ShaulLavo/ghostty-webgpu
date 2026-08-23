const builtInUrlPattern = /\bhttps?:\/\/[^\s<>"'`]+/giu
const sentencePunctuation = '.,;:!?'
const closingDelimiters: Readonly<Record<string, string>> = {
  ')': '(',
  ']': '[',
  '}': '{',
}

export interface LinkCell {
  readonly continuation?: boolean
  readonly text: string
}

export interface LinkLineSnapshot {
  readonly cells: readonly LinkCell[]
  /** Cell containing text immediately before each exclusive UTF-16 boundary. */
  readonly endCellByTextBoundary: readonly (number | undefined)[]
  /** Cell containing text immediately after each inclusive UTF-16 boundary. */
  readonly startCellByTextBoundary: readonly (number | undefined)[]
  readonly text: string
  readonly textEndByCell: readonly number[]
  readonly textStartByCell: readonly number[]
}

export interface LinkRange {
  /** Inclusive, 0-based cell column. */
  readonly end: number
  /** Inclusive, 0-based cell column. */
  readonly start: number
}

export type LinkActivation<TEvent = unknown> = (event: TEvent) => Promise<void> | void

export interface ProvidedLink<TEvent = unknown> {
  readonly activate: LinkActivation<TEvent>
  readonly range: LinkRange
  readonly text?: string
}

export interface LinkProvider<TEvent = unknown> {
  provideLinks(
    line: LinkLineSnapshot,
    row: number,
  ):
    | Promise<readonly ProvidedLink<TEvent>[] | undefined>
    | readonly ProvidedLink<TEvent>[]
    | undefined
}

export interface LinkProviderRegistration {
  readonly token: symbol
  dispose(): void
}

export interface LinkRequest {
  /** 0-based cell column within `line`. */
  readonly column: number
  readonly line: readonly LinkCell[]
  /** Native OSC 8 URI reported at the queried cell. */
  readonly osc8Range?: LinkRange
  readonly osc8Uri?: string
  /** 0-based visible row. */
  readonly row: number
}

interface LinkHitBase {
  readonly range: LinkRange
  readonly row: number
  readonly text: string
}

export type LinkHit<TEvent = unknown> =
  | (LinkHitBase & {
      readonly activate: LinkActivation<TEvent>
      readonly providerToken: symbol
      readonly source: 'provider'
    })
  | (LinkHitBase & {
      readonly source: 'osc8' | 'url'
      readonly uri: string
    })

export interface LinkResolution<TEvent = unknown> {
  readonly generation: number
  readonly hit?: LinkHit<TEvent>
}

export interface LinkResolverError {
  readonly cause: unknown
  readonly operation: 'activate' | 'provide'
  readonly providerToken?: symbol
  readonly source?: LinkHit['source']
}

export interface LinkResolverOptions<TEvent = unknown> {
  readonly activateUri?: (uri: string, event: TEvent) => Promise<void> | void
  readonly onError?: (error: LinkResolverError) => Promise<void> | void
}

interface NormalizedRequest {
  readonly column: number
  readonly line: LinkLineSnapshot
  readonly osc8Range?: LinkRange
  readonly osc8Uri?: string
  readonly row: number
}

interface ProviderEntry<TEvent> {
  readonly provider: LinkProvider<TEvent>
  readonly token: symbol
}

function validateIndex(name: string, value: number): number {
  if (Number.isSafeInteger(value) && value >= 0) return value
  throw new RangeError(`${name} must be a non-negative safe integer`)
}

function copyCell(cell: LinkCell, column: number): LinkCell {
  if (typeof cell.text !== 'string') throw new TypeError(`line[${column}].text must be a string`)
  const continuation = cell.continuation === true
  if (continuation && cell.text.length > 0) {
    throw new TypeError(`line[${column}] continuation cells must have empty text`)
  }
  return Object.freeze({ continuation, text: cell.text.slice() })
}

function cellText(cell: LinkCell): string {
  if (cell.continuation) return ''
  if (cell.text.length > 0) return cell.text
  return ' '
}

function findStartCell(
  textStartByCell: readonly number[],
  textEndByCell: readonly number[],
  boundary: number,
): number | undefined {
  for (let column = 0; column < textEndByCell.length; column += 1) {
    if (textEndByCell[column]! <= boundary) continue
    if (textStartByCell[column]! > boundary) continue
    return column
  }
  return undefined
}

function findEndCell(
  cells: readonly LinkCell[],
  textStartByCell: readonly number[],
  textEndByCell: readonly number[],
  boundary: number,
): number | undefined {
  for (let column = textStartByCell.length - 1; column >= 0; column -= 1) {
    if (textStartByCell[column]! >= boundary) continue
    if (textEndByCell[column]! < boundary) continue
    let end = column
    while (cells[end + 1]?.continuation) end += 1
    return end
  }
  return undefined
}

function buildBoundaryMap(
  textLength: number,
  findCell: (boundary: number) => number | undefined,
): readonly (number | undefined)[] {
  const result: (number | undefined)[] = []
  for (let boundary = 0; boundary <= textLength; boundary += 1) {
    result.push(findCell(boundary))
  }
  return Object.freeze(result)
}

export function createLinkLineSnapshot(line: readonly LinkCell[]): LinkLineSnapshot {
  if (!Array.isArray(line)) throw new TypeError('line must be an array of terminal cells')
  const cells = line.map(copyCell)
  const textStartByCell: number[] = []
  const textEndByCell: number[] = []
  let text = ''
  for (const cell of cells) {
    textStartByCell.push(text.length)
    text += cellText(cell)
    textEndByCell.push(text.length)
  }
  const startCellByTextBoundary = buildBoundaryMap(text.length, (boundary) =>
    findStartCell(textStartByCell, textEndByCell, boundary),
  )
  const endCellByTextBoundary = buildBoundaryMap(text.length, (boundary) =>
    findEndCell(cells, textStartByCell, textEndByCell, boundary),
  )
  return Object.freeze({
    cells: Object.freeze(cells),
    endCellByTextBoundary,
    startCellByTextBoundary,
    text,
    textEndByCell: Object.freeze(textEndByCell),
    textStartByCell: Object.freeze(textStartByCell),
  })
}

function normalizeRequest(request: LinkRequest): NormalizedRequest {
  const row = validateIndex('row', request.row)
  const column = validateIndex('column', request.column)
  const line = createLinkLineSnapshot(request.line)
  if (column >= line.cells.length) {
    throw new RangeError(`column ${column} is outside a ${line.cells.length}-cell line`)
  }
  if (request.osc8Uri !== undefined && typeof request.osc8Uri !== 'string') {
    throw new TypeError('osc8Uri must be a string')
  }
  if (request.osc8Range !== undefined && request.osc8Uri === undefined) {
    throw new TypeError('osc8Range requires osc8Uri')
  }
  const osc8Range = request.osc8Range ? copyRange(request.osc8Range, line.cells.length) : undefined
  if (osc8Range && !containsColumn(osc8Range, column)) {
    throw new RangeError('osc8Range must contain the queried column')
  }
  return { column, line, osc8Range, osc8Uri: request.osc8Uri, row }
}

function copyRange(range: LinkRange, cellCount: number): LinkRange {
  const start = validateIndex('range.start', range.start)
  const end = validateIndex('range.end', range.end)
  if (start > end) throw new RangeError('range.start must not exceed range.end')
  if (end >= cellCount) {
    throw new RangeError(`range.end ${end} is outside a ${cellCount}-cell line`)
  }
  return { end, start }
}

function containsColumn(range: LinkRange, column: number): boolean {
  return column >= range.start && column <= range.end
}

function linkText(line: LinkLineSnapshot, range: LinkRange, text?: string): string {
  if (text !== undefined && typeof text !== 'string')
    throw new TypeError('link text must be a string')
  if (text !== undefined) return text.slice()
  const start = line.textStartByCell[range.start]!
  const end = line.textEndByCell[range.end]!
  return line.text.slice(start, end)
}

function resolveOsc8<TEvent>(request: NormalizedRequest): LinkHit<TEvent> | undefined {
  const uri = request.osc8Uri
  if (uri === undefined) return undefined
  if (uri.length === 0) throw new TypeError('osc8Uri must be non-empty')
  const range = request.osc8Range ?? { end: request.column, start: request.column }
  return {
    range,
    row: request.row,
    source: 'osc8',
    text: linkText(request.line, range),
    uri: uri.slice(),
  }
}

function resolveProvidedLink<TEvent>(
  links: readonly ProvidedLink<TEvent>[] | undefined,
  request: NormalizedRequest,
  providerToken: symbol,
): LinkHit<TEvent> | undefined {
  if (!links) return undefined
  for (const link of links) {
    const range = copyRange(link.range, request.line.cells.length)
    if (!containsColumn(range, request.column)) continue
    if (typeof link.activate !== 'function') throw new TypeError('link activate must be a function')
    return {
      activate: link.activate,
      providerToken,
      range,
      row: request.row,
      source: 'provider',
      text: linkText(request.line, range, link.text),
    }
  }
  return undefined
}

function unmatchedClosingDelimiter(value: string, end: number, closing: string): boolean {
  const opening = closingDelimiters[closing]
  if (!opening) return false
  let balance = 0
  for (let index = 0; index < end - 1; index += 1) {
    const character = value[index]
    if (character === opening) {
      balance += 1
      continue
    }
    if (character !== closing) continue
    if (balance > 0) balance -= 1
  }
  return balance === 0
}

function trimUrl(value: string): string {
  let end = value.length
  while (end > 0) {
    const character = value[end - 1]!
    if (sentencePunctuation.includes(character)) {
      end -= 1
      continue
    }
    if (!unmatchedClosingDelimiter(value, end, character)) break
    end -= 1
  }
  return value.slice(0, end)
}

function rangeForTextSpan(
  line: LinkLineSnapshot,
  startBoundary: number,
  endBoundary: number,
): LinkRange | undefined {
  const start = line.startCellByTextBoundary[startBoundary]
  const end = line.endCellByTextBoundary[endBoundary]
  if (start === undefined || end === undefined) return undefined
  return { end, start }
}

function resolveBuiltInUrl<TEvent>(request: NormalizedRequest): LinkHit<TEvent> | undefined {
  for (const match of request.line.text.matchAll(builtInUrlPattern)) {
    const uri = trimUrl(match[0])
    if (uri.length === 0) continue
    const range = rangeForTextSpan(request.line, match.index, match.index + uri.length)
    if (!range || !containsColumn(range, request.column)) continue
    return { range, row: request.row, source: 'url', text: uri, uri }
  }
  return undefined
}

export class LinkResolver<TEvent = unknown> {
  private readonly activateUri?: (uri: string, event: TEvent) => Promise<void> | void
  private disposed = false
  private generationValue = 0
  private readonly onError?: (error: LinkResolverError) => Promise<void> | void
  private readonly providers: ProviderEntry<TEvent>[] = []

  constructor(options: LinkResolverOptions<TEvent> = {}) {
    this.activateUri = options.activateUri
    this.onError = options.onError
  }

  get generation(): number {
    return this.generationValue
  }

  invalidate(): number {
    this.generationValue += 1
    return this.generationValue
  }

  isCurrent(resolution: LinkResolution<TEvent>): boolean {
    return !this.disposed && resolution.generation === this.generationValue
  }

  registerProvider(provider: LinkProvider<TEvent>): LinkProviderRegistration {
    this.ensureActive('registerProvider')
    if (typeof provider.provideLinks !== 'function') {
      throw new TypeError('provider.provideLinks must be a function')
    }
    const token = Symbol('link-provider')
    this.providers.push({ provider, token })
    this.invalidate()
    return Object.freeze({
      dispose: () => this.removeProvider(token),
      token,
    })
  }

  async resolve(requestValue: LinkRequest): Promise<LinkResolution<TEvent>> {
    this.ensureActive('resolve')
    const request = normalizeRequest(requestValue)
    const generation = this.invalidate()
    const osc8 = resolveOsc8<TEvent>(request)
    if (osc8) return { generation, hit: osc8 }
    const providers = this.providers.slice()
    const provided = await this.resolveProviders(providers, request, generation)
    if (generation !== this.generationValue || this.disposed) return { generation }
    if (provided) return { generation, hit: provided }
    return { generation, hit: resolveBuiltInUrl<TEvent>(request) }
  }

  async activate(resolution: LinkResolution<TEvent>, event: TEvent): Promise<boolean> {
    if (!this.isCurrent(resolution)) return false
    const hit = resolution.hit
    if (!hit) return false
    try {
      return await this.invokeActivation(hit, event)
    } catch (cause) {
      this.reportError({
        cause,
        operation: 'activate',
        providerToken: hit.source === 'provider' ? hit.providerToken : undefined,
        source: hit.source,
      })
      return false
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.providers.length = 0
    this.invalidate()
  }

  private ensureActive(operation: string): void {
    if (!this.disposed) return
    throw new Error(`LinkResolver.${operation} called after disposal`)
  }

  private async invokeActivation(hit: LinkHit<TEvent>, event: TEvent): Promise<boolean> {
    if (hit.source === 'provider') {
      await hit.activate(event)
      return true
    }
    if (!this.activateUri) return false
    await this.activateUri(hit.uri, event)
    return true
  }

  private removeProvider(token: symbol): void {
    if (this.disposed) return
    const index = this.providers.findIndex((entry) => entry.token === token)
    if (index < 0) return
    this.providers.splice(index, 1)
    this.invalidate()
  }

  private async resolveProvider(
    entry: ProviderEntry<TEvent>,
    request: NormalizedRequest,
  ): Promise<LinkHit<TEvent> | undefined> {
    try {
      const links = await entry.provider.provideLinks(request.line, request.row)
      return resolveProvidedLink(links, request, entry.token)
    } catch (cause) {
      this.reportError({
        cause,
        operation: 'provide',
        providerToken: entry.token,
        source: 'provider',
      })
      return undefined
    }
  }

  private async resolveProviders(
    providers: readonly ProviderEntry<TEvent>[],
    request: NormalizedRequest,
    generation: number,
  ): Promise<LinkHit<TEvent> | undefined> {
    for (const entry of providers) {
      const hit = await this.resolveProvider(entry, request)
      if (generation !== this.generationValue || this.disposed) return undefined
      if (hit) return hit
    }
    return undefined
  }

  private reportError(error: LinkResolverError): void {
    try {
      const result = this.onError?.(error)
      void Promise.resolve(result).catch(() => {})
    } catch {
      return
    }
  }
}
