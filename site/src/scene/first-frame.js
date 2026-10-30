// The scene's baked first frame, painted by an inline script before any bundle loads, on the grid the terminal will
// use (grid.js, inlined just before this file): one dot per cell, sized as Paper Mono's ·, • and ● are in that terminal.
// The site's Worker writes the frame into the page; other hosts fetch it.
const LEVEL = { '.': 1, o: 2, O: 3 }
const RADIUS = [0, 0.13, 0.28, 0.47]

const paintFrame = (text) => {
  const [size, palette, rows, colors] = text.split('|')
  if (!colors) return
  const host = document.getElementById('scene')
  const canvas = document.getElementById('scene-first')
  if (!host || !canvas) return
  const [sceneCols, sceneRows] = size.split(',').map(Number)
  const inks = palette.split(',')
  const lines = rows.split('\n')
  const dots = new Uint8Array(sceneCols * sceneRows)
  const ink = new Uint8Array(sceneCols * sceneRows)
  let at = 0
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      if (line[x] === ' ') continue
      dots[y * sceneCols + x] = LEVEL[line[x]] ?? 0
      ink[y * sceneCols + x] = colors.charCodeAt(at++) - 48
    }
  })
  const ratio = devicePixelRatio || 1
  const grid = sceneGrid(host.clientWidth, ratio, sceneCols, sceneRows, innerHeight)
  host.style.height = `${grid.height}px`
  // The stylesheet's cap only holds the space until now; the grid's whole rows can run a pixel past it.
  host.style.maxHeight = 'none'
  host.dataset.grid = `${grid.columns}x${grid.rows}`
  const cover = coverScene(grid.columns, grid.rows, sceneCols, sceneRows)
  cover.sample(dots, ink)
  canvas.width = Math.round(host.clientWidth * ratio)
  canvas.height = Math.round(grid.height * ratio)
  const context = canvas.getContext('2d')
  context.scale(ratio, ratio)
  for (let k = 0; k < cover.dots.length; k++) {
    const dot = RADIUS[cover.dots[k]]
    if (!dot) continue
    const x = k % grid.columns
    const y = (k - x) / grid.columns
    context.fillStyle = inks[cover.inks[k]]
    context.beginPath()
    context.arc((x + 0.5) * grid.cell, (y + 0.5) * grid.cell, dot * grid.cell, 0, Math.PI * 2)
    context.fill()
  }
}

const inline = document.getElementById('scene-frame').textContent
if (inline) paintFrame(inline)
else window.sceneFrame?.then(paintFrame)
