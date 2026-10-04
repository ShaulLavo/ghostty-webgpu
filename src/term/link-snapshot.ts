import type { RendererTextFrameRow, RenderStateSource } from '../render/renderer.js'
import {
  LinkResolver,
  type LinkCell,
  type LinkProvider,
  type LinkProviderRegistration,
  type LinkRange,
  type LinkResolution,
  type LinkResolverOptions,
} from './links.js'
import type { TerminalLinkRequest } from './types.js'

export interface LinkProjection {
  readonly generation: number
  readonly layout: number
  readonly revision: number
}

export interface NativeLinkRequest {
  readonly projection: LinkProjection
  readonly column: number
  readonly row: number
}

export interface NativeLinkSnapshot extends NativeLinkRequest {
  readonly line: readonly LinkCell[]
  readonly osc8Uri?: string
  readonly osc8Range?: LinkRange
}

export interface NativeLinkSnapshotSource {
  readonly revision: number
  readonly grid: { readonly columns: number; readonly rows: number }
  readonly renderState: Pick<RenderStateSource, 'readTextRows'>
  linkAt(column: number, row: number): string | undefined
}

export function linkProjectionEquals(
  left: LinkProjection | undefined,
  right: LinkProjection | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.generation === right.generation &&
    left.layout === right.layout &&
    left.revision === right.revision
  )
}

function ownLinkCells(row: RendererTextFrameRow): readonly LinkCell[] {
  return Object.freeze(
    row.cells.map((text, column) =>
      Object.freeze({
        text,
        continuation: row.continuations[column] === true,
      }),
    ),
  )
}

/** Reads the existing session's committed render state without updating or acknowledging it. */
export function captureNativeLinkSnapshot(
  source: NativeLinkSnapshotSource,
  request: NativeLinkRequest,
  getProjection: () => LinkProjection | undefined,
): NativeLinkSnapshot | undefined {
  const { column, row } = request
  const projection = Object.freeze({ ...request.projection })
  if (!linkProjectionEquals(projection, getProjection())) return undefined
  if (source.revision !== projection.revision) return undefined
  if (!Number.isSafeInteger(column) || column < 0 || column >= source.grid.columns) return undefined
  if (!Number.isSafeInteger(row) || row < 0 || row >= source.grid.rows) return undefined
  const nativeRow = source.renderState
    .readTextRows?.({ dirtyOnly: false, rows: new Set([row]) })
    .find((candidate) => candidate.y === row)
  if (!nativeRow || column >= nativeRow.cells.length) return undefined
  const line = ownLinkCells(nativeRow)
  const osc8Uri = source.linkAt(column, row)
  let osc8Range: LinkRange | undefined
  if (osc8Uri !== undefined) {
    let start = column
    while (start > 0 && source.linkAt(start - 1, row) === osc8Uri) start -= 1
    let end = column
    while (end + 1 < line.length && source.linkAt(end + 1, row) === osc8Uri) end += 1
    osc8Range = Object.freeze({ start, end })
  }
  if (source.revision !== projection.revision) return undefined
  if (!linkProjectionEquals(projection, getProjection())) return undefined
  return Object.freeze({ column, row, projection, line, osc8Uri, osc8Range })
}

export interface LinkDiscoveryCell {
  readonly column: number
  readonly row: number
}

export interface LinkDiscoveryHit<TEvent> {
  readonly cell: LinkDiscoveryCell
  readonly resolution: LinkResolution<TEvent>
}

export interface NativeLinkDiscoveryRequest {
  readonly projection: LinkProjection
  readonly rows: readonly number[]
}

interface NativeLinkDiscoveryRow {
  readonly row: number
  readonly line: readonly LinkCell[]
  readonly osc8Links: readonly { readonly range: LinkRange; readonly uri: string }[]
}

export interface NativeLinkDiscoverySnapshot {
  readonly projection: LinkProjection
  readonly rows: readonly NativeLinkDiscoveryRow[]
}

/** A keyboard discovery owns requested rows once; candidate scanning stays on the host. */
export function captureNativeLinkDiscovery(
  source: NativeLinkSnapshotSource,
  request: NativeLinkDiscoveryRequest,
  getProjection: () => LinkProjection | undefined,
): NativeLinkDiscoverySnapshot | undefined {
  const projection = Object.freeze({ ...request.projection })
  if (!linkProjectionEquals(projection, getProjection())) return undefined
  if (source.revision !== projection.revision) return undefined
  const requestedRows = new Set(request.rows)
  for (const row of requestedRows) {
    if (!Number.isSafeInteger(row) || row < 0 || row >= source.grid.rows) return undefined
  }
  const nativeRows = source.renderState.readTextRows?.({ dirtyOnly: false, rows: requestedRows })
  if (!nativeRows) return undefined
  const rows: NativeLinkDiscoveryRow[] = []
  for (const row of requestedRows) {
    const nativeRow = nativeRows.find((candidate) => candidate.y === row)
    if (!nativeRow) return undefined
    const line = ownLinkCells(nativeRow)
    const osc8Links: Array<{ readonly range: LinkRange; readonly uri: string }> = []
    for (let column = 0; column < line.length; column += 1) {
      const uri = source.linkAt(column, row)
      if (uri === undefined) continue
      const start = column
      while (column + 1 < line.length && source.linkAt(column + 1, row) === uri) column += 1
      osc8Links.push(Object.freeze({ uri, range: Object.freeze({ start, end: column }) }))
    }
    rows.push(Object.freeze({ row, line, osc8Links: Object.freeze(osc8Links) }))
  }
  if (source.revision !== projection.revision) return undefined
  if (!linkProjectionEquals(projection, getProjection())) return undefined
  return Object.freeze({ projection, rows: Object.freeze(rows) })
}

