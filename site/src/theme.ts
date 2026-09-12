import { rgb, type Rgb } from './ansi.js'

export const ink = rgb('#15131F')
export const mist = rgb('#ECEAF3')
export const fog = rgb('#8F8AAE')
export const dusk = rgb('#5F5B7A')
export const spectre = rgb('#7EE6CE')
export const pale = rgb('#E6E2F7')

/** The 16 ANSI colors, tuned to sit on the ink background. */
export const ansiColors: readonly Rgb[] = [
  rgb('#2A2740'),
  rgb('#F07C8C'),
  rgb('#8DDBA4'),
  rgb('#F2CF87'),
  rgb('#86A9F5'),
  rgb('#C79DF2'),
  rgb('#7EE6CE'),
  rgb('#D3D0E2'),
  rgb('#5F5B7A'),
  rgb('#FF9EAB'),
  rgb('#A9EEBD'),
  rgb('#FFE0A0'),
  rgb('#A6C1FF'),
  rgb('#DDBBFF'),
  rgb('#A5F3E1'),
  rgb('#F4F2FA'),
]

/** The xterm 256-color table with our 16 named colors in front. */
export function palette256(): Rgb[] {
  const levels = [0, 95, 135, 175, 215, 255]
  const colors = [...ansiColors]
  for (let i = 0; i < 216; i += 1) {
    colors.push({
      r: levels[Math.floor(i / 36)]!,
      g: levels[Math.floor(i / 6) % 6]!,
      b: levels[i % 6]!,
    })
  }
  for (let i = 0; i < 24; i += 1) {
    const level = 8 + i * 10
    colors.push({ r: level, g: level, b: level })
  }
  return colors
}
