import { load, names, type PieceName } from 'ascii.rest'
import type { Piece } from 'ascii.rest'
import { sceneTheme, type SceneTheme } from './theme'

// How much of a cell each of a scene's dots inks, as ascii.rest weighs them.
const INK: Readonly<Record<string, number>> = { '·': 0.15, '•': 0.45, '●': 0.9 }

export interface Scene {
  readonly name: PieceName
  readonly label: string
  readonly theme: SceneTheme
}

/** Each palette entry's share of the ink in the scene's resting frame. */
function inkShares(piece: Piece): number[] {
  const { cols, rows, palette = [] } = piece.meta
  const color = new Uint8Array(cols * rows)
  const lines = piece
    .default(piece.meta.options)(piece.meta.still ?? 0, { paper: false, color })
    .split('\n')
  const shares = new Array<number>(palette.length).fill(0)
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x++) shares[color[y * cols + x]!]! += INK[line[x]!] ?? 0
  })
  const total = shares.reduce((sum, share) => sum + share, 0) || 1
  return shares.map((share) => share / total)
}

let scenes: Promise<Scene[]> | undefined

/** ascii.rest's full-colour scenes: square-celled pictures on a ground of their own. Every page shares one load. */
export function loadScenes(): Promise<Scene[]> {
  scenes ??= readScenes()
  return scenes
}

async function readScenes(): Promise<Scene[]> {
  const pieces = await Promise.all(
    names.map(async (name) => ({ name, piece: (await load[name]()) as Piece })),
  )
  return pieces
    .filter(
      ({ piece: { meta } }) =>
        meta.category === 'scenes' && meta.cell === 1 && meta.palette && meta.ground,
    )
    .map(({ name, piece }) => ({
      name,
      label: piece.meta.name,
      theme: sceneTheme(piece.meta.palette!, piece.meta.ground!, inkShares(piece)),
    }))
}