export interface ProjectedLinkSessionOptions<TEvent> extends LinkResolverOptions<TEvent> {
  readonly getProjection: () => LinkProjection | undefined
  readonly resolveLinkDiscovery: (
    request: NativeLinkDiscoveryRequest,
  ) => NativeLinkDiscoverySnapshot | undefined | Promise<NativeLinkDiscoverySnapshot | undefined>
  readonly resolveLinkSnapshot: (
    request: NativeLinkRequest,
  ) => NativeLinkSnapshot | undefined | Promise<NativeLinkSnapshot | undefined>
}

export interface ProjectedLinkSession<TEvent> {
  activateLink(resolution: LinkResolution<TEvent>, event: TEvent): Promise<boolean>
  cancelLinkResolution(): void
  dispose(): void
  findNextLink(cells: readonly LinkDiscoveryCell[]): Promise<LinkDiscoveryHit<TEvent> | undefined>
  isLinkCurrent(resolution: LinkResolution<TEvent>): boolean
  registerLinkProvider(provider: LinkProvider<TEvent>): LinkProviderRegistration
  resolveLink(request: TerminalLinkRequest): Promise<LinkResolution<TEvent>>
}

class HostLinkSession<TEvent> implements ProjectedLinkSession<TEvent> {
  private disposed = false
  private epoch = 0
  private readonly projections = new WeakMap<LinkResolution<TEvent>, LinkProjection>()
  private readonly resolver: LinkResolver<TEvent>

  constructor(private readonly options: ProjectedLinkSessionOptions<TEvent>) {
    this.resolver = new LinkResolver(options)
  }

  cancelLinkResolution(): void {
    this.epoch += 1
    this.resolver.invalidate()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.epoch += 1
    this.resolver.dispose()
  }

  registerLinkProvider(provider: LinkProvider<TEvent>): LinkProviderRegistration {
    this.epoch += 1
    const registration = this.resolver.registerProvider(provider)
    return Object.freeze({
      token: registration.token,
      dispose: () => {
        this.epoch += 1
        registration.dispose()
      },
    })
  }

  async resolveLink(request: TerminalLinkRequest): Promise<LinkResolution<TEvent>> {
    this.cancelLinkResolution()
    const epoch = this.epoch
    const current = this.options.getProjection()
    if (this.disposed || !current) return { generation: this.resolver.generation }
    const projection = Object.freeze({ ...current })
    const snapshot = await this.options.resolveLinkSnapshot({
      column: request.column,
      row: request.row,
      projection,
    })
    if (!snapshot || !this.isCurrentRequest(epoch, projection))
      return { generation: this.resolver.generation }
    if (!linkProjectionEquals(snapshot.projection, projection))
      return { generation: this.resolver.generation }
    if (snapshot.column !== request.column || snapshot.row !== request.row)
      return { generation: this.resolver.generation }
    const resolution = await this.resolver.resolve(
      {
        column: snapshot.column,
        row: snapshot.row,
        line: snapshot.line,
        osc8Uri: snapshot.osc8Uri,
        osc8Range: snapshot.osc8Range,
      },
      () => this.isCurrentRequest(epoch, projection),
    )
    if (this.isCurrentRequest(epoch, projection)) this.projections.set(resolution, projection)
    return resolution
  }

  async findNextLink(
    candidates: readonly LinkDiscoveryCell[],
  ): Promise<LinkDiscoveryHit<TEvent> | undefined> {
    this.cancelLinkResolution()
    const epoch = this.epoch
    const current = this.options.getProjection()
    if (this.disposed || !current || candidates.length === 0) return undefined
    const projection = Object.freeze({ ...current })
    const cells = candidates.map(({ column, row }) => ({ column, row }))
    const snapshot = await this.options.resolveLinkDiscovery({
      projection,
      rows: Object.freeze([...new Set(cells.map((cell) => cell.row))]),
    })
    if (!snapshot || !this.isCurrentRequest(epoch, projection)) return undefined
    if (!linkProjectionEquals(snapshot.projection, projection)) return undefined
    const rows = new Map(snapshot.rows.map((row) => [row.row, row]))
    for (const cell of cells) {
      const row = rows.get(cell.row)
      if (!row || cell.column < 0 || cell.column >= row.line.length) continue
      const osc8 = row.osc8Links.find(
        ({ range }) => cell.column >= range.start && cell.column <= range.end,
      )
      const resolution = await this.resolver.resolve(
        {
          ...cell,
          line: row.line,
          osc8Range: osc8?.range,
          osc8Uri: osc8?.uri,
        },
        () => this.isCurrentRequest(epoch, projection),
      )
      if (!this.isCurrentRequest(epoch, projection)) return undefined
      if (!resolution.hit) continue
      this.projections.set(resolution, projection)
      return { cell, resolution }
    }
    return undefined
  }

  isLinkCurrent(resolution: LinkResolution<TEvent>): boolean {
    if (this.disposed || !this.resolver.isCurrent(resolution)) return false
    return linkProjectionEquals(this.projections.get(resolution), this.options.getProjection())
  }

  async activateLink(resolution: LinkResolution<TEvent>, event: TEvent): Promise<boolean> {
    if (!this.isLinkCurrent(resolution)) return false
    return this.resolver.activate(resolution, event)
  }

  private isCurrentRequest(epoch: number, projection: LinkProjection): boolean {
    return (
      !this.disposed &&
      epoch === this.epoch &&
      linkProjectionEquals(projection, this.options.getProjection())
    )
  }
}

export function createProjectedLinkSession<TEvent = Event>(
  options: ProjectedLinkSessionOptions<TEvent>,
): ProjectedLinkSession<TEvent> {
  return new HostLinkSession(options)
}
