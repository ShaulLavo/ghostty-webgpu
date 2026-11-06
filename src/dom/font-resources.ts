function decodedFamily(value: string): string {
  const token = value.trim()
  const quoted = token.startsWith('"') || token.startsWith("'")
  const name = quoted ? token.slice(1, -1) : token.replace(/\s+/g, ' ')
  return name
    .replace(
      /\\([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\n\r\f])/gi,
      (_match, hex: string | undefined, character: string | undefined) => {
        if (hex === undefined) return character ?? ''
        const point = Number.parseInt(hex, 16)
        if (point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return '\ufffd'
        return String.fromCodePoint(point)
      },
    )
    .toLowerCase()
}

export function fontResourcesMatch(
  family: string,
  faces: readonly Pick<FontFace, 'family'>[],
): boolean {
  const tokens = family.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[^,])+/g) ?? []
  const requested = new Set(tokens.map(decodedFamily))
  return faces.some((face) => requested.has(decodedFamily(face.family)))
}

export function observeFontResources({
  fonts,
  family,
  refresh,
  signal,
}: {
  fonts: FontFaceSet
  family: () => string
  refresh: () => void
  signal: AbortSignal
}): void {
  const settled = new WeakSet<FontFace>()
  for (const face of fonts) {
    if (face.status === 'loaded' || face.status === 'error') settled.add(face)
  }
  const complete = (faces: readonly FontFace[]) => {
    if (signal.aborted) return
    const requested = family()
    let changed = false
    for (const face of faces) {
      if (face.status === 'unloaded' || face.status === 'loading' || settled.has(face)) continue
      settled.add(face)
      if (fontResourcesMatch(requested, [face])) changed = true
    }
    if (changed) refresh()
  }
  const completed = (event: FontFaceSetLoadEvent) => complete(event.fontfaces)
  const loading = () => {
    // A matching load can join this cycle or settle before its loading event arrives.
    void fonts.ready.then(() => complete(Array.from(fonts)))
  }
  fonts.addEventListener('loading', loading, { signal })
  fonts.addEventListener('loadingdone', completed, { signal })
  fonts.addEventListener('loadingerror', completed, { signal })
  if (fonts.status === 'loading') loading()
}
