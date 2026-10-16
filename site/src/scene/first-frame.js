// The scene's baked first frame, painted by an inline script before any bundle loads, on the grid the terminal will
// use (grid.js, inlined just before this file): one dot per cell, sized as Paper Mono's ·, • and ● are in that terminal.
// The site's Worker writes the frame into the page; other hosts fetch it.
const RADIUS = { '.': 0.13, o: 0.28, O: 0.47 }

const paintFrame = (text) => {
  const [size, palette, rows, colors] = text.split('|')
  if (!colors) return
  const host = document.getElementById('scene')
  const canvas = document.getElementById('scene-first')
  if (!host || !canvas) return
  const [sceneCols, sceneRows] = size.split(',').map(Number)
  const inks = palette.split(',')
  const lines = rows.split('\n')
  const ink = new Int16Array(sceneCols * sceneRows).fill(-1)
  let at = 0
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) {
      if (line[x] !== ' ') ink[y * sceneCols + x] = colors.charCodeAt(at++) - 48
    }
  })
  const ratio = devicePixelRatio || 1
  const grid = sceneGrid(host.clientWidth, ratio, sceneCols, sceneRows)
  host.style.height = `${grid.height}px`
  host.dataset.grid = `${grid.columns}x${grid.rows}`
  const { mapX, mapY } = coverMap(grid.columns, grid.rows, sceneCols, sceneRows)
  canvas.width = Math.round(host.clientWidth * ratio)
  canvas.height = Math.round(grid.height * ratio)
  const context = canvas.getContext('2d')
  context.scale(ratio, ratio)
  for (let y = 0; y < grid.rows; y++) {
    const line = lines[mapY[y]] ?? ''
    for (let x = 0; x < grid.columns; x++) {
      const dot = RADIUS[line[mapX[x]]]
      if (!dot) continue
      context.fillStyle = inks[ink[mapY[y] * sceneCols + mapX[x]]]
      context.beginPath()
      context.arc((x + 0.5) * grid.cell, (y + 0.5) * grid.cell, dot * grid.cell, 0, Math.PI * 2)
      context.fill()
    }
  }
}

const inline = document.getElementById('scene-frame').textContent
if (inline) paintFrame(inline)
else window.sceneFrame?.then(paintFrame)
