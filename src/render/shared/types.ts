import { captureRenderAcknowledgement } from './displayed-frame.js'
import type { ZigFrameBuilder } from '../../core/zig-frame.js'
import type { GhosttyRenderState } from '../../core/render-state.js'
import type {
  CellStyle,
  RgbColor,
  RenderCell,
  ReadRowsOptions,
  RenderCursorSnapshot,
  RenderRow,
} from '../../core/types.js'
import type { RenderStateDirty } from '../../core/abi.js'
import type { TerminalFittedFont } from '../../term/types.js'
import type { CursorState, RendererTheme } from './instances/types.js'
import type { RenderSchedulerClock, TerminalPresentation } from './scheduler.js'

export interface RenderStateSource {
  readonly snapshotVersion?: number
  readonly hasSnapshot?: boolean
  readonly renderHeld?: boolean
  subscribeRenderRequest?(listener: () => void): () => void
  createFrameBuilder?(columns: number, rows: number): ZigFrameBuilder
  acknowledge(): number
  [captureRenderAcknowledgement]?(): () => number
  readCursor(): RenderCursorSnapshot
  readRows(options?: ReadRowsOptions): readonly RenderRow[]
  readTextRows?(options?: ReadRowsOptions): readonly RendererTextFrameRow[]
  update(): RenderStateDirty
}

export type RendererFrameCell = Readonly<
  Omit<RenderCell, 'background' | 'foreground' | 'style'>
> & {
  readonly background?: Readonly<RgbColor>
  readonly foreground?: Readonly<RgbColor>
  readonly style?: Readonly<CellStyle>
}

export interface RendererFrameRow extends RendererTextFrameRow {
  readonly renderCells: readonly RendererFrameCell[]
}

export interface RendererTextFrameRow {
  readonly cells: readonly string[]
  readonly continuations: readonly boolean[]
  readonly text: string
  readonly y: number
}

export interface RendererFrameSnapshot extends RendererTextFrameSnapshot {
  readonly rows: readonly RendererFrameRow[]
}

export interface RendererTextFrameSnapshot {
  readonly renderHeld?: boolean
  readonly paintedCursor?: Readonly<CursorState>
  readonly cursor: Readonly<RenderCursorSnapshot>
  readonly rows: readonly RendererTextFrameRow[]
}

export interface RendererMetrics {
  zigFrames: number
  atlasCacheHits: number
  atlasCacheMisses: number
  atlasEvictions: number
  atlasPages: number
  atlasUploadedBytes: number
  atlasUploadOperations: number
  deviceRestores: number
  draws: number
  instanceUploadOperations: number
  rebuiltRows: number
  submittedFrames: number
  uploadedBytes: number
}

type TerminalRendererMode = 'auto' | 'canvas2d-fill-text' | 'canvas2d-pixels'
export type CanvasPaintMode = 'fill-text' | 'pixels'

export interface WebGpuTerminalRendererOptions {
  /** Eligibility for initial built-in acquisition; custom device factories own their policy. */
  adapterPolicy?: 'hardware' | 'any'
  canvas: HTMLCanvasElement | OffscreenCanvas
  /** URL for the Canvas 2D pixel compositor. Defaults to the shipped SIMD/scalar pair. */
  compositorAsset?: string | URL
  columns: number
  bidi?: boolean
  cursorBlink?: boolean
  /** Opt-in SGR 5/6 animation; native Ghostty renders this text steadily. */
  textBlink?: boolean
  reducedMotion?: boolean
  deviceFactory?: () => Promise<GPUDevice>
  font: TerminalFittedFont
  onError?: (cause: unknown) => void
  /** Called after a clean render-state update needs no painting or row notification. */
  onCleanUpdate?: () => void
  onFrame?: (snapshot: RendererFrameSnapshot) => void
  /** Owned row text with lazily decoded cell strings and continuation flags. */
  onTextFrame?: (snapshot: RendererTextFrameSnapshot) => void
  /** Return false for cursor-only snapshots; row data resumes with the full viewport. */
  needsFrameRows?: () => boolean
  retainDisplayedText?: boolean
  /** Painted row IDs without requesting cell data. */
  onRowsChanged?: (rows: readonly number[]) => void
  onRowsPainted?: (rows: readonly RenderRow[]) => void
  /** `immediate` prefers WebGL2 with a desynchronized canvas; WebGPU always presents per frame. */
  presentation?: TerminalPresentation
  replaceCanvas?: () => HTMLCanvasElement | OffscreenCanvas
  renderState: GhosttyRenderState | RenderStateSource
  rendererMode?: TerminalRendererMode
  rows: number
  schedulerClock?: RenderSchedulerClock
  theme?: Partial<RendererTheme>
}

export interface RendererGridSize {
  columns: number
  rows: number
}
