export function captureCanvas({ left, top }: { left: number; top: number }): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.id = 'capture-control'
  canvas.width = 96
  canvas.height = 48
  canvas.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:32px;height:16px;padding:2px;border:3px solid; border-color:lime blue magenta red;box-sizing:content-box;background:white`
  document.body.append(canvas)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Capture control requires Canvas2D')
  context.fillStyle = '#315a9b'
  context.fillRect(0, 0, 96, 48)
  context.fillStyle = '#808080'
  context.fillRect(48, 0, 48, 48)
  context.fillStyle = 'red'
  context.fillRect(4, 4, 1, 1)
  context.fillStyle = 'blue'
  context.fillRect(5, 4, 1, 1)
  context.fillStyle = 'lime'
  context.fillRect(4, 5, 1, 1)
  return canvas
}

export const captureLandmarks: readonly { x: number; y: number; rgba: readonly number[] }[] = [
  { x: 4, y: 4, rgba: [255, 0, 0, 255] },
  { x: 5, y: 4, rgba: [0, 0, 255, 255] },
  { x: 4, y: 5, rgba: [0, 255, 0, 255] },
  { x: 24, y: 24, rgba: [49, 90, 155, 255] },
  { x: 72, y: 24, rgba: [128, 128, 128, 255] },
]
