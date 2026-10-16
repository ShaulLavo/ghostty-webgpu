// One cell grid for a scene, shared by the page's inline first-frame painter (which inlines this file's source) and the
// terminal that takes over, so both draw the same cells. Plain JavaScript: the inline copy runs before any bundle.

// Below about 3 CSS pixels a dot is a smudge; narrower screens show fewer cells, sampled from the scene.
export const MIN_CELL = 3
// The terminal keeps a 1px scrollbar gutter on the right; the grid leaves it out too.
export const SCROLLBAR = 1

/**
 * Square cells in whole device pixels, a 2:1 picture `width` CSS pixels wide, rows rounded to whole cells. The terminal
 * rounds its gutter to whole device pixels and measures its host in whole CSS pixels; the grid does the same.
 */
export function sceneGrid(width, ratio, sceneCols, sceneRows) {
  const cell =
    Math.max(Math.ceil(MIN_CELL * ratio), Math.floor((width / sceneCols) * ratio)) / ratio
  const gutter = Math.max(1, Math.round(SCROLLBAR * ratio)) / ratio
  const columns = Math.floor((width - gutter) / cell)
  const rows = Math.max(1, Math.round((width * sceneRows) / sceneCols / cell))
  // Less than a cell taller than its rows, so the host's whole-pixel height still holds exactly `rows`.
  return { cell, columns, rows, height: Math.ceil(rows * cell) }
}

/** For each grid column and row, the scene cell it shows: the scene covers the grid, cropped at its middle. */
export function coverMap(columns, rows, sceneCols, sceneRows) {
  const scale = Math.max(columns / sceneCols, rows / sceneRows)
  const left = (sceneCols * scale - columns) / 2
  const top = (sceneRows * scale - rows) / 2
  return {
    mapX: Int32Array.from({ length: columns }, (_, x) =>
      Math.min(sceneCols - 1, Math.floor((x + left) / scale)),
    ),
    mapY: Int32Array.from({ length: rows }, (_, y) =>
      Math.min(sceneRows - 1, Math.floor((y + top) / scale)),
    ),
  }
}
