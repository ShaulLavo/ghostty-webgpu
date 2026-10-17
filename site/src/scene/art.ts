import { banner } from 'ascii.rest/banner'
import { barChart, card, progressBar, spinner, type KitPiece } from 'ascii.rest/kit'
import type { Piece } from 'ascii.rest'
import { frameHtml } from './ascii-html'
import type { SceneTheme } from './theme'

/**
 * The page's ascii.rest pieces, each in the scene's colours: the wordmark on a canvas, the rest as HTML text the server
 * writes and the page animates.
 */
export type Art = (theme?: SceneTheme) => Piece

export const wordmark: Art = (theme) =>
  banner(
    'ghostty-webgpu',
    theme ? { color: [theme.accent, theme.second], effect: 'glint' } : { effect: 'still' },
  )

export const fact =
  (title: string, text: string): Art =>
  (theme) =>
    card({ title, text, width: 34, ...(theme && { color: theme.accent }) })

export const chart =
  (data: Readonly<Record<string, number>>, max: number): Art =>
  (theme) =>
    barChart(data, { horizontal: true, max, size: 24, ...(theme && { color: theme.accent }) })

export const score =
  (label: string, value: number | (() => number), ours: boolean): Art =>
  (theme) =>
    progressBar({
      label,
      value,
      width: 28,
      ...(theme && { color: ours ? theme.accent : theme.muted }),
    })

export const working: Art = (theme) =>
  spinner('dots', theme ? { color: theme.second } : {}) as KitPiece

// Stand-ins for the scene's colours on the server, where the visitor's scene is not known yet: each becomes the CSS
// variable that the page's theme sets. ascii.rest's own text and greys stay as it paints them.
const STAND_INS: Readonly<Record<string, string>> = {
  '#a00001': 'var(--accent)',
  '#a00002': 'var(--muted)',
  '#a00003': 'var(--second)',
}

const serverTheme = {
  accent: '#a00001',
  muted: '#a00002',
  second: '#a00003',
} as SceneTheme

/** A piece's frame at `t` as HTML for the server, its scene colours as CSS variables. */
export function serverHtml(art: Art, t?: number): string {
  const piece = art(serverTheme)
  return frameHtml(piece, t ?? piece.meta.still ?? 0, (_, hex) => STAND_INS[hex] ?? hex)
}

/** A piece's columns, for sizing its text to fit narrow screens. */
export function columns(art: Art): number {
  return art(serverTheme).meta.cols
}

/** The box the wordmark's canvas fills, as CSS custom properties: its columns and its rows in half-height cells. */
export function box(art: Art): string {
  const { cols, rows, cell = 2 } = art().meta
  return `--cols:${cols};--rows:${rows * cell}`
}

/** A piece's resting frame as plain text, for the server. */
export function still(art: Art): string {
  const piece = art()
  return piece.default(piece.meta.options)(piece.meta.still ?? 0, { paper: false })
}
