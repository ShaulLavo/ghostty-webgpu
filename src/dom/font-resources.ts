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
  const known = new WeakSet<FontFace>(fonts)
  const refreshed = new WeakSet<FontFace>()
  const complete = (faces: readonly FontFace[]) => {
    if (signal.aborted) return
    const requested = family()
    const changed = faces.filter(
      (face) => !refreshed.has(face) && fontResourcesMatch(requested, [face]),
    )
    if (changed.length === 0) return
    for (const face of changed) refreshed.add(face)
    refresh()
  }
  const completed = (event: FontFaceSetLoadEvent) => complete(event.fontfaces)
  const loading = () => {
    const requested = family()
    const current = Array.from(fonts)
    const pending = current.filter(
      (face) =>
        (face.status === 'loading' || !known.has(face)) && fontResourcesMatch(requested, [face]),
    )
    for (const face of current) known.add(face)
    if (pending.length === 0) return
    // Cached Safari faces can already be loaded when their loading event arrives.
    void fonts.ready.then(() => complete(pending))
  }
  fonts.addEventListener('loading', loading, { signal })
  fonts.addEventListener('loadingdone', completed, { signal })
  fonts.addEventListener('loadingerror', completed, { signal })
  loading()
}
