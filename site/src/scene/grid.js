// One cell grid for a scene, shared by the page's inline first-frame painter (which inlines this file's source) and the
// terminal that takes over, so both draw the same cells. Plain JavaScript: the inline copy runs before any bundle.

// Below about 3 CSS pixels a dot is a smudge; narrower screens show fewer cells, sampled from the scene.
export const MIN_CELL = 3
// Above about 4 CSS pixels the dots read as polka dots; wider screens show more cells, blended from the scene.
export const MAX_CELL = 4
// The terminal keeps a 1px scrollbar gutter on the right; the grid leaves it out too.
export const SCROLLBAR = 1
// A 4 by 4 ordered dither's thresholds, from 0 to under 1.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)

/**
 * Square cells in whole device pixels, a 2:1 picture `width` CSS pixels wide, rows rounded to whole cells. The terminal
 * rounds its gutter to whole device pixels and measures its host in whole CSS pixels; the grid does the same.
 */
export function sceneGrid(width, ratio, sceneCols, sceneRows) {
  const fit = Math.floor((width / sceneCols) * ratio)
  const cell =
    Math.min(Math.floor(MAX_CELL * ratio), Math.max(Math.ceil(MIN_CELL * ratio), fit)) / ratio
  const gutter = Math.max(1, Math.round(SCROLLBAR * ratio)) / ratio
  const columns = Math.floor((width - gutter) / cell)
  const rows = Math.max(1, Math.round((width * sceneRows) / sceneCols / cell))
  // Less than a cell taller than its rows, so the host's whole-pixel height still holds exactly `rows`.
  return { cell, columns, rows, height: Math.ceil(rows * cell) }
}

/**
 * Where each grid cell along one axis falls in the scene, which covers the grid cropped at its middle: the scene cell
 * at or before it, the one after, and how far toward the after one. A shrunk scene takes its nearest cell instead.
 */
function axis(length, sceneLength, scale) {
  const start = (sceneLength * scale - length) / 2
  const at = new Int32Array(length)
  const next = new Int32Array(length)
  const along = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const exact = Math.max(0, (i + 0.5 + start) / scale - 0.5)
    at[i] = Math.min(sceneLength - 1, Math.floor(scale > 1 ? exact : (i + start) / scale))
    next[i] = Math.min(sceneLength - 1, at[i] + 1)
    along[i] = scale > 1 ? Math.min(1, exact - at[i]) : 0
  }
  return { at, next, along }
}

/**
 * The scene on a grid of `columns` by `rows`: `sample` takes a frame's dots (0 for none to 3 for the largest) and
 * palette indexes, one a scene cell, and fills `dots` and `inks`, one a grid cell. A grid finer than the scene blends
 * the four nearest dots and dithers them again, so a wide screen gets more small dots rather than larger ones.
 */
export function coverScene(columns, rows, sceneCols, sceneRows) {
  const scale = Math.max(columns / sceneCols, rows / sceneRows)
  const xs = axis(columns, sceneCols, scale)
  const ys = axis(rows, sceneRows, scale)
  const dots = new Uint8Array(columns * rows)
  const inks = new Uint8Array(columns * rows)
  const corner = new Int32Array(4)
  const weight = new Float32Array(4)
  const sample = (sceneDots, sceneInks) => {
    for (let y = 0; y < rows; y++) {
      const above = ys.at[y] * sceneCols
      const below = ys.next[y] * sceneCols
      const down = ys.along[y]
      for (let x = 0; x < columns; x++) {
        const across = xs.along[x]
        corner[0] = above + xs.at[x]
        corner[1] = above + xs.next[x]
        corner[2] = below + xs.at[x]
        corner[3] = below + xs.next[x]
        weight[0] = (1 - across) * (1 - down)
        weight[1] = across * (1 - down)
        weight[2] = (1 - across) * down
        weight[3] = across * down
        const k = y * columns + x
        const level = blend(sceneDots, sceneInks, corner, weight, inks, k)
        dots[k] = Math.min(3, Math.floor(level + BAYER[(y & 3) * 4 + (x & 3)]))
      }
    }
  }
  return { columns, rows, dots, inks, sample }
}

/** The weighted mean of four scene dots; writes the ink of the one that weighs most at `inks[k]`. */
function blend(sceneDots, sceneInks, corner, weight, inks, k) {
  let level = 0
  let heaviest = 0
  for (let i = 0; i < 4; i++) {
    const share = weight[i] * sceneDots[corner[i]]
    level += share
    if (share <= heaviest) continue
    heaviest = share
    inks[k] = sceneInks[corner[i]]
  }
  return level
}
