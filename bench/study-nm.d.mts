import type { Driver } from './comparison-entry.js'
export function createNm(
  host: HTMLElement,
  options: {
    fontFamily: string
    fontSize: number
    lineHeight: number
    scrollback: number
    columns: number
    rows: number
  },
): Promise<Driver>
