export type CaptureGeometry = {
  element: { left: number; top: number; right: number; bottom: number }
  tester: {
    scrollX: number
    scrollY: number
    width: number
    height: number
    dpr: number
    visual: { offsetLeft: number; offsetTop: number; scale: number }
  }
  frame: { left: number; top: number; width: number; height: number; cornersHitFrame: boolean }
  top: {
    scrollX: number
    scrollY: number
    dpr: number
    visual: { offsetLeft: number; offsetTop: number; width: number; height: number; scale: number }
  }
}

export type DeviceCrop = { x: number; y: number; width: number; height: number }

export class UnsupportedCapture extends Error {}

// WebDriver serializes this function, so it must have no module-scope dependencies.
export function prepareCapture(element: Element): null {
  element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' })
  const view = element.ownerDocument.defaultView
  if (!view || view === view.top || view.parent !== view.top || !view.frameElement) return null
  const inner = view
  function delta(start: number, end: number, min: number, max: number): number {
    if (end - start > max - min) return 0
    if (start < min) return Math.floor(start - min)
    if (end > max) return Math.ceil(end - max)
    return 0
  }
  function envelope() {
    const rect = element.getBoundingClientRect()
    return {
      left: Math.floor(rect.left + inner.scrollX) - inner.scrollX,
      top: Math.floor(rect.top + inner.scrollY) - inner.scrollY,
      right: Math.ceil(rect.right + inner.scrollX) - inner.scrollX,
      bottom: Math.ceil(rect.bottom + inner.scrollY) - inner.scrollY,
    }
  }
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const css = view.getComputedStyle(parent)
    if (css.overflowX === 'visible' && css.overflowY === 'visible') continue
    const rect = parent.getBoundingClientRect()
    const box = envelope()
    const left = rect.left + parseFloat(css.borderLeftWidth)
    const top = rect.top + parseFloat(css.borderTopWidth)
    parent.scrollBy({
      behavior: 'instant',
      left: delta(box.left, box.right, left, left + parent.clientWidth),
      top: delta(box.top, box.bottom, top, top + parent.clientHeight),
    })
  }
  const box = envelope()
  view.scrollBy({
    behavior: 'instant',
    left: delta(box.left, box.right, 0, view.innerWidth),
    top: delta(box.top, box.bottom, 0, view.innerHeight),
  })
  const frame = view.frameElement
  const outer = view.parent
  const visual = outer.visualViewport
  if (!frame || !visual) return null
  const frameRect = frame.getBoundingClientRect()
  const css = outer.getComputedStyle(frame)
  const originX = frameRect.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft)
  const originY = frameRect.top + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop)
  const finalBox = envelope()
  outer.scrollBy({
    behavior: 'instant',
    left: delta(
      originX + finalBox.left,
      originX + finalBox.right,
      visual.offsetLeft,
      visual.offsetLeft + visual.width,
    ),
    top: delta(
      originY + finalBox.top,
      originY + finalBox.bottom,
      visual.offsetTop,
      visual.offsetTop + visual.height,
    ),
  })
  const visibleFrame = frame.getBoundingClientRect()
  const visibleX = visibleFrame.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft)
  const visibleY = visibleFrame.top + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop)
  const visibleBox = envelope()
  view.scrollBy({
    behavior: 'instant',
    left: delta(
      visibleBox.left,
      visibleBox.right,
      Math.max(0, visual.offsetLeft - visibleX),
      Math.min(view.innerWidth, visual.offsetLeft + visual.width - visibleX),
    ),
    top: delta(
      visibleBox.top,
      visibleBox.bottom,
      Math.max(0, visual.offsetTop - visibleY),
      Math.min(view.innerHeight, visual.offsetTop + visual.height - visibleY),
    ),
  })
  return null
}

