export function captureDiagnosticBands(): void {
  document.body.style.cssText = 'margin:0;min-height:896px;background:white'
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  const root = document.createElement('div')
  root.id = 'capture-diagnostic'
  const bands = [
    { left: 0, top: 0, width: 414, height: 12, color: '#00ffff' },
    { left: 0, top: 12, width: 12, height: 884, color: '#ffff00' },
    { left: 378, top: 12, width: 12, height: 675, color: '#8000ff' },
    { left: 12, top: 687, width: 366, height: 12, color: '#ff8000' },
    { left: 0, top: 699, width: 390, height: 197, color: '#008080' },
    { left: 390, top: 0, width: 24, height: 896, color: '#004000' },
  ]
  for (const band of bands) {
    const node = document.createElement('div')
    node.style.cssText = `position:absolute;left:${band.left}px;top:${band.top}px;width:${band.width}px;height:${band.height}px;background:${band.color}`
    root.append(node)
  }
  const env = document.createElement('div')
  env.id = 'capture-diagnostic-env'
  env.style.cssText =
    'position:absolute;width:0;height:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);pointer-events:none'
  root.append(env)
  const detail = document.createElement('canvas')
  detail.id = 'capture-diagnostic-chroma'
  detail.width = detail.height = 60
  detail.style.cssText = 'position:absolute;left:100px;top:100px;width:20px;height:20px'
  const context = detail.getContext('2d')
  if (!context) throw new Error('Diagnostic requires Canvas2D')
  for (let index = 0; index < 60; index++) {
    context.fillStyle = index % 2 === 0 ? 'red' : 'blue'
    context.fillRect(index, 0, 1, 30)
  }
  // Whole device rows keep the horizontal half independent of fractional rasterization.
  for (let row = 30; row < 60; row++) {
    context.fillStyle = row % 2 === 0 ? 'red' : 'blue'
    context.fillRect(0, row, 60, 1)
  }
  root.append(detail)
  document.body.append(root)
}
