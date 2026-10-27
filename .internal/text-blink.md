# Text blink

Status: Approved. Implements F10 from the October 2026 reference study.

SGR 5 and SGR 6 render steadily by default, matching native Ghostty. The `textBlink: true` extension uses a 600 ms text phase. Backgrounds and cursors remain visible when blinking foreground glyphs and decorations disappear. Text and cursor phases have independent timers. Output resets the cursor timer without postponing the text phase.

Opt-in text blink runs only when visible glyphs or decorations require it, the terminal has focus, the document is visible, and reduced motion is disabled. Losing eligibility restores visible text. Erasure, scroll, resize and disposal stop timers when no visible blink content remains. The page observes reduced motion and sends changes to the worker as well.

Native Ghostty was inspected at pinned revision `7b11f3dca034d8d24369ad3856afe57946d7902a` and reference revision `68640f3049d5ae76d7d5eebb5bbdf713a3a98713`. Its renderer has no SGR text blink implementation. `src/renderer/Thread.zig` defines `CURSOR_BLINK_INTERVAL = 600`, suspends cursor blink on focus loss, and resets it on output. The 600 ms cadence and focus policy here follow that cursor behavior. Reduced motion is an explicit browser policy; native Ghostty supplies no text blink policy to copy. This is new SGR behavior, not a claim of native SGR blink parity.

The bridge stores glyph blink in bit 1 and decoration blink in bit 3 of their existing flags. Cached rows retain a blink-presence bit through row movement. The frame reports its visible blinking-row count in the existing final four bytes of the frame header. Default-off renderers allocate no text phase manager, skip row detection and phase uniform calls, and compile out GPU phase logic. An enabled phase changes only a uniform on each GPU backend. Canvas and DOM track and repaint blinking rows. Clean GPU phase frames do not build rows or upload cell/glyph records.

Browser regressions cover both phases on WebGPU, WebGL2, Canvas fill-text, Canvas pixels and DOM. They check restoration, no record uploads on GPU phase transitions, focus/visibility/reduced motion, erasure, scroll out of view and zero idle timers/frames. The packaged worker test covers both GPU backends with real timers and screenshots.
