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
