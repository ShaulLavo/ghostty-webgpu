export const zigFrameContents = [
  'plain ASCII abc 123',
  '\x1b[31;44mANSI\x1b[0m default',
  '\x1b[38;5;202;48;5;17mindexed',
  '\x1b[38;2;19;91;173;48;2;31;42;53mtruecolor',
  '\x1b[1;3;2;4;7;9;53mstyled\x1b[0m\x1b[8mhidden',
] as const

export const zigFrameCursorStyles = ['block', 'bar', 'underline', 'outline'] as const
