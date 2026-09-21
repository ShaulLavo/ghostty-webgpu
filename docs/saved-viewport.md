# Saved terminal viewport

`Terminal.captureViewport()` returns an opaque string for the last submitted native frame, or
`undefined` when no frame is available, terminal state changed since it painted, password input
is active, or the bounded format cannot represent the viewport. The UTF-16 storage ceiling is
`TERMINAL_VIEWPORT_MAX_BYTES` (256 KiB). Capture is explicit; the package stores nothing.

`terminal.on('frame', callback)` fires after a renderer submits a frame. Capture in this callback
or during a later lifecycle flush. The event does not certify server replay completion.

`paintTerminalViewport(host, snapshot, { font, theme })` validates the saved viewport and paints
it synchronously with the package's native Canvas cell painter. It returns `{ lines, scrollbar, dispose }`,
or `undefined` for invalid data or mismatched host dimensions, device pixel ratio, or supplied
appearance expectations. `font` and `theme` are optional partial expectations. Hosts must check
other application identity (terminal, workspace, environment) before calling it.

The saved view preserves resolved cell colors, attributes, wide cells and the cursor's painted
visibility/style. It contains no parser state, scrollback, executable terminal escapes or input
handlers. Painting does not create a terminal, initialize WASM, or access the network. The
returned lines expose the same saved text for an accessible presentation owned by the host.

Keep saved paint visible while a separate empty terminal receives the real server replay. Dispose
the saved view only after the replay boundary and a subsequent live frame. Never write the saved
viewport into the live terminal buffer. Keep failed connections visibly pending and read-only.

`scrollbar` preserves the saved viewport offset, visible length and total rows. After server replay,
restore a scrolled viewport relative to the new bottom before admitting the live frame; a viewport
that followed the bottom should keep following it.
