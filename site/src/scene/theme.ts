export interface SceneTheme {
  readonly ground: string
  readonly surface: string
  readonly line: string
  readonly text: string
  readonly muted: string
  readonly accent: string
  readonly accentText: string
  readonly second: string
}

interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

const parse = (hex: string): Rgb => {
  const value = Number.parseInt(hex.slice(1, 7), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

const format = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => ({
  r: from.r + (to.r - from.r) * amount,
  g: from.g + (to.g - from.g) * amount,
  b: from.b + (to.b - from.b) * amount,
})

const linear = (channel: number) => {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const luminance = ({ r, g, b }: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

const contrast = (a: Rgb, b: Rgb) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

const chroma = ({ r, g, b }: Rgb) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255

const hue = ({ r, g, b }: Rgb) => {
  const max = Math.max(r, g, b)
  const span = max - Math.min(r, g, b)
  if (span === 0) return 0
  if (max === r) return (((g - b) / span) % 6) * 60
  if (max === g) return ((b - r) / span + 2) * 60
  return ((r - g) / span + 4) * 60
}

const hueDistance = (a: Rgb, b: Rgb) => {
  const distance = Math.abs(hue(a) - hue(b)) % 360
  return Math.min(distance, 360 - distance)
}

const white: Rgb = { r: 255, g: 255, b: 255 }

/** Raises a colour toward white until it reads on the ground at `ratio`. */
function readable(color: Rgb, ground: Rgb, ratio: number): Rgb {
  let amount = 0
  let result = color
  while (contrast(result, ground) < ratio && amount < 1) {
    amount += 0.05
    result = mix(color, white, amount)
  }
  return result
}

/**
 * The site's colours from a scene: its ground, its palest tone for text, and for accents the vivid colours the
 * picture spends the most ink on. `ink` is each palette entry's share of the drawn frame.
 */
export function sceneTheme(
  palette: readonly string[],
  groundHex: string,
  ink: readonly number[],
): SceneTheme {
  const ground = parse(groundHex)
  const colors = palette.map(parse)
  const palest = colors.reduce((best, color) => (luminance(color) > luminance(best) ? color : best))
  const text = readable(mix(palest, white, 0.25), ground, 13)
  // Vivid, bright enough to carry a button, and a colour the picture is made of, not one stray lamp.
  const presence = (index: number) =>
    chroma(colors[index]!) * Math.min(1, luminance(colors[index]!) * 4) * Math.sqrt(ink[index] ?? 0)
  const ranked = Array.from(colors.keys())
    .sort((a, b) => presence(b) - presence(a))
    .map((index) => colors[index]!)
  const accent = readable(ranked[0]!, ground, 6)
  const second = readable(
    ranked.find((color) => hueDistance(color, accent) > 50) ?? ranked[1] ?? accent,
    ground,
    5,
  )
  return {
    ground: format(ground),
    surface: format(mix(ground, text, 0.06)),
    line: format(mix(ground, text, 0.16)),
    text: format(text),
    muted: format(readable(mix(text, ground, 0.45), ground, 4.5)),
    accent: format(accent),
    accentText: format(ground),
    second: format(second),
  }
}
