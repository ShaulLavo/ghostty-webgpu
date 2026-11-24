const faceIdentities = new WeakMap<FontFace, number>()
let nextFaceIdentity = 0

/** The font faces a canvas draws with: its document's set, or the worker's global set. */
export function fontResources(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): FontFaceSet | undefined {
  if ('ownerDocument' in canvas) return canvas.ownerDocument.fonts
  const fonts: unknown = Reflect.get(globalThis, 'fonts')
  if (typeof FontFaceSet !== 'undefined' && fonts instanceof FontFaceSet) return fonts
  if (typeof document !== 'undefined') return document.fonts
}

/** Changes whenever a face is added, removed, replaced or finishes loading. */
export function resourceIdentity(resources: FontFaceSet): string {
  return JSON.stringify(
    Array.from(resources, (face) => {
      let identity = faceIdentities.get(face)
      if (identity === undefined) {
        identity = ++nextFaceIdentity
        faceIdentities.set(face, identity)
      }
      return [
        identity,
        face.status,
        face.family,
        face.style,
        face.weight,
        face.stretch,
        face.unicodeRange,
        face.featureSettings,
        face.variationSettings,
        face.ascentOverride,
        face.descentOverride,
        face.lineGapOverride,
        Reflect.get(face, 'sizeAdjust'),
        face.display,
      ]
    }),
  )
}
