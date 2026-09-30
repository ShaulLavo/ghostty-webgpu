# History API

`Terminal`, `TerminalSession`, and `GhosttyTerminal` expose synchronous text reads from the active terminal screen.
Reads use the current emulator state and are available before a DOM terminal opens or paints.
They leave the viewport and selection unchanged.

## `lineCount()`

Returns the number of retained scrollback rows plus visible rows on the active screen.
The count includes empty visible rows.
History eviction changes the oldest retained row, so indices identify the current emulator state.

## `readLines(start, end, options?)`

Returns `readonly TerminalLine[]` for the half-open interval `[start, end)`.
Index `0` identifies the oldest retained scrollback row.
Visible rows follow scrollback in order.

```ts
interface TerminalLine {
  text: string
  wrapped: boolean
}

interface ReadLinesOptions {
  trimRight?: boolean
}
```

`text` comes from the native libghostty formatter with wrapping and trimming disabled.
Wide-character spacer cells contribute no text.
Empty cells before written text contribute spaces; the native formatter omits empty trailing grid padding.
`trimRight` defaults to `true` and removes trailing U+0020 spaces from each formatted row.
It preserves graphemes formed from a space and combining marks, plus non-breaking, em, and ideographic spaces.
With `trimRight: false`, written trailing spaces and graphemes remain as native formatting emits them.
Trailing empty rows are restored from the requested row count, so every requested row keeps its index.

`wrapped` is `true` when the row soft-wraps into the next row.
It is the upstream `GHOSTTY_ROW_DATA_WRAP` flag.
Rows remain separate even when soft-wrapped.

Indices clamp to `[0, lineCount()]`.
Fractional indices truncate toward zero before clamping.
Infinite endpoints clamp to the corresponding boundary.
A reversed or empty interval returns an empty array.
An endpoint that is not a number, including `NaN`, raises `GhosttyError`.
Reads after disposal raise `GhosttyError`.

A call returns at most `TERMINAL_READ_LINES_MAX_ROWS`, currently `1024`.
The exported constant bounds decoded allocations and synchronous row-metadata lookups through upstream history pages.
A larger interval returns its first capped batch.
Each subsequent batch starts after the previous batch's returned rows.
Each call reads one current state. Pagination across calls is a live view: writes, trimming, or reflow between calls can shift indices and cause skipped or repeated output.

## Screens

Reads cover the currently active screen.
While the alternate screen is active, its rows and count are available.
Primary-screen history becomes available when the primary screen is active again.
The upstream grid-reference API has no inactive-screen selector.

## Selection and visible rows

History and selection share the native libghostty text formatter.
History passes a borrowed full-row range and splits the formatted text into rows.
Selection delegates directly to the installed native selection, preserving its rules for partial columns, rectangles, blank rows, soft-wrap joining, and VT/HTML output.
Selection text is uncapped; the history row cap applies only to `readLines`.

`unwrap: true` joins soft-wrapped rows in rectangular selections too.
Selection trimming follows upstream's grapheme rules.
For example, history preserves `"x ́"` and `" ́y"`, while trimmed selection returns `"x"` and `" y"`.
The pinned native formatter drops a separator at page boundaries for rectangles that start after column zero and omits a wrapped wide glyph at a page-edge selection endpoint.
Gesture and low-level selection expose the same native output in those cases.

`visibleLines()` retains its existing behavior.
It reads the last rendered frame and returns strings for that frame's visible rows.

## CPU copy-cost probe

After building, run `bun scripts/selection-copy-probe.ts <output.json> [baseline.json]` from the package directory.
The probe launches headless Chromium, writes deterministic 80-column rows into a 24-row grid, and asserts exactly 1,025 and 50,001 retained rows.
The small fixture uses the normal native byte limit; the large fixture removes that limit through a NULL option pointer and asserts `NoValue` from its getter.
It warms each path and records three public-then-native paired selection reads plus capped history reads.
Equality checks run outside the timed spans. An optional baseline JSON also checks identical history rows before and after a change.
The measurements describe CPU text copying; SwiftShader is used only to launch the browser.
