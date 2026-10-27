import { expect, it } from 'vitest'

it.skipIf(!('devicePixelContentBoxSize' in ResizeObserverEntry.prototype))(
  'keeps device-pixel resize observations in screenshot CSS coordinates',
  async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 80
    canvas.style.cssText = 'position: fixed; left: 0; top: 0; width: 320px; height: 80px'
    const observer = new ResizeObserver((entries) => resolve(entries[0]!))
    let resolve: (entry: ResizeObserverEntry) => void
    const observation = new Promise<ResizeObserverEntry>((done) => {
      resolve = done
    })
    document.body.append(canvas)
    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' })
      const entry = await observation
      expect(window.devicePixelRatio).toBe(1)
      expect(
        Array.from(entry.devicePixelContentBoxSize, (box) => [box.inlineSize, box.blockSize]),
      ).toEqual([[canvas.width, canvas.height]])
    } finally {
      observer.disconnect()
      canvas.remove()
    }
  },
)
