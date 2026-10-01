interface FitPadding {
  readonly bottom: number
  readonly left: number
  readonly right: number
  readonly top: number
}

// TerminalFitController rounds each inset separately in device pixels.
export function roundedFitPadding(padding: FitPadding, pixelRatio: number): FitPadding {
  return {
    bottom: Math.round(padding.bottom * pixelRatio) / pixelRatio,
    left: Math.round(padding.left * pixelRatio) / pixelRatio,
    right: Math.round(padding.right * pixelRatio) / pixelRatio,
    top: Math.round(padding.top * pixelRatio) / pixelRatio,
  }
}

export function fittedScreenHeight(rows: number, cellHeight: number, padding: FitPadding): number {
  // clientHeight is integer CSS pixels; headroom prevents floating-point cell-boundary underflow.
  return Math.ceil(rows * cellHeight + padding.top + padding.bottom) + 1
}
