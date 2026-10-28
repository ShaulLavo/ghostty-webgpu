# Terminal API and rendering

This page states the behavior that type signatures do not show: execution modes, frames, scrollback, geometry, and extensions. Signatures are in the [generated API reference](https://ghostty.shaulavo.dev/docs/reference/api/). For PTY wiring, read [browser integration](integration.md).

## execution conventions

`TerminalApi<'sync'>` describes this main-thread entry. `TerminalApi<'async'>` describes the
worker return convention: authoritative operations return promises with the same arguments.
The default `TerminalApi` accepts both conventions for await-style common callers. Host DOM,
subscriptions, focus and displayed text stay synchronous; `open()` and `focusNextLink()` already
return promises in the main entry.

## data events and synchronous replies

`onData(listener)` delivers `{ bytes, origin }`. `bytes` is an owned `Uint8Array` suitable for
forwarding to a PTY, and `origin` is one of:

- `input`: typing, pasting, mouse reports, focus reports or `sendInput`.
- `reply`: the terminal answering a query, such as a device-status report.

On the main thread, `write()` parses synchronously and emits a query reply through `onData` before
that `write()` returns. Observers can therefore reenter terminal operations. Worker calls
return promises, but the worker's native session applies the same origin labels.

```ts
terminal.onData(({ bytes, origin }) => {
  socket.send(bytes)
  if (origin === 'reply') console.debug('terminal query reply')
})
```

## headless core entry

Import `GhosttyRuntime`, `GhosttyTerminal` and `TerminalSession` from `ghostty-webgpu/core` when
an application needs terminal state without a DOM host. The core entry's runtime module graph
contains no DOM or renderer modules. The package root still exports these classes, but its graph
also includes the DOM terminal and built-in renderers.

```ts
import { GhosttyRuntime } from 'ghostty-webgpu/core'

const runtime = await GhosttyRuntime.create()
const terminal = runtime.createTerminal({ columns: 80, rows: 24 })
terminal.write('headless\r\n')
console.log(terminal.readLines(0, 1))
terminal.dispose()
runtime.dispose()
```

## batched output

`writeBatched(data, { signal })` is an opt-in asynchronous producer path in both entries. It copies
strings as UTF-8 and copies caller-owned byte arrays, then returns a promise when that write has
finished native parsing. The acknowledgement does not mean that output has been submitted or
presented. Await it before using an authoritative read as a read-after-write barrier for that
batched write. Synchronous `write()` keeps its existing immediate parse and read-after-write
behavior.

```ts
const parsed = terminal.writeBatched(output)
await parsed
const rows = await terminal.readLines(0, 24)
```

`pendingWriteBytes` reports queued bytes plus worker writes waiting for their parse
acknowledgement. `writeQueue.maxBytes` bounds that total and defaults to 8 MiB. A write that would
exceed the bound rejects without entering the queue, giving the producer a point at which to pause
input. `writeQueue.timeBudgetMs` defaults to 12 ms. The queue yields to a timer after that budget,
checked between writes; one large write can take longer. The first batched output after user input
runs immediately when no older output is queued.

An abort signal cancels its write only while that write is still queued. Active and completed writes
are unaffected. Terminal disposal rejects queued and unacknowledged writes and releases their byte
charges. Ordinary `write`, `writeln`, `writeAndReadGeometry`, reset, appearance changes and fitted
resizes flush older batched writes first, preserving stream order. Worker batched writes transfer
the queue's owned buffers to the worker; caller-owned buffers remain attached and unchanged.

## packaged worker checkpoint

The `ghostty-webgpu/worker` entry creates the same DOM host around a dedicated worker.
The worker owns its native session, WASM, fitted font, Zig frame builder and WebGPU or WebGL
renderer. Supply each font as an explicit URL or byte array with optional `FontFaceDescriptors`.
The opening acknowledgment supplies the worker-fitted cell metrics before `inputReady` runs.
First composed text uses these metrics even before a submitted frame reaches the host.
An opening reply with incomplete font metrics fails with structured protocol guidance before
`inputReady`. Host the worker and host entry from the same package build.

```ts
import { Terminal } from 'ghostty-webgpu/worker'

const terminal = await Terminal.create({
  backend: 'webgl',
  fonts: [
    {
      family: 'JetBrains Mono',
      source: { url: new URL('./fonts/jetbrains-mono.woff2', import.meta.url).href },
    },
  ],
})
await terminal.open(host)
await terminal.write('hello from the worker\r\n')
const lines = await terminal.readLines(0, 1)
terminal.focus()
await terminal.dispose()
```

Worker terminals support `fitEnvironment.getPixelRatio` and
`fitEnvironment.subscribePixelRatio`. The getter returns a finite positive DPR for each host
layout. The subscription calls its callback when that DPR changes and returns a dispose function.
Terminal disposal invokes that function and disconnects layout observation. If subscription setup
throws, `open()` rejects and disconnects the new resize observer before propagating the error.
The other fit-environment hooks remain main-thread-only because the worker owns font measurement
and scheduling.

`backend` is an option of the worker entry only. It accepts `webgpu`, `webgl` or `auto`, and
defaults to `auto`. The main-thread `Terminal.create` has no `backend` option. It takes
`rendererMode` (`auto`, `canvas2d-fill-text` or `canvas2d-pixels`) or a `rendererFactory`.
Automatic selection tries WebGL before hardware WebGPU on desktop Linux because WebGL measured
lower CPU work there, while macOS, Windows, Android, ChromeOS, and other platforms try hardware
WebGPU before WebGL. The main-thread
terminal then falls through to Canvas and DOM when both GPU renderers are unavailable.
The worker supports the same GPU order. WebGL resource allocation failures advance to the next
backend on a replacement canvas. Managed main-thread WebGL context-loss recovery follows the
remaining order, including hardware WebGPU when Linux selected WebGL first.
Automatic selection skips software WebGPU adapters.
An explicit `backend: 'webgpu'` on the worker entry uses any available WebGPU adapter,
including software adapters.

`WebGpuTerminalRenderer.create` can be passed directly as `rendererFactory`. Its
`adapterPolicy` option defaults to `any`; `hardware` requires an eligible hardware adapter
for initial acquisition. After device loss, built-in acquisition accepts any available
replacement, including software adapters, so automatic and explicit WebGPU terminals can
keep painting on their existing canvas. A supplied `deviceFactory` controls its own initial
and replacement acquisition policy. Replacement acquisition failures reach the renderer's
`onError` callback and the terminal's `error` event. Main-thread errors identify the operation
as `renderer.restore`; worker errors close the worker and release its resources.

Capability failures carry `code`, `operation`, `why`, `fix` and runtime facts. `assets` and `workerUrl` can point at explicitly hosted native files and the
built standalone `dist/worker/entry.js`; the defaults resolve beside the package output.

Writes copy caller-owned bytes and keep their buffers attached. `attachOutputPort(port)`
transfers a producer port. Its `ready` message supplies terminal and generation identities;
producer `output` messages carry those identities, a sequence starting at one, and owned bytes.
The producer may transfer its owned buffer. `fenceOutput(sequence)` makes subsequent control
operations and disposal wait until the native actor has processed that sequence.

The compiled checkpoint covers output, authoritative reads, native key/text/paste encoding,
programmatic selection and scrolling, layout, submitted text, accessibility and lifecycle.
`geometry()`, `measure(text)`, `measureTexts(readonlyTexts)` and `writeAndReadGeometry(data)`
return promises backed by the same native owner as the main entry. The last operation captures
its geometry before publishing effects, preserving prompt origin across observer writes.
Pointer selection, clipboard shortcuts, links and extension hooks still need their leaf
integrations. Worker link-provider registration and keyboard link discovery currently report
structured capability errors. Worker Canvas requests report a structured capability failure.
Publication, full interaction parity and presentation acceptance wait for their integration gates.
Packaged-entry Chromium software-GPU checks qualify correctness only.
OSC 52 remains denied by default.

## optional text blink

Native Ghostty draws SGR 5 and SGR 6 text steadily. This library preserves that default.
The attributes remain available in cell styles, but they do not start a text timer, schedule
animation frames, scan for blinking rows or run GPU phase logic.

Set `textBlink: true` in the main-thread or worker `Terminal.create` options to opt into text
animation. The same default-off option is available in renderer options for direct renderer
users and custom renderer factories. It is a creation option, independent of
`appearance.cursor.blink`.

The extension alternates foreground glyphs and decorations every 600 ms while blinking text
is visible, the terminal is focused, the document is visible and reduced motion is disabled.
Backgrounds, cursors, terminal text and accessibility text remain unchanged. Losing eligibility
restores visible text and stops its timer. A replacement renderer inherits the current
reduced-motion preference, including changes received while it is being created.

## optional ligatures

Programming ligatures such as `=>`, `!=` and `<=>` are off by default. With them off, every
backend keeps its per-cell path and pays nothing. Set `ligatures` in the main-thread or worker
`Terminal.create` options to opt in:

- `ligatures: { font }` reads the joining features (`calt`, `liga`, `clig`, `rlig`) from the
  OpenType `GSUB` table of the primary regular face. `font` is a URL or the font bytes in
  TrueType, OpenType, WOFF or WOFF2 format. WOFF2 needs `DecompressionStream('brotli')`; a load
  or parse failure rejects `open()`.
- `ligatures: true` in the worker entry reads the same table from the matching regular face in
  `fonts`. Without usable bytes, and always in the main entry, it uses the probe fallback.
- The probe fallback checks a fixed list of about 70 common programming ligatures. It keeps a
  sequence only when the browser draws it differently from its separate characters in the
  regular face. Fonts with other contextual alternates draw them per cell.

The terminal's text, selection, copy and accessibility output never change. A joined run is a
paint-time unit: the renderer draws the run's original characters as one string centered across
its cells. The GPU and Canvas pixel backends store it as one multi-cell atlas glyph, Canvas
fill-text draws the string directly, and the DOM puts it in its own span with browser ligatures
enabled.

Runs never cross a space, a character from U+2000 up (symbols, box drawing, icons and emoji
keep their per-cell drawing), a wide or fallback-font glyph, a grapheme cluster, invisible text or a
change of foreground, weight, slant, faint, underline, overline, strikethrough, inverse or
selection state. A background change alone keeps the run joined, except in the DOM, where one
span has one background. `fi`, `fl` and `st` stay in separate cells. A run that contains the
visible cursor draws per cell, whatever the cursor's blink phase, so typing inside `=>` shows
both characters. Ligature ranges come from the regular face; bold and italic runs reuse them.
Changing the font family after `open()` keeps the table read at open.

## scrollback retention

`appearance.scrollbackLimit` sets a page-granular budget for physical history rows, excluding the
active screen. Soft-wrapped rows each count as one physical row. Native Ghostty removes complete
historical pages when the budget is exceeded. The retained count can fall below the configured
value after a page is removed. The effective budget permits at least one standard page of rows,
so small values, including zero, can retain more rows than configured. Pages that overlap the
active screen stay whole. Page capacity depends on terminal width, styles, and graphemes.

`appearance.scrollbackByteLimit` sets a logical page-allocation budget that includes the active
area. A positive budget is raised to Ghostty's minimum: enough standard pages for the active
area plus one extra page. Both budgets apply independently, and the first reached triggers
pruning. Creation preserves Ghostty's native byte budget when this option is omitted. Zero
erases retained history and disables further scrollback. The alternate screen always contains
only its active rows.

```ts
const terminal = await Terminal.create({
  appearance: { scrollbackLimit: 10000, scrollbackByteLimit: 64 * 1024 * 1024 },
})
const retainedRows = await terminal.lineCount()
const firstPage = await terminal.readLines(0, retainedRows)
await terminal.setAppearance({ scrollbackByteLimit: 0 })
```

`lineCount()` reports the actual retained history plus active rows. `readLines(start, end)` reads
that same native range oldest-first and caps each call at `TERMINAL_READ_LINES_MAX_ROWS`.
Callers that search history page through these actual rows. Selection, scrolling, rendered text,
and accessibility use the same retained native data. Eviction clips native selection pins to the
remaining rows. `visibleLines()` and accessibility describe
the last submitted viewport while a new frame is pending. `setAppearance()` preserves omitted
budgets, including a zero byte budget.

The browser-independent `GhosttyTerminal` exposes `scrollbackLength` for actual history rows and
`scrollbackLimit` and `scrollbackByteLimit` for the configured budgets. Its
`setScrollbackLimit(undefined)` and `setScrollbackByteLimit(undefined)` remove the corresponding
budget. `TerminalSession` exposes the same setters and publishes native selection changes after
output, grid reflow, and budget pruning. Output observation uses native coordinates and a tracked
history-boundary reference to detect eviction. Text comparisons cover only the previously active
selected rows, so their work is bounded by the active grid. Appearance updates validate native
budget and grid bounds before applying changes. State events deliver the latest committed snapshot
to each synchronous observer. An observer's nested mutation becomes visible to later observers.
Unlimited lines still obey the byte budget; unlimited bytes still obey the line budget. The
wasm32 unlimited sentinel `0xffffffff` is accepted for either budget and canonicalized to
`undefined` in core readback and main/worker appearance.

The shipped native artifact uses the pinned official Ghostty source without patches. Its
[page limit enforcement](https://github.com/ghostty-org/ghostty/blob/7b11f3dca034d8d24369ad3856afe57946d7902a/src/terminal/PageList.zig#L6991-L7041)
and [undershoot test](https://github.com/ghostty-org/ghostty/blob/7b11f3dca034d8d24369ad3856afe57946d7902a/src/terminal/PageList.zig#L11258-L11303)
define this retention behavior. A line budget describes that native policy; `lineCount()` supplies
the available row count.

## DOM frame sizing

The DOM renderer owns the frame's inline width and height, calculated from the terminal grid
and fitted cell dimensions. Host layout and canvas padding determine the overlay's live position.
The frame uses `contain: layout paint` and clips painting to its bounds. Host styles that override
the frame's dimensions also change that clipping boundary; update the terminal grid or fitted font
when changing its viewport. An explicit `height: auto` override derives height from the rendered
rows. Layout and paint containment preserve this row-derived height.

## canvas and link cursors

The renderer owns `terminal.canvas` and its drawing context. Drawing into the canvas or
changing its 2D context state is unsupported. Pixel mode assumes the context has no active
clip. Use a separate canvas or DOM element for custom drawing and overlays.

The canvas exposed as `terminal.canvas` uses `cursor: pointer !important` while a link is hovered,
overriding author cursor rules, including important ones. On leave, the terminal restores the
pre-hover inline cursor value and priority unless the host's current cursor declaration differs
from `pointer !important`.

## synchronized output

DEC private mode 2026 holds the pre-hold viewport while the application writes its next frame.
Resetting the mode displays the completed frame at once. A one-second deadline clears a stuck
hold, even if the application repeatedly sets the mode. Resize and full reset also release it.
The main and worker entries honor holds on every supported renderer.

`readLines()` continues to read live terminal state during a hold. `visibleLines()`, accessibility,
`onFrame` and `onText` describe submitted frames and never expose the unfinished held output.
The renderer can repaint the captured pre-hold frame during the hold. Output timing acknowledges
held output only after release, including when release comes from the timeout.

Render states share one captured viewport per terminal. A state created during a hold reads
the safe pre-hold snapshot if another state already captured it. Without an existing snapshot,
it exposes an empty viewport and hidden cursor until release. Renderers defer its first
submission until it has a snapshot.

## first frames and damage

`runtime.createRenderState(terminal)` creates an independent damage subscription to one shared
native snapshot. Updating any subscription refreshes the viewport and cursor for all of them.
Each subscription accumulates changed rows until its own `acknowledge()`. An acknowledgement
only clears damage through that subscription's last update or row read, so a later capture by
another subscription stays pending. Dispose each subscription when its consumer stops. The last
subscription releases the native snapshot. Submitted-frame history remains separate for each
consumer. Use `snapshotRenderState()` when you need an immutable copy of a captured viewport.

`renderFrameToHtml(snapshot, { font, columns, rows, theme })` produces the DOM backend's
cell runs as HTML under Node or in a browser. `snapshotRenderState(renderState)` reads an
immutable styled snapshot from the core. Cell geometry can be supplied through the inherited
`--ghostty-cell-width`, `--ghostty-cell-height`, `--ghostty-font-size`, and
`--ghostty-letter-spacing` CSS properties.

`terminal.onFrame(({ rows }) => …)` reports the viewport rows painted by each frame across
all backends. GPU backends also accept damage-bearing updates whose rebuilt records match the
current image. These updates keep frame callbacks and displayed text current without a GPU
submission. Submission counters count only actual GPU submissions.

It returns a subscription with `dispose()`, like `onResize`; no damage array is allocated when
there are no listeners.

Resizing inside a frame callback repaints after that frame's callbacks finish, in the same turn.

`terminal.submittedFrame` describes the last accepted displayed frame. Its frame, native
revision, snapshot version and layout identity accompany the grid, fitted font, padding,
theme, cursor, selection coordinates and scrollbar. The value appears after the first
submission and holds together while new output or layout is pending. Reading this metadata
keeps text publication idle.

`terminal.onText(({ frame, rows, rowPatches }) => …)` publishes owned text after every accepted
frame while a listener is registered. It returns a subscription with `dispose()`, like
`onFrame` and `onResize`. Registration starts with the next accepted frame. `rows` contains
the whole viewport as `{ y, text }` objects. `rowPatches` contains changed row text, with every
row included after a layout change. The data is structured-cloneable and remains valid after
later frames and terminal disposal. The last listener's disposal stops text publication.

`terminal.visibleLines()` pulls the displayed viewport's text once. WebGL and WebGPU retain
native displayed state and materialize owned text on demand. Canvas and DOM keep eager owned
rows internally. All renderers expose the same text API. Internal native frame identities stay
inside the library.

WebGL and WebGPU update retained text from native logical row damage. Grid or fitted-font
changes and native full damage refresh the complete viewport. Capture stages the next retained
frame. The renderer accepts it after submission, damage acknowledgement and frame commit finish.
An identical-output update reuses the existing image and needs no new submission.
Any failure discards that pending capture. The preceding accepted metadata, lazy text and styled
snapshot stay readable until the next acceptance. Previously returned owned rows remain valid.

Native retention owns at most three cell-array slots after a completed capture, plus frame and
row metadata, separately allocated grapheme data, and reader scratch storage. A grid-size
replacement can briefly own four frames because allocation precedes freeing the mismatched
spare. The three retained slots can have different historical grid sizes.

Public renderer `onTextFrame` snapshots contain owned rows, with no native identities or
reader functions, and remain readable after later captures and disposal. The terminal's private
GPU publication channel keeps the no-demand path lazy.

Both terminal entries pause painting when the document is hidden or the terminal root has no
positive visible area in the viewport. The main and worker entries both default
`renderWhenOffscreen` to `false`. Set it to `true` to keep painting panes
with no viewport intersection, including collapsed panes. Document visibility still applies.
Parsing, authoritative reads, layout, font and theme changes continue while painting is paused.
`onFrame` and `onText` publish no frames for that hidden interval. `submittedFrame`,
`visibleLines()` and the accessibility mirror retain the last submitted viewport until a new
paint is accepted. On return, the renderer paints current state, including changes accumulated
while hidden.

Visibility follows asynchronous browser observer notifications. IntersectionObserver reports
viewport and ancestor clipping; it does not detect opacity or another element covering a pane.
A terminal that only touches the viewport boundary, or has zero width or height, has no visible
area and pauses by default.

Accessibility defaults to off. Pass `accessibility: {}` or configure its label and live-region
limits to enable the mirror. `setAccessibilityEnabled(true)` enables it after opening. The
mirror pulls the latest displayed viewport after a coalesced 100 ms foreground delay;
public `onText` subscribers still receive every accepted text frame. Enabling accessibility,
focusing the input, and history navigation refresh the mirror immediately. Its first frame
establishes the comparison boundary for bounded recent-output announcements. A refresh interval
containing a resize or font reflow updates readable text silently, including output received
in that interval; the next output-only interval resumes announcements. Hidden documents suspend
refreshes until visible again. Disabling accessibility or disposing the terminal cancels
scheduled mirror work.

Styled cells remain an on-demand read through `frameSnapshot()` and `captureViewport()`.
Canvas resizing and context replacement can invalidate the displayed pixels independently of
the retained submitted state.

## GPU frame ownership

WebGL and WebGPU use the Zig/WASM frame builder. It walks native terminal state and writes
persistent cell and glyph records; JavaScript rasterizes missing browser-font glyphs and uploads
only changed byte ranges. GPU sources provide `createFrameBuilder`.

Atlas recovery is bounded to three registration sweeps. If a frame still cannot be built, the
renderer reports a `frame_builder` error, retains the last submitted frame, and keeps damage and
refresh requests pending. The next write, resize, font change, explicit refresh or cursor activity
requests a full native rebuild. Coordinated submission or capture failures request one recovery frame; a repeated failure
waits for another render action. Canvas resizing and
context replacement still invalidate prior pixels.

Canvas 2D, DOM, accessibility, selection/copy and frame callbacks retain their shared row readers.
Styled snapshots and text-only rows describe those consumers; GPU rendering reads native records.

## Canvas paint modes

`Terminal.create({ rendererMode })` and `WebGpuTerminalRendererOptions.rendererMode`
select `auto`, `canvas2d-fill-text`, or `canvas2d-pixels`. The worker entry accepts `auto`
and reports a capability error for explicit Canvas modes. The two Canvas modes share native cell ownership, row damage, cursor
painting and scroll history. Text shaping stays inside each native owner, including the
terminal's mode-2027 grapheme spans.

The explicit pixel mode is experimental with correctness coverage. Headed visual calibration
and performance qualification are pending. It lazily loads
`canvas-compose.wasm` into independent ordinary WASM memory and falls back to
`canvas-compose-scalar.wasm` when the browser rejects SIMD. Set `compositorAsset` on the
main-thread terminal or renderer options to use an explicit compositor URL. Browser rasterization runs on
stamp-cache misses: the existing glyph model supplies A8 coverage or intrinsic-color RGBA,
and paths supply A8 coverage. The viewport-bounded cache retains offsets, and one straight
RGBA8 framebuffer aliases the `ImageData` submitted for coalesced dirty rows. The default
fillText mode performs no compositor download, compilation or framebuffer allocation.

Composition quantizes after each operation. Effective alpha is nearest-integer
`sourceAlpha * opacity / 65535`; A8 additionally includes `coverage / 255` in that same
rounding operation. For effective alpha `a`, destination alpha `d`, and source/destination
straight color channels `s` and `c`, the denominator is `a * 255 + d * (255 - a)`.
Output color is nearest-integer `(s * a * 255 + c * d * (255 - a)) / denominator`, and
output alpha is nearest-integer `denominator / 255`. Half ties round upward, zero effective
alpha preserves all destination bytes, and clear writes RGBA zero. Scalar and SIMD tests
compare this contract exactly; retained-f32 comparisons report quantization error separately.

Rebuild the checked-in compositors with `bun run build:canvas-compose`, using Bun and Zig
0.16.0 or newer. The command builds both SIMD and scalar artifacts. `--scalar --output <file>` builds an independent scalar test arm. This
Canvas-local asset changes neither the pinned native Ghostty build nor its ABI.

## live geometry and text width

`terminal.geometry()` samples the current native columns, rows, cursor, pending wrap,
scrollbar, autowrap and grapheme-clustering mode. Cell dimensions are CSS pixels. Its revision
identifies the execution owner's state. `visibleLines()` continues to describe submitted text.

`terminal.measure(text)` returns the sum of native printing-unit cell widths.
`terminal.measureTexts(texts)` measures a readonly batch against one live geometry sample and
returns UTF16 source ranges and cell widths for each printing unit. Mode 2027 selects native
grapheme clusters; with it disabled, units are codepoints. These methods accept plain printable
text, including combining marks and variation selectors. Empty text measures zero. VT controls,
newlines and tabs are rejected; this API measures widths and does not predict wrapping.

`terminal.writeAndReadGeometry(data)` writes through the native VT parser and captures the
resulting cursor and geometry before publishing output observers. A colored prompt can establish
its edit origin with this single operation. Observers may subsequently write more output; the
returned sample retains the prompt write's revision and cursor.

## extensions and original input

Extensions are host-side values with synchronous `setup(scope)`. `Terminal.create({ extensions })`
installs readonly recursive presets in encounter order before opening. `terminal.use(extension)`
returns a synchronous typed `{ api, dispose }` handle from the main entry and a Promise of that handle
from the worker entry. Worker setup and validation failures reject that Promise. Setup and handle
disposal remain synchronous host transactions.

```ts
import { Terminal, type Extension } from 'ghostty-webgpu'

const inputGate: Extension<{ setBlocked(value: boolean): void }> = {
  name: 'input-gate',
  setup: () => {
    let blocked = false
    return {
      api: {
        setBlocked: (value) => {
          blocked = value
        },
      },
      input: () => (blocked ? 'claim' : 'pass'),
    }
  },
}

const terminal = await Terminal.create()
const gate = terminal.use(inputGate)
gate.api.setBlocked(true)
```

Each attachment receives its own scope, lazy abort signal and owned cleanup stack. One value can
attach to several terminals; duplicate identity on the same terminal is rejected. Detaching permits
a fresh attachment. Setup and preset failures roll back acquired resources. Terminal disposal removes
attachments and owned cleanup in reverse order. Owned cleanup runs once; handle and terminal disposal
are idempotent.

`input` receives the original DOM key event, programmatic key input, paste/text data or committed
composition text before native normalization and encoding. The first `claim` stops dispatch and PTY
emission. Passing input uses the existing native encoder, including keyboard and bracketed-paste modes.
DOM claims and default prevention are synchronous. Native protocol replies remain observable through
`data` and bypass input claims. Contributions under `events` receive the public host event payloads;
only interested handlers are indexed and frame payloads are constructed when observed.

Public custom OSC observation requires numeric reservation metadata and a host subscription adapter.
This checkpoint rejects nonempty OSC contributions and rolls back their setup. Native Session OSC
observation is available separately. Named-command and contributed-link registries remain internal;
explicit `registerLinkProvider` continues to work. Native width and geometry methods keep their
synchronous-main and Promise-worker return conventions. Setup closures stay on the host.

## hotkeys

Terminal bindings and hosted focus setup use the [hotkeys input connection](hotkeys.md).
`attachTerminalHotkeys` owns one synchronous main-host input lease and constructs no general
manager. Its claim stops forwarding; its pass reaches explicitly installed general input
contributions, then native once. The public extension APIs above retain their separate ownership.
