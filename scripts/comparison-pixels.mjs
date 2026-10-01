import { PNG } from 'pngjs'

export function ink(data) {
  const png = PNG.sync.read(Buffer.from(data, 'base64'))
  const colors = {
    red: 0,
    green: 0,
    redPeak: 0,
    greenPeak: 0,
    width: png.width,
    height: png.height,
  }
  for (let y = 0; y < Math.min(32, png.height); y++) {
    for (let x = 0; x < Math.min(120, png.width); x++) {
      const offset = (y * png.width + x) * 4
      const [r, g, b, a] = png.data.subarray(offset, offset + 4)
      if (a === 0) continue
      const red = ((r - Math.max(g, b)) * a) / 255
      const green = ((g - Math.max(r, b)) * a) / 255
      colors.redPeak = Math.max(colors.redPeak, red)
      colors.greenPeak = Math.max(colors.greenPeak, green)
      if (red > 48) colors.red++
      if (green > 48) colors.green++
    }
  }
  return colors
}
