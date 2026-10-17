import { banner } from 'ascii.rest/banner'
import { barChart, card, progressBar, spinner, type KitPiece } from 'ascii.rest/kit'
import type { Piece } from 'ascii.rest'
import type { SceneTheme } from './theme'

/**
 * The page's ascii.rest pieces. Without a theme each is text in one ink, the server's first frame; with the scene's
 * theme it is the same piece in the scene's colours, drawn on a canvas.
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
    barChart(data, {
      horizontal: true,
      max,
      size: 24,
      ...(theme ? { color: theme.accent } : { seconds: 0 }),
    })

export const score =
  (label: string, value: number, ours: boolean): Art =>
  (theme) =>
    progressBar({
      label,
      value,
      width: 28,
      ...(theme && { color: ours ? theme.accent : theme.muted }),
    })

export const working: Art = (theme) =>
  spinner('dots', theme ? { color: theme.second } : {}) as KitPiece

/** A piece's resting frame as text, for the server. */
export function still(art: Art): string {
  const piece = art()
  return piece.default(piece.meta.options)(piece.meta.still ?? 0, { paper: false })
}

/** The box a piece's canvas fills, as CSS custom properties: its columns and its rows in half-height cells. */
export function box(art: Art): string {
  const { cols, rows, cell = 2 } = art().meta
  return `--cols:${cols};--rows:${rows * cell}`
}
