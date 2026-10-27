import { nerdFontConstraint } from './nerd-font-constraints.js'

export type GlyphConstraintSize = 'cover' | 'fit' | 'fit_cover1' | 'none' | 'stretch'
export type GlyphConstraintAlign = 'center' | 'center1' | 'end' | 'none' | 'start'

export interface GlyphConstraint {
  alignHorizontal: GlyphConstraintAlign
  alignVertical: GlyphConstraintAlign
  height: 'cell' | 'icon'
  maxConstraintWidth: 1 | 2
  maxXyRatio: number | null
  padBottom: number
  padLeft: number
  padRight: number
  padTop: number
  relativeHeight: number
  relativeWidth: number
  relativeX: number
  relativeY: number
  size: GlyphConstraintSize
}

export interface GlyphBounds {
  height: number
  width: number
  x: number
  y: number
}

export interface GlyphConstraintMetrics {
  cellHeight: number
  cellWidth: number
  faceHeight: number
  faceWidth: number
  faceY: number
  iconHeight: number
  iconHeightSingle: number
}

const symbolFit: GlyphConstraint = {
  alignHorizontal: 'none',
  alignVertical: 'none',
  height: 'cell',
  maxConstraintWidth: 2,
  maxXyRatio: null,
  padBottom: 0,
  padLeft: 0,
  padRight: 0,
  padTop: 0,
  relativeHeight: 1,
  relativeWidth: 1,
  relativeX: 0,
  relativeY: 0,
  size: 'fit',
}

const emojiPresentation =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier})/u

export function isEmojiPresentationText(text: string): boolean {
  return emojiPresentation.test(text)
}

export function isSymbol(cp: number): boolean {
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd) ||
    (cp >= 0x2190 && cp <= 0x21ff) ||
    (cp >= 0x2700 && cp <= 0x27bf) ||
    (cp >= 0x1f600 && cp <= 0x1f64f) ||
    (cp >= 0x2600 && cp <= 0x26ff) ||
    (cp >= 0x2460 && cp <= 0x24ff) ||
    (cp >= 0x1f100 && cp <= 0x1f1ff) ||
    (cp >= 0x1f300 && cp <= 0x1f5ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff)
  )
}

function isGraphicsElement(cp: number): boolean {
  return (
    (cp >= 0x2500 && cp <= 0x257f) ||
    (cp >= 0x2580 && cp <= 0x259f) ||
    (cp >= 0x1fb00 && cp <= 0x1fbff) ||
    (cp >= 0x1cc00 && cp <= 0x1cebf) ||
    (cp >= 0xe0b0 && cp <= 0xe0d7)
  )
}

export function neighborConstraintWidth(codepoints: readonly number[], x: number): 1 | 2 {
  const cp = codepoints[x] ?? 0
  if (!isSymbol(cp)) return 1
  if (x === codepoints.length - 1) return 1
  const previous = codepoints[x - 1] ?? 0
  if (x > 0 && isSymbol(previous) && !isGraphicsElement(previous)) return 1
  const next = codepoints[x + 1] ?? 0
  if (next === 0 || next === 0x20 || next === 0x2002) return 2
  return 1
}

export function glyphConstraint(cp: number): GlyphConstraint | undefined {
  const nerd = nerdFontConstraint(cp)
  if (nerd) return nerd
  if (isSymbol(cp)) return symbolFit
  return undefined
}

function doesAnything(constraint: GlyphConstraint): boolean {
  return (
    constraint.size !== 'none' ||
    constraint.alignHorizontal !== 'none' ||
    constraint.alignVertical !== 'none'
  )
}

function scaleFactors(
  constraint: GlyphConstraint,
  group: GlyphBounds,
  metrics: GlyphConstraintMetrics,
  constraintWidth: 1 | 2,
): [number, number] {
  if (constraint.size === 'none') return [1, 1]
  const multiCell = constraintWidth > 1
  const targetWidth =
    (constraintWidth - constraint.padLeft - constraint.padRight) * metrics.faceWidth
  const iconHeight = multiCell ? metrics.iconHeight : metrics.iconHeightSingle
  const targetHeight =
    (1 - constraint.padBottom - constraint.padTop) *
    (constraint.height === 'icon' ? iconHeight : metrics.faceHeight)
  let widthFactor = targetWidth / group.width
  let heightFactor = targetHeight / group.height
  if (constraint.size === 'fit') heightFactor = Math.min(1, widthFactor, heightFactor)
  if (constraint.size === 'cover') heightFactor = Math.min(widthFactor, heightFactor)
  if (constraint.size === 'fit_cover1') {
    heightFactor = Math.min(widthFactor, heightFactor)
    if (multiCell && heightFactor > 1) {
      const [, singleHeight] = scaleFactors(constraint, group, metrics, 1)
      heightFactor = Math.max(1, singleHeight)
    }
  }
  if (constraint.size !== 'stretch') widthFactor = heightFactor
  const ratio = constraint.maxXyRatio
  if (ratio !== null && group.width * widthFactor > group.height * heightFactor * ratio) {
    widthFactor = (group.height * heightFactor * ratio) / group.width
  }
  return [widthFactor, heightFactor]
}

