# Procedural terminal symbols

WebGPU, WebGL2, their worker entry and Canvas pixels mode share procedural atlas
glyphs. Blocks, braille, sextants and filled powerline symbols do not need font
stroke metrics. Box drawing and outlined powerline symbols require the selected
font's positive `post.underlineThickness` and `head.unitsPerEm` values. Without
those values they retain the font-text path. Plain Canvas2D and DOM use font text.

For a TrueType or OpenType SFNT font, use `readSfntFontMetrics(bytes)` from
`ghostty-webgpu`. Load the same bytes into the browser font face, then pass the
returned metadata as `appearance.font.metrics` alongside its family. Font sizes
and DPR select the rounded device-pixel em size used by Ghostty's pinned
FreeType face, then scale this raw font-unit measurement. Changing the primary
family or weight clears previously supplied metadata unless the update supplies
replacement metadata. A metric-only change invalidates font-scoped glyph caches.

The worker entry reads this metadata automatically for fonts supplied as SFNT
bytes for an unambiguous family and primary-weight match. URL sources retain their existing loading behavior. WOFF and WOFF2 data
are not SFNT; supply their original font-table values as metadata if available.
The reader returns `undefined` for unavailable, truncated or nonpositive metrics.
No ascent, underscore or other glyph estimate substitutes for an unknown metric.

For example, the bundled JetBrains Mono test face contains 1,000 units per em and
an underline thickness of 50 font units. At 14 CSS pixels its procedural stroke is
1, 1 and 2 device pixels for DPR 1, 1.25 and 2. These values come from the font file,
not a family-name rule. Metadata must belong to the font face actually loaded. Replace it when changing
the font resource, even if the family alias stays the same.
