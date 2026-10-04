export { GhosttyError } from './core/error.js'
export { TERMINAL_READ_LINES_MAX_ROWS } from './core/grid-text.js'
export { GhosttyRenderState } from './core/render-state.js'
export { GhosttyRuntime } from './core/runtime.js'
export { GhosttyTerminal } from './core/terminal.js'
export { GHOSTTY_SOURCE_REPOSITORY, GHOSTTY_SOURCE_REVISION } from './core/version.js'
export { calculateTerminalFittedFont, fitTerminalFont } from './dom/fit.js'
export { Terminal } from './dom/terminal.js'
export { WebGpuTerminalRenderer } from './render/renderer.js'
export { TerminalSession } from './term/session.js'
export type {
  SelectionAutoscrollDirection,
  SelectionCoordinates,
  SelectionDragEvent,
  SelectionGestureGeometry,
  SelectionGestureRelease,
  SelectionGestureUpdate,
  SelectionPoint,
  SelectionPressEvent,
  SelectionSurfacePosition,
} from './core/selection.js'
export type {
  CellStyle,
  ClipboardRepresentation,
  ClipboardWrite,
  DamageSnapshot,
  DecodedPng,
  DeviceAttributes,
  ReadLinesOptions,
  ReadRowsOptions,
  ReadTextRowsOptions,
  RenderTextRow,
  RenderCell,
  RenderCursorSnapshot,
  RenderCursorViewport,
  RenderRow,
  RgbColor,
  RuntimeOptions,
  TerminalColors,
  TerminalGeometry,
  TerminalMeasuredText,
  TerminalPrintingUnit,
  TerminalTextMeasurement,
  TerminalCursor,
  TerminalCursorStyle,
  TerminalEffects,
  TerminalLine,
  TerminalOptions,
  TerminalPoint,
  TerminalPointTag,
  TerminalScrollbar,
  TerminalSelectionFormatOptions,
  TerminalSize,
  WasmSource,
} from './core/types.js'
export type { DomClipboardWriteDecision, DomClipboardWritePolicy } from './dom/clipboard.js'
export type { TerminalElementPadding, TerminalElementPaddingInput } from './dom/elements.js'
export type {
  TerminalFitEnvironment,
  TerminalFitFont,
  TerminalFitGrid,
  TerminalFitResizeObserver,
  TerminalFitResult,
  TerminalFontMeasurement,
} from './dom/fit.js'
export type { TerminalPointerOwner } from './dom/pointer.js'
export type { TerminalApi, TerminalResult } from './dom/terminal-api.js'
export type {
  Contributions,
  Extension,
  ExtensionHandle,
  ExtensionInput,
  ExtensionScope,
  ExtensionValue,
  TerminalInputEvent,
  TerminalInputHandler,
} from './extensions/types.js'
export type { TerminalScrollbarClock } from './dom/scrollbar.js'
export type {
  GhosttyWebGpuFrameHandler,
  GhosttyWebGpuRenderer,
  GhosttyWebGpuRendererFactory,
  GhosttyWebGpuTerminalAccessibilityOptions,
  GhosttyWebGpuTerminalAppearanceApi,
  GhosttyWebGpuTerminalCopy,
  GhosttyWebGpuTerminalDiagnostics,
  GhosttyWebGpuTerminalEventMap,
  GhosttyWebGpuTerminalEventType,
  GhosttyWebGpuTerminalLifecycle,
  GhosttyWebGpuTerminalListener,
  GhosttyWebGpuTerminalKeyboardOptions,
  GhosttyWebGpuTerminalOptions,
  GhosttyWebGpuTerminalResizeEvent,
  GhosttyWebGpuTerminalScrollbarOptions,
  GhosttyWebGpuTerminalSubscription,
  GhosttyWebGpuThemeProjection,
  TerminalHotkeyBinding,
  TerminalHotkeyContext,
  TerminalHotkeyDecision,
} from './dom/types.js'
export type {
  RendererFrameCell,
  RendererFrameRow,
  RendererFrameSnapshot,
  RendererTextFrameRow,
  RendererTextFrameSnapshot,
  RendererGridSize,
  RendererMetrics,
  RenderStateSource,
  WebGpuTerminalRendererOptions,
} from './render/renderer.js'
export type { CursorState, CursorStyle, RendererTheme } from './render/instances/types.js'
export type {
  LinkActivation,
  LinkCell,
  LinkHit,
  LinkLineSnapshot,
  LinkProvider,
  LinkProviderRegistration,
  LinkRange,
  LinkResolution,
  LinkResolverError,
  LinkResolverOptions,
  ProvidedLink,
} from './term/links.js'
export type {
  TerminalAppearance,
  TerminalAppearanceEvent,
  TerminalAppearanceOptions,
  TerminalBellEvent,
  TerminalClipboardLocation,
  TerminalClipboardRepresentation,
  TerminalClipboardWrite,
  TerminalClipboardWritePolicy,
  TerminalClipboardWriteResult,
  TerminalColor,
  TerminalColorScheme,
  TerminalCursorSettings,
  TerminalCursorSnapshot,
  TerminalDataEvent,
  TerminalErrorEvent,
  TerminalFontSettings,
  TerminalFittedFont,
  TerminalGrid,
  TerminalInputData,
  TerminalInputResult,
  TerminalKeyAction,
  TerminalKeyInput,
  TerminalLinkRequest,
  TerminalModifiers,
  TerminalModifierSide,
  TerminalMouseAction,
  TerminalMouseButton,
  TerminalMouseEvent,
  TerminalMouseGeometry,
  TerminalMouseInput,
  TerminalMouseState,
  TerminalMutationResult,
  TerminalRendererTheme,
  TerminalRenderRequestEvent,
  TerminalResizeEvent,
  TerminalScrollEvent,
  TerminalSelectionDragInput,
  TerminalSelectionEvent,
  TerminalSelectionPressInput,
  TerminalSelectionReleaseInput,
  TerminalSessionEventMap,
  TerminalSessionEventType,
  TerminalSessionListener,
  TerminalSessionOptions,
  TerminalSessionRuntime,
  TerminalSessionSubscription,
  TerminalTheme,
  TerminalTitleEvent,
} from './term/types.js'

export { paintTerminalViewport, TERMINAL_VIEWPORT_MAX_BYTES } from './dom/viewport.js'
export type { TerminalViewportOptions, TerminalViewportPaint } from './dom/viewport.js'

export { DomTerminalRenderer, renderFrameToHtml } from './render/dom/renderer.js'
export type { RenderFrameHtmlOptions } from './render/dom/renderer.js'
export { snapshotRenderState } from './render/frame.js'

export type { TerminalSubmittedFrame, TerminalSubmittedRow } from './dom/submitted-frame.js'
