export const zigFrameContents = [
  'plain ASCII abc 123',
  '\x1b[31;44mANSI\x1b[0m default',
  '\x1b[38;5;202;48;5;17mindexed',
  '\x1b[38;2;19;91;173;48;2;31;42;53mtruecolor',
  '\x1b[1;3;2;4;7;9;53mstyled\x1b[0m\x1b[8mhidden',
] as const

export const zigUnicodeFixtures = [
  { name: 'ASCII', content: 'ASCII abc XYZ 0123 !@#' },
  { name: 'accented Latin', content: 'café naïve Ångström ç ÿ' },
  { name: 'box drawing', content: '┌─┬─┐│╬│└─┴─┘ ╭╮╰╯' },
  { name: 'Nerd Font and Powerline', content: '   ' },
  { name: 'CJK wide', content: 'A界B漢字C日本語D' },
  { name: 'combining marks', content: 'é ä́ ñ x̧́' },
  { name: 'emoji ZWJ and variation', content: '👩‍💻 👨‍👩‍👧‍👦 ❤️ 🏳️‍🌈' },
  { name: 'legacy emoji segmentation', content: '\x1b[?2027l👩‍💻 👨‍👩‍👧‍👦' },
  { name: 'emoji modifiers and flags', content: '👍🏽 🇯🇵 🧑🏿‍🚀' },
  { name: 'styled Unicode', content: '\x1b[1;3m界éé👩‍💻\x1b[0m' },
  { name: 'colored Unicode', content: '\x1b[38;2;19;91;173;48;2;31;42;53m界é👩‍💻\x1b[0m' },
] as const

export const zigGlyphCollisionFixtures = [
  { name: 'full codepoints with equal low seven bits', content: 'AÁŁ' },
  { name: 'supplementary codepoints with equal low sixteen bits', content: '\u{1f600}\u{2f600}' },
  { name: 'combining sequences sharing a base', content: 'e é è ȩ́' },
  { name: 'ZWJ sequences sharing an emoji prefix', content: '👩 👩‍💻 👩‍🚀' },
  { name: 'bold and italic Unicode keys', content: 'é\x1b[1mé\x1b[0;3mé\x1b[1mé\x1b[0m' },
  {
    name: 'same grapheme with different brushes',
    content: '\x1b[31;44mé\x1b[32;45mé\x1b[7mé\x1b[0m',
  },
] as const

export const zigFrameCursorStyles = ['block', 'bar', 'underline', 'outline'] as const
