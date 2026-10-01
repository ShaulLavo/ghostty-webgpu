import { calculateTerminalFittedFont } from '../../../dom/fit.js'

export const probeInput =
  '\x1b[?25l\x1b[38;2;10;20;30m\x1b[48;2;40;50;60m\x1b[1mAB\x1b[0m界é<&"\r\nsecond\x1b[?25h\x1b[1;2H'
export const probeFont = calculateTerminalFittedFont(
  { family: 'monospace', size: 16, weight: 400, boldWeight: 700, letterSpacing: 0, lineHeight: 1 },
  { advanceWidth: 10, fontAscent: 15, fontDescent: 5 },
  1,
)