function alignedY(
  constraint: GlyphConstraint,
  group: GlyphBounds,
  metrics: GlyphConstraintMetrics,
): number {
  if (constraint.size === 'none' && constraint.alignVertical === 'none') return group.y
  const start = metrics.faceY + constraint.padBottom * metrics.faceHeight
  const end =
    metrics.faceY + metrics.faceHeight - group.height - constraint.padTop * metrics.faceHeight
  const center = (start + end) / 2
  if (constraint.alignVertical === 'start') return start
  if (constraint.alignVertical === 'end') return end
  if (constraint.alignVertical === 'center' || constraint.alignVertical === 'center1') {
    return center
  }
  if (end < start) return center
  return Math.max(start, Math.min(group.y, end))
}

function alignedX(
  constraint: GlyphConstraint,
  group: GlyphBounds,
  metrics: GlyphConstraintMetrics,
  constraintWidth: 1 | 2,
): number {
  if (constraint.size === 'none' && constraint.alignHorizontal === 'none') return group.x
  const fullFaceSpan = metrics.faceWidth + (constraintWidth - 1) * metrics.cellWidth
  const start = constraint.padLeft * metrics.faceWidth
  const end = fullFaceSpan - group.width - constraint.padRight * metrics.faceWidth
  if (constraint.alignHorizontal === 'start') return start
  if (constraint.alignHorizontal === 'end') return Math.max(start, end)
  if (constraint.alignHorizontal === 'center') return Math.max(start, (start + end) / 2)
  if (constraint.alignHorizontal === 'center1') {
    const end1 = metrics.faceWidth - group.width - constraint.padRight * metrics.faceWidth
    return Math.max(start, (start + end1) / 2)
  }
  return Math.max(start, Math.min(group.x, end))
}

function constrainInner(
  glyph: GlyphBounds,
  constraint: GlyphConstraint,
  metrics: GlyphConstraintMetrics,
  availableWidth: 1 | 2,
): GlyphBounds {
  const wideStretch = constraint.size === 'stretch' && metrics.faceWidth > 0.9 * metrics.faceHeight
  const constraintWidth = wideStretch
    ? 1
    : (Math.min(constraint.maxConstraintWidth, availableWidth) as 1 | 2)
  const groupWidth = glyph.width / constraint.relativeWidth
  const groupHeight = glyph.height / constraint.relativeHeight
  const group = {
    height: groupHeight,
    width: groupWidth,
    x: glyph.x - groupWidth * constraint.relativeX,
    y: glyph.y - groupHeight * constraint.relativeY,
  }
  const [widthFactor, heightFactor] = scaleFactors(constraint, group, metrics, constraintWidth)
  const centerX = group.x + group.width / 2
  const centerY = group.y + group.height / 2
  group.width *= widthFactor
  group.height *= heightFactor
  group.x = centerX - group.width / 2
  group.y = centerY - group.height / 2
  group.x = alignedX(constraint, group, metrics, constraintWidth)
  group.y = alignedY(constraint, group, metrics)
  return {
    height: heightFactor * glyph.height,
    width: widthFactor * glyph.width,
    x: group.x + group.width * constraint.relativeX,
    y: group.y + group.height * constraint.relativeY,
  }
}

// Geometry adapted from Ghostty 7b11f3d, src/font/Glyph.zig. MIT, see THIRD_PARTY_NOTICES.md.
export function constrainGlyph(
  glyph: GlyphBounds,
  constraint: GlyphConstraint,
  metrics: GlyphConstraintMetrics,
  constraintWidth: 1 | 2,
): GlyphBounds {
  if (!doesAnything(constraint)) return glyph
  if (constraint.size !== 'stretch') {
    return constrainInner(glyph, constraint, metrics, constraintWidth)
  }
  const stretchedMetrics = {
    ...metrics,
    faceHeight: metrics.cellHeight,
    faceWidth: metrics.cellWidth,
    faceY: 0,
  }
  const stretched = {
    ...constraint,
    padBottom: Math.max(0, constraint.padBottom),
    padLeft: Math.max(0, constraint.padLeft),
    padRight: Math.max(0, constraint.padRight),
    padTop: Math.max(0, constraint.padTop),
  }
  return constrainInner(glyph, stretched, stretchedMetrics, constraintWidth)
}
