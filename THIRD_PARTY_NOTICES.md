# Third-party notices

## Ghostty

`ghostty-webgpu` includes `ghostty-vt.wasm`, built from Ghostty revision
`7b11f3dca034d8d24369ad3856afe57946d7902a`, and host-native config resolver executables,
built from `c8554f28e0efe2f5595f32020371c34b25ec628f`, without build-time patch application.

The resolver revision pins its separate immutable runtime-theme archive. The
executables and resources are present only for the package's supported macOS and Linux hosts.

- Source: <https://github.com/ghostty-org/ghostty>
- License: MIT

MIT License

Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Procedural terminal sprites

The procedural atlas glyphs, native comparison fixtures, and glyph constraint rules adapt Ghostty's
geometry and layout behavior at revision `7b11f3dca034d8d24369ad3856afe57946d7902a`, specifically
`src/font/sprite/draw/{box,block,braille,powerline,symbols_for_legacy_computing,common}.zig`,
`src/font/Glyph.zig`, `src/font/nerd_font_tables.zig`, and `src/renderer/cell.zig`.
The native fixture generators use the same revision's sources. Ghostty's MIT license and copyright
notice appear above.

## ghostty.org home animation

The demo site under `site/` includes the terminal animation frames from the ghostty.org website,
packed into `site/ghost-frames.txt.gz` by `site/scripts/pack-ghost-frames.ts`. They are not part
of the published npm package.

- Source: <https://github.com/ghostty-org/website>, `terminals/home/animation_frames`
- License: MIT

Copyright (c) 2024 Ghostty

The complete MIT license text appears in the Ghostty section above.

## iTerm2 Color Schemes

The native resolver resources include the Ghostty-formatted theme collection distributed by
iTerm2-Color-Schemes. The collection is MIT licensed; copyright and licensing for each individual
theme belong to that theme's author.

- Source: <https://github.com/mbadolato/iTerm2-Color-Schemes>
- License: MIT

MIT License

Copyright (c) 2011 to Present Mark Badolato

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## JetBrains Mono sprite reference font

The sprite regression fixture includes a decompressed copy of the Latin regular
font from `@fontsource/jetbrains-mono` 5.3.0. It is test data and is not included in
the npm package.

- Source: <https://github.com/JetBrains/JetBrainsMono>
- License: SIL Open Font License 1.1, reproduced in
  `src/render/shared/atlas/sprite-fixtures/FONT-LICENSE.txt`.

## JetBrains Mono Nerd Font constraint reference font

The glyph constraint regression fixture includes the unmodified JetBrains Mono Nerd Font regular
face bundled by Ghostty at revision `7b11f3dca034d8d24369ad3856afe57946d7902a`. It is test data and
is not included in the npm package.

- Source: <https://github.com/ryanoasis/nerd-fonts>, `patched-fonts/JetBrainsMono`
- License: SIL Open Font License 1.1, reproduced in
  `src/render/shared/atlas/constraint-fixtures/FONT-LICENSE.txt`.

## Noto Sans Mono

`bench/fixtures/correctness/NotoSansMono-Regular.ttf` contains Noto Sans Mono version 2.007 for
browser correctness fixtures. The font is not part of the published npm package.

- Source: <https://github.com/notofonts/noto-fonts>, `hinted/ttf/NotoSansMono/NotoSansMono-Regular.ttf`, revision `ffebf8c1ee449e544955a7e813c54f9b73848eac`
- License: SIL Open Font License 1.1

Copyright 2015-2021 Google LLC. All Rights Reserved.

The complete SIL Open Font License 1.1 text appears in
`bench/fixtures/correctness/NotoSansMono-LICENSE.txt`.

## bidi-js

The optional bidirectional text implementation uses `bidi-js` 1.0.3 and its Unicode 13.0 tables.

- Source: <https://github.com/lojjic/bidi-js>
- License: MIT

Copyright (c) 2021 Jason Johnston

MIT License

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## require-from-string

`bidi-js` declares `require-from-string` 2.0.2 as a dependency. Its browser ESM build does not import it.

- Source: <https://github.com/floatdrop/require-from-string>
- License: MIT

The MIT License (MIT)

Copyright (c) Vsevolod Strukchinsky <floatdrop@gmail.com> (github.com/floatdrop)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