// Both observations execute this identical function in the selected tester document.
export function measureCapture(element: Element): CaptureGeometry | null {
  const view = element.ownerDocument.defaultView
  if (!view || !element.isConnected || view.parent !== view.top || view === view.top) return null
  const frame = view.frameElement
  const outer = view.parent
  if (!frame || frame.localName !== 'iframe') return null
  if (!view.visualViewport || !outer.visualViewport) return null

  function translationOnly(start: Element | null): boolean {
    for (let current = start; current; current = current.parentElement) {
      const style = current.ownerDocument.defaultView!.getComputedStyle(current)
      const matrix = new DOMMatrixReadOnly(style.transform)
      if (!matrix.is2D || matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== 1)
        return false
      if (style.rotate !== 'none' || style.scale !== 'none' || style.perspective !== 'none')
        return false
      if (style.zoom !== '1' && style.zoom !== 'normal') return false
    }
    return true
  }
  if (!translationOnly(frame) || !translationOnly(element)) return null
  const rect = element.getBoundingClientRect()
  const frameRect = frame.getBoundingClientRect()
  const style = outer.getComputedStyle(frame)
  const insetLeft = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
  const insetTop = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
  const width =
    frameRect.width -
    insetLeft -
    parseFloat(style.borderRightWidth) -
    parseFloat(style.paddingRight)
  const height =
    frameRect.height -
    insetTop -
    parseFloat(style.borderBottomWidth) -
    parseFloat(style.paddingBottom)
  const left = frameRect.left + insetLeft
  const top = frameRect.top + insetTop
  const l = Math.floor(rect.left + view.scrollX) - view.scrollX
  const t = Math.floor(rect.top + view.scrollY) - view.scrollY
  const r = Math.ceil(rect.right + view.scrollX) - view.scrollX
  const b = Math.ceil(rect.bottom + view.scrollY) - view.scrollY
  const corners = [
    [l, t],
    [r, t],
    [l, b],
    [r, b],
  ]
  const cornersHitFrame = corners.every(
    ([x = 0, y = 0]) =>
      outer.document.elementFromPoint(
        left + x + (x === r ? -0.001 : 0.001),
        top + y + (y === b ? -0.001 : 0.001),
      ) === frame,
  )
  // A scroll container can clip the envelope even when the tester itself contains it.
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const css = view.getComputedStyle(ancestor)
    if (css.overflowX === 'visible' && css.overflowY === 'visible') continue
    const box = ancestor.getBoundingClientRect()
    const x = box.left + parseFloat(css.borderLeftWidth)
    const y = box.top + parseFloat(css.borderTopWidth)
    if (css.overflowX !== 'visible' && (l < x || r > x + ancestor.clientWidth)) return null
    if (css.overflowY !== 'visible' && (t < y || b > y + ancestor.clientHeight)) return null
  }
  return {
    element: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    tester: {
      scrollX: view.scrollX,
      scrollY: view.scrollY,
      width: view.innerWidth,
      height: view.innerHeight,
      dpr: view.devicePixelRatio,
      visual: {
        offsetLeft: view.visualViewport.offsetLeft,
        offsetTop: view.visualViewport.offsetTop,
        scale: view.visualViewport.scale,
      },
    },
    frame: { left, top, width, height, cornersHitFrame },
    top: {
      scrollX: outer.scrollX,
      scrollY: outer.scrollY,
      dpr: outer.devicePixelRatio,
      visual: {
        offsetLeft: outer.visualViewport.offsetLeft,
        offsetTop: outer.visualViewport.offsetTop,
        width: outer.visualViewport.width,
        height: outer.visualViewport.height,
        scale: outer.visualViewport.scale,
      },
    },
  }
}

function integer(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value - Math.round(value)) > 1e-6)
    throw new UnsupportedCapture('Capture edge is not an integer device pixel')
  return Math.round(value)
}

export function planEnclosingCrop(
  geometry: CaptureGeometry,
  image: { width: number; height: number },
): DeviceCrop {
  const { element, tester, frame, top } = geometry
  const dimensions = [
    tester.width,
    tester.height,
    frame.width,
    frame.height,
    top.visual.width,
    top.visual.height,
    tester.dpr,
    top.dpr,
  ]
  const coordinates = [
    element.left,
    element.top,
    element.right,
    element.bottom,
    tester.scrollX,
    tester.scrollY,
    frame.left,
    frame.top,
    top.scrollX,
    top.scrollY,
    top.visual.offsetLeft,
    top.visual.offsetTop,
  ]
  if (
    !dimensions.every((value) => Number.isFinite(value) && value > 0) ||
    !coordinates.every(Number.isFinite)
  )
    throw new UnsupportedCapture('Capture geometry must be finite and positive')
  if (
    tester.visual.offsetLeft !== 0 ||
    tester.visual.offsetTop !== 0 ||
    tester.visual.scale !== 1 ||
    top.visual.scale !== 1 ||
    tester.dpr !== top.dpr
  )
    throw new UnsupportedCapture('Unsupported capture viewport scale')
  if (
    Math.abs(frame.width - tester.width) > 1e-6 ||
    Math.abs(frame.height - tester.height) > 1e-6 ||
    !frame.cornersHitFrame
  )
    throw new UnsupportedCapture('Capture frame is scaled or obstructed')
  const left = Math.floor(element.left + tester.scrollX) - tester.scrollX
  const upper = Math.floor(element.top + tester.scrollY) - tester.scrollY
  const right = Math.ceil(element.right + tester.scrollX) - tester.scrollX
  const bottom = Math.ceil(element.bottom + tester.scrollY) - tester.scrollY
  if (
    left < 0 ||
    upper < 0 ||
    right <= left ||
    bottom <= upper ||
    right > tester.width ||
    bottom > tester.height
  )
    throw new UnsupportedCapture('Element envelope does not fit the tester viewport')
  const x = integer((frame.left + left - top.visual.offsetLeft) * tester.dpr)
  const y = integer((frame.top + upper - top.visual.offsetTop) * tester.dpr)
  const width = integer((right - left) * tester.dpr)
  const height = integer((bottom - upper) * tester.dpr)
  const viewportWidth = integer(top.visual.width * tester.dpr)
  const viewportHeight = integer(top.visual.height * tester.dpr)
  if (x < 0 || y < 0 || x + width > viewportWidth || y + height > viewportHeight)
    throw new UnsupportedCapture('Element envelope does not fit the top visual viewport')
  if (image.width !== viewportWidth || image.height !== viewportHeight)
    throw new UnsupportedCapture(
      `Viewport PNG ${image.width} by ${image.height} does not match visual viewport ${viewportWidth} by ${viewportHeight} at device scale`,
    )
  if (x + width > image.width || y + height > image.height)
    throw new UnsupportedCapture('Element envelope does not fit the PNG')
  return { x, y, width, height }
}
