const row_index = @import("row-index.zig");
const host = struct {
    extern "env" fn write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void;
    extern "env" fn render_hold(terminal: u32, userdata: u32, held: u32) void;
    extern "env" fn bell(terminal: u32, userdata: u32) void;
    extern "env" fn color_scheme(terminal: u32, userdata: u32, out: u32) u32;
    extern "env" fn clipboard_write(terminal: u32, userdata: u32, write: u32) void;
    extern "env" fn device_attributes(terminal: u32, userdata: u32, out: u32) u32;
    extern "env" fn size(terminal: u32, userdata: u32, out: u32) u32;
    extern "env" fn xtversion(out: u32, terminal: u32, userdata: u32) void;
    extern "env" fn title_changed(terminal: u32, userdata: u32) void;
    extern "env" fn decode_png(userdata: u32, allocator: u32, data: u32, len: u32, out: u32) u32;
};

export fn bridge_write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void {
    host.write_pty(terminal, userdata, data, len);
}

export fn bridge_render_hold(terminal: u32, userdata: u32, held: u32) void {
    host.render_hold(terminal, userdata, held);
}

export fn bridge_bell(terminal: u32, userdata: u32) void {
    host.bell(terminal, userdata);
}

export fn bridge_color_scheme(terminal: u32, userdata: u32, out: u32) u32 {
    return host.color_scheme(terminal, userdata, out);
}

export fn bridge_clipboard_write(terminal: u32, userdata: u32, write: u32) void {
    host.clipboard_write(terminal, userdata, write);
}

export fn bridge_device_attributes(terminal: u32, userdata: u32, out: u32) u32 {
    return host.device_attributes(terminal, userdata, out);
}

export fn bridge_size(terminal: u32, userdata: u32, out: u32) u32 {
    return host.size(terminal, userdata, out);
}

export fn bridge_xtversion(out: u32, terminal: u32, userdata: u32) void {
    host.xtversion(out, terminal, userdata);
}

export fn bridge_title_changed(terminal: u32, userdata: u32) void {
    host.title_changed(terminal, userdata);
}

export fn bridge_decode_png(userdata: u32, allocator: u32, data: u32, len: u32, out: u32) u32 {
    return host.decode_png(userdata, allocator, data, len, out);
}

const unknown_osc = @import("unknown-osc.zig");
comptime {
    @export(&unknown_osc.callback, .{ .name = "bridge_unknown_sequence" });
}

pub const snapshot = @import("snapshot.zig");
comptime {
    @export(&snapshot.readRows, .{ .name = "bridge_read_rows" });
}

const retained = @import("retained-frame.zig");
comptime {
    @export(&retained.create, .{ .name = "bridge_create_retained_frame" });
    @export(&retained.destroy, .{ .name = "bridge_destroy_retained_frame" });
    @export(&retained.capture, .{ .name = "bridge_capture_retained_frame" });
    @export(&retained.readText, .{ .name = "bridge_read_retained_text" });
    @export(&retained.readRevisions, .{ .name = "bridge_read_retained_revisions" });
    @export(&retained.readRows, .{ .name = "bridge_read_retained_rows" });
}

const std = @import("std");

const c = @cImport({
    @cInclude("ghostty/vt/render.h");
    @cInclude("ghostty/vt/screen.h");
    @cInclude("ghostty/vt/style.h");
});

export fn bridge_acknowledge(state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator, count: *u32) c.GhosttyResult {
    var it = iterator;
    var result = c.ghostty_render_state_get(state, c.GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, @ptrCast(&it));
    if (result != c.GHOSTTY_SUCCESS) return result;
    var dirty_rows: u32 = 0;
    while (c.ghostty_render_state_row_iterator_next(it)) {
        var dirty = false;
        result = c.ghostty_render_state_row_get(it, c.GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &dirty);
        if (result != c.GHOSTTY_SUCCESS) return result;
        dirty_rows += @intFromBool(dirty);
    }
    result = c.ghostty_render_state_clean(state);
    if (result == c.GHOSTTY_SUCCESS) count.* = dirty_rows;
    return result;
}

const TextRow = extern struct { y: u32, start: u32, len: u32 };
// Unicode scalar values leave bit 31 available for the wide-tail continuation flag.
const TextCell = extern struct { codepoint: u32, grapheme_start: u32, grapheme_len: u32 };
const TextSnapshot = extern struct {
    rows: [*]TextRow,
    rows_cap: u32,
    rows_len: u32,
    cells: [*]TextCell,
    cells_cap: u32,
    cells_len: u32,
    graphemes: [*]u32,
    graphemes_cap: u32,
    graphemes_len: u32,
    codepoint_mask: u32,
};

fn readTextCell(raw: c.GhosttyCell, cells: c.GhosttyRenderStateRowCells, x: u32, out: *TextCell, text: *TextSnapshot) c.GhosttyResult {
    out.* = .{ .codepoint = 0, .grapheme_start = 0, .grapheme_len = 0 };
    var wide: c.GhosttyCellWide = 0;
    var result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CODEPOINT, &out.codepoint);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_WIDE, &wide);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (wide == c.GHOSTTY_CELL_WIDE_SPACER_TAIL) out.codepoint |= 0x80000000;
    text.codepoint_mask |= out.codepoint;
    var tag: c.GhosttyCellContentTag = 0;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CONTENT_TAG, &tag);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (tag != c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) return c.GHOSTTY_SUCCESS;
    result = c.ghostty_render_state_row_cells_select(cells, @intCast(x));
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &out.grapheme_len);
    if (result != c.GHOSTTY_SUCCESS) return result;
    out.grapheme_start = text.graphemes_len;
    text.graphemes_len += out.grapheme_len;
    if (text.graphemes_len > text.graphemes_cap) return c.GHOSTTY_SUCCESS;
    return c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, text.graphemes + out.grapheme_start);
}

fn readTextRow(iterator: c.GhosttyRenderStateRowIterator, cells: *c.GhosttyRenderStateRowCells, y: u32, text: *TextSnapshot) c.GhosttyResult {
    var raws: c.GhosttyCellsView = undefined;
    var result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW, &raws);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (text.rows_len >= text.rows_cap or text.cells_len + raws.len > text.cells_cap) return c.GHOSTTY_OUT_OF_SPACE;
    text.rows[text.rows_len] = .{ .y = y, .start = text.cells_len, .len = raws.len };
    text.rows_len += 1;
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, @ptrCast(cells));
    if (result != c.GHOSTTY_SUCCESS) return result;
    for (0..raws.len) |x| {
        result = readTextCell(raws.ptr[x], cells.*, @intCast(x), &text.cells[text.cells_len], text);
        if (result != c.GHOSTTY_SUCCESS) return result;
        text.cells_len += 1;
    }
    return c.GHOSTTY_SUCCESS;
}

export fn bridge_read_text_rows(state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator, cells: c.GhosttyRenderStateRowCells, mask: ?[*]const u8, mask_len: u32, dirty_only: bool, text: *TextSnapshot) c.GhosttyResult {
    text.rows_len = 0;
    text.cells_len = 0;
    text.graphemes_len = 0;
    text.codepoint_mask = 0;
    var it = iterator;
    var row_cells = cells;
    var result = c.ghostty_render_state_get(state, c.GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, @ptrCast(&it));
    if (result != c.GHOSTTY_SUCCESS) return result;
    var y: u32 = 0;
    while (c.ghostty_render_state_row_iterator_next(it)) : (y += 1) {
        if (mask) |m| {
            if (y >= mask_len or m[y] == 0) continue;
        }
        if (dirty_only) {
            var dirty = false;
            result = c.ghostty_render_state_row_get(it, c.GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &dirty);
            if (result != c.GHOSTTY_SUCCESS) return result;
            if (!dirty) continue;
        }
        result = readTextRow(it, &row_cells, y, text);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    if (text.graphemes_len > text.graphemes_cap) return c.GHOSTTY_OUT_OF_SPACE;
    return c.GHOSTTY_SUCCESS;
}

const glyph_index = @import("glyph-index.zig");
const FrameRange = extern struct {
    cell_offset: u32,
    cell_length: u32,
    glyph_offset: u32,
    glyph_length: u32,
};
// Callers retain these buffers across builds and reallocate them on grid resize.
const Frame = extern struct {
    columns: u32,
    rows: u32,
    cell_data: [*][16]f32,
    glyph_data: [*][24]f32,
    glyph_index: *glyph_index.Index,
    ranges: [*]FrameRange,
    ranges_cap: u32,
    ranges_len: u32,
    missing: [*]u32,
    missing_cap: u32,
    missing_len: u32,
    status: u32,
    cell_width: f32,
    cell_height: f32,
    minimum_contrast: f32,
    foreground: u32,
    background: u32,
    cursor: u32,
    cursor_text: u32,
    cursor_x: u32,
    cursor_y: u32,
    cursor_visible: u32,
    cursor_style: u32,
    selection_foreground: u32,
    selection_background: u32,
    index_rebuilds: u32,
    glyph_minimum_contrast: f64,
    row_cache: ?*FrameCache,
    rows_built: u32,
    rows_reused: u32,
    row_offset: u32,
    stable_rows: u32,
    stable_allowed: u32,
    row_changes: u32,
    blinking_rows: u32,
    // Nonzero selects a JS ligature finder; scratch holds spans, segment text and ranges per column.
    ligatures: u32,
    ligature_scratch: ?[*]u32,
    ligature_cursor_x: u32,
    ligature_cursor_y: u32,
    ligature_cursor_visible: u32,
};

extern "env" fn ligature_ranges(finder: u32, codepoints: [*]const u32, len: u32, out: [*]u32) u32;
const ligature_interior: u32 = 0xffffffff;

extern "env" fn ghostty_wasm_alloc(len: usize) ?[*]u8;
extern "env" fn ghostty_wasm_free(ptr: ?[*]u8, len: usize) void;

const CachedCell = struct {
    raw: c.GhosttyCell,
    foreground: u32,
    background: u32,
    style: u32,
    styled: bool,
    tag: c.GhosttyCellContentTag,
    key: ?*glyph_index.Entry,
    registration: u64 = 0,
};
const RenderedCell = struct {
    raw: c.GhosttyCell,
    key: ?*glyph_index.Entry,
    reusable: bool,
    registration: u64,
};
const CachedRow = struct {
    id: c.GhosttyRenderStateRowId,
    cells: [*]CachedCell,
    selected: bool = false,
    blinking: bool = false,
    // A cell still waits for its glyph, so the row must be revisited until it registers.
    unresolved: bool = false,
    selection_start: u32 = 0,
    selection_end: u32 = 0,
    cursor: bool = false,
    appearance: [11]u32 = [_]u32{0} ** 11,
};
const FrameCache = struct {
    columns: u32,
    rows: u32,
    previous: [*]CachedRow,
    next: [*]CachedRow,
    incoming: [*]c.GhosttyRenderStateRowId,
    sources: [*]u32,
    used: [*]bool,
    row_index: [*]row_index.Entry,
    inputs: [*]CachedCell,
    rendered: [*]RenderedCell,
    cells: [*][16]f32,
    glyphs: [*][24]f32,
    // Ranges written by a missing-glyph pass; the retry pass uploads their union with its own.
    pending: [*]FrameRange,
    pending_len: u32 = 0,
    range_slots: [*]u32,
    moved: bool = false,
    streaming: bool = false,
    previous_offset: u32 = 0,
    row_starts: ?[*]u32 = null,
    appearance: [11]u32 = [_]u32{0} ** 11,
    default_style: c.GhosttyStyle,
    // Per-row memos; style ids are only comparable within one row's page.
    run: StyledRun = .{},
    last_glyph: GlyphMemo = .{},
    last_raw: c.GhosttyCell = 0,
    last_cell: CellFields = undefined,
    last_cell_valid: bool = false,
};

const CellFields = struct {
    codepoint: u32 = 0,
    wide: c.GhosttyCellWide = 0,
    tag: c.GhosttyCellContentTag = 0,
    styled: bool = false,
    style: c.GhosttyStyle,
    fg: u32 = 0xffffffff,
    bg: u32 = 0xffffffff,
};

// The style, foreground and background of the row's last styled codepoint cell, by style id.
const StyledRun = struct {
    valid: bool = false,
    id: u16 = 0,
    style: c.GhosttyStyle = undefined,
    fg: u32 = 0,
    bg: u32 = 0,
};

// The row's last resolved glyph and the exact inputs it was resolved from.
const GlyphMemo = struct {
    key: ?*glyph_index.Entry = null,
    codepoint: u32 = 0,
    span: u32 = 0,
    constraint_width: u32 = 0,
    style: u32 = 0,
    foreground: u32 = 0,
    background: u32 = 0,
};

fn frameAllocate(comptime T: type, count: usize) ?[*]T {
    const bytes = ghostty_wasm_alloc(count * @sizeOf(T)) orelse return null;
    return @ptrCast(@alignCast(bytes));
}

fn frameFree(comptime T: type, pointer: [*]T, count: usize) void {
    ghostty_wasm_free(@ptrCast(pointer), count * @sizeOf(T));
}

fn createFrameCacheFallible(columns: u32, rows: u32) error{OutOfMemory}!*FrameCache {
    const memory = frameAllocate(FrameCache, 1) orelse return error.OutOfMemory;
    errdefer frameFree(FrameCache, memory, 1);
    const previous = frameAllocate(CachedRow, rows) orelse return error.OutOfMemory;
    errdefer frameFree(CachedRow, previous, rows);
    const next = frameAllocate(CachedRow, rows) orelse return error.OutOfMemory;
    errdefer frameFree(CachedRow, next, rows);
    const incoming = frameAllocate(c.GhosttyRenderStateRowId, rows) orelse return error.OutOfMemory;
    errdefer frameFree(c.GhosttyRenderStateRowId, incoming, rows);
    const sources = frameAllocate(u32, rows) orelse return error.OutOfMemory;
    errdefer frameFree(u32, sources, rows);
    const used = frameAllocate(bool, rows) orelse return error.OutOfMemory;
    errdefer frameFree(bool, used, rows);
    const index = frameAllocate(row_index.Entry, row_index.capacity(rows)) orelse return error.OutOfMemory;
    errdefer frameFree(row_index.Entry, index, row_index.capacity(rows));
    const inputs = frameAllocate(CachedCell, columns * rows) orelse return error.OutOfMemory;
    errdefer frameFree(CachedCell, inputs, columns * rows);
    const rendered = frameAllocate(RenderedCell, columns * rows) orelse return error.OutOfMemory;
    errdefer frameFree(RenderedCell, rendered, columns * rows);
    const cells = frameAllocate([16]f32, columns * rows) orelse return error.OutOfMemory;
    errdefer frameFree([16]f32, cells, columns * rows);
    const glyphs = frameAllocate([24]f32, columns * rows) orelse return error.OutOfMemory;
    errdefer frameFree([24]f32, glyphs, columns * rows);
    const pending = frameAllocate(FrameRange, rows) orelse return error.OutOfMemory;
    errdefer frameFree(FrameRange, pending, rows);
    const range_slots = frameAllocate(u32, rows) orelse return error.OutOfMemory;
    for (0..rows) |y| previous[y] = .{ .id = std.mem.zeroes(c.GhosttyRenderStateRowId), .cells = inputs + y * columns };
    var default_style: c.GhosttyStyle = undefined;
    c.ghostty_style_default(&default_style);
    memory[0] = .{ .columns = columns, .rows = rows, .previous = previous, .next = next, .incoming = incoming, .sources = sources, .used = used, .row_index = index, .inputs = inputs, .rendered = rendered, .cells = cells, .glyphs = glyphs, .pending = pending, .range_slots = range_slots, .default_style = default_style };
    return &memory[0];
}

fn createFrameCache(columns: u32, rows: u32) ?*FrameCache {
    return createFrameCacheFallible(columns, rows) catch null;
}

export fn bridge_destroy_frame_cache(cache: *FrameCache) void {
    if (cache.row_starts) |starts| frameFree(u32, starts, cache.rows);
    frameFree(CachedRow, cache.previous, cache.rows);
    frameFree(CachedRow, cache.next, cache.rows);
    frameFree(c.GhosttyRenderStateRowId, cache.incoming, cache.rows);
    frameFree(u32, cache.sources, cache.rows);
    frameFree(bool, cache.used, cache.rows);
    frameFree(row_index.Entry, cache.row_index, row_index.capacity(cache.rows));
    frameFree(CachedCell, cache.inputs, cache.columns * cache.rows);
    frameFree(RenderedCell, cache.rendered, cache.columns * cache.rows);
    frameFree([16]f32, cache.cells, cache.columns * cache.rows);
    frameFree([24]f32, cache.glyphs, cache.columns * cache.rows);
    frameFree(FrameRange, cache.pending, cache.rows);
    frameFree(u32, cache.range_slots, cache.rows);
    ghostty_wasm_free(@ptrCast(cache), @sizeOf(FrameCache));
}

fn sameRowId(a: c.GhosttyRenderStateRowId, b: c.GhosttyRenderStateRowId) bool {
    return a.bits[0] == b.bits[0] and a.bits[1] == b.bits[1];
}

fn planFrameRows(frame: *Frame, state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator) c.GhosttyResult {
    const cache = frame.row_cache.?;
    cache.previous_offset = frame.row_offset;
    if (frame.stable_allowed == 0) {
        frame.stable_rows = 0;
        frame.row_offset = 0;
    }
    @memset(cache.used[0..cache.rows], false);
    const index = cache.row_index[0..row_index.capacity(cache.rows)];
    row_index.reset(index, cache.rows);
    for (0..cache.rows) |source| row_index.insert(index, cache.previous[source].id.bits, @intCast(source), cache.rows);
    cache.moved = false;
    cache.streaming = true;
    const contrast: u64 = @bitCast(frame.glyph_minimum_contrast);
    const appearance = [11]u32{
        @bitCast(frame.cell_width), @bitCast(frame.cell_height), @bitCast(frame.minimum_contrast),
        frame.foreground,           frame.background,            frame.cursor,
        frame.cursor_text,          frame.selection_foreground,  frame.selection_background,
        @truncate(contrast),        @truncate(contrast >> 32),
    };
    cache.appearance = appearance;
    var it = iterator;
    var result = c.ghostty_render_state_get(state, c.GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, @ptrCast(&it));
    if (result != c.GHOSTTY_SUCCESS) return result;
    var y: u32 = 0;
    while (c.ghostty_render_state_row_iterator_next(it)) : (y += 1) {
        if (y >= cache.rows) return c.GHOSTTY_OUT_OF_SPACE;
        result = c.ghostty_render_state_row_get(it, c.GHOSTTY_RENDER_STATE_ROW_DATA_ID, &cache.incoming[y]);
        if (result != c.GHOSTTY_SUCCESS) return result;
        const source = row_index.lookup(index, cache.incoming[y].bits, cache.rows);
        cache.sources[y] = source;
        if (source != cache.rows) cache.used[source] = true;
    }
    if (y != cache.rows) return c.GHOSTTY_OUT_OF_SPACE;
    var unused: u32 = 0;
    for (0..cache.rows) |destination| {
        if (cache.sources[destination] == cache.rows) {
            while (unused < cache.rows and cache.used[unused]) : (unused += 1) {}
            if (unused == cache.rows) return c.GHOSTTY_OUT_OF_SPACE;
            cache.sources[destination] = unused;
            cache.used[unused] = true;
        }
        const source = cache.sources[destination];
        cache.next[destination] = cache.previous[source];
        cache.next[destination].id = cache.incoming[destination];
        cache.moved = cache.moved or source != destination;
        // Forward writes preserve every reused source at or below its destination.
        if (sameRowId(cache.previous[source].id, cache.incoming[destination]) and source < destination) cache.streaming = false;
    }
    if (!cache.moved) return c.GHOSTTY_SUCCESS;
    if (frame.stable_allowed != 0) {
        if (cache.row_starts == null) cache.row_starts = frameAllocate(u32, cache.rows) orelse return c.GHOSTTY_OUT_OF_MEMORY;
        frame.stable_rows = 1;
        const shift = cache.sources[0];
        var rotation = true;
        for (0..cache.rows) |destination| {
            const source = cache.sources[destination];
            if (!sameRowId(cache.previous[source].id, cache.incoming[destination])) continue;
            if (source == (destination + shift) % cache.rows) continue;
            rotation = false;
            break;
        }
        if (rotation) frame.row_offset = (frame.row_offset + shift) % cache.rows;
        for (0..cache.rows) |row| cache.row_starts.?[row] = physicalRow(frame, @intCast(row)) * frame.columns;
        if (rotation) return c.GHOSTTY_SUCCESS;
        cache.streaming = false;
    }
    if (!cache.moved or cache.streaming) return c.GHOSTTY_SUCCESS;
    @memcpy(cache.cells[0 .. cache.columns * cache.rows], frame.cell_data[0 .. cache.columns * cache.rows]);
    @memcpy(cache.glyphs[0 .. cache.columns * cache.rows], frame.glyph_data[0 .. cache.columns * cache.rows]);
    return c.GHOSTTY_SUCCESS;
}

fn visualStyle(style: c.GhosttyStyle) u32 {
    return @as(u32, @intFromBool(style.bold)) | (@as(u32, @intFromBool(style.italic)) << 1) |
        (@as(u32, @intFromBool(style.faint)) << 2) | (@as(u32, @intFromBool(style.inverse)) << 3) |
        (@as(u32, @intFromBool(style.invisible)) << 4) | (@as(u32, @intFromBool(style.strikethrough)) << 5) |
        (@as(u32, @intFromBool(style.overline)) << 6) | (@as(u32, @intFromBool(style.blink)) << 7) | (@as(u32, @intCast(style.underline)) << 8);
}

fn matchingFrameRow(frame: *Frame, iterator: c.GhosttyRenderStateRowIterator, cells: *c.GhosttyRenderStateRowCells, y: u32, matches: *bool) c.GhosttyResult {
    matches.* = false;
    const cache = frame.row_cache.?;
    const source = cache.sources[y];
    const row = cache.previous[source];
    if (source == y or row.cursor or row.unresolved or cache.next[y].cursor or !sameRowId(row.id, cache.incoming[y])) return c.GHOSTTY_SUCCESS;
    if (!std.mem.eql(u32, &row.appearance, &cache.appearance)) return c.GHOSTTY_SUCCESS;
    var raw: c.GhosttyCellsView = undefined;
    var result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW, &raw);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (raw.len != frame.columns) return c.GHOSTTY_OUT_OF_SPACE;
    for (0..raw.len) |x| if (raw.ptr[x] != row.cells[x].raw) return c.GHOSTTY_SUCCESS;
    var selection: c.GhosttyRenderStateRowSelection = undefined;
    selection.size = @sizeOf(c.GhosttyRenderStateRowSelection);
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION, &selection);
    const selected = result == c.GHOSTTY_SUCCESS;
    if (!selected and result != c.GHOSTTY_NO_VALUE) return result;
    if (selected != row.selected) return c.GHOSTTY_SUCCESS;
    if (selected and (selection.start_x != row.selection_start or selection.end_x != row.selection_end)) return c.GHOSTTY_SUCCESS;
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, @ptrCast(cells));
    if (result != c.GHOSTTY_SUCCESS) return result;
    for (0..raw.len) |x| {
        const input = row.cells[x];
        if (input.key != null and input.registration != input.key.?.registration) return c.GHOSTTY_SUCCESS;
        const grapheme = input.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME and input.key != null;
        // Unstyled codepoint cells have no explicit background; raw equality proves that remains true.
        const default_colors = !input.styled and (input.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT or input.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME);
        if (default_colors and !grapheme) continue;
        result = c.ghostty_render_state_row_cells_select(cells.*, @intCast(x));
        if (result != c.GHOSTTY_SUCCESS) return result;
        if (!default_colors) {
            var background: u32 = 0xffffffff;
            result = frameColor(cells.*, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &background);
            if (result != c.GHOSTTY_SUCCESS) return result;
            if (background != input.background) return c.GHOSTTY_SUCCESS;
        }
        if (input.styled) {
            var style: c.GhosttyStyle = undefined;
            style.size = @sizeOf(c.GhosttyStyle);
            result = c.ghostty_render_state_row_cells_get(cells.*, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
            if (result != c.GHOSTTY_SUCCESS) return result;
            if (visualStyle(style) != input.style) return c.GHOSTTY_SUCCESS;
            var foreground: u32 = 0xffffffff;
            result = frameColor(cells.*, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &foreground);
            if (result != c.GHOSTTY_SUCCESS) return result;
            if (foreground != input.foreground) return c.GHOSTTY_SUCCESS;
        }
        if (!grapheme) continue;
        var length: u32 = 0;
        result = c.ghostty_render_state_row_cells_get(cells.*, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &length);
        if (result != c.GHOSTTY_SUCCESS) return result;
        const key = input.key.?.key;
        if (length != key.text_len) return c.GHOSTTY_SUCCESS;
        const text = glyph_index.scratch(frame.glyph_index, length) orelse return c.GHOSTTY_OUT_OF_MEMORY;
        result = c.ghostty_render_state_row_cells_get(cells.*, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, text.ptr);
        if (result != c.GHOSTTY_SUCCESS) return result;
        if (!std.mem.eql(u32, text, key.text[0..key.text_len])) return c.GHOSTTY_SUCCESS;
    }
    matches.* = true;
    return c.GHOSTTY_SUCCESS;
}

fn physicalRow(frame: *Frame, y: u32) u32 {
    if (frame.stable_rows == 0 or frame.row_offset == 0) return y;
    return (y + frame.row_offset) % frame.rows;
}

fn previousLogicalRow(frame: *Frame, y: u32) u32 {
    const cache = frame.row_cache.?;
    if (frame.stable_rows == 0 or frame.row_offset == cache.previous_offset) return y;
    return (y + frame.row_offset + frame.rows - cache.previous_offset) % frame.rows;
}

fn reuseFrameRow(comptime stable: bool, frame: *Frame, y: u32) c.GhosttyResult {
    const cache = frame.row_cache.?;
    const source = cache.sources[y];
    const start = if (stable) cache.row_starts.?[y] else y * frame.columns;
    const source_row = if (stable) (source + cache.previous_offset) % frame.rows else source;
    const source_start = source_row * frame.columns;
    if (stable and start == source_start) {
        // Logical movement still needs delivery when the physical records stay put.
        if (source != y) {
            if (frame.ranges_len == frame.ranges_cap) return c.GHOSTTY_OUT_OF_SPACE;
            frame.ranges[frame.ranges_len] = .{
                .cell_offset = start * 64,
                .cell_length = 0,
                .glyph_offset = start * 96,
                .glyph_length = 0,
            };
            frame.ranges_len += 1;
        }
        frame.rows_reused += 1;
        return c.GHOSTTY_SUCCESS;
    }
    const source_cells = if (cache.streaming) frame.cell_data else cache.cells;
    const source_glyphs = if (cache.streaming) frame.glyph_data else cache.glyphs;
    var cell_first = frame.columns;
    var cell_end: u32 = 0;
    var glyph_first = frame.columns;
    var glyph_end: u32 = 0;
    const top = if (stable) 0 else @as(f32, @floatFromInt(y)) * frame.cell_height;
    const reuse_row = reusableRow(stable, frame, &cache.previous[previousLogicalRow(frame, y)], y);
    for (0..frame.columns) |x| {
        const row = cache.next[y];
        const selected = row.selected and x >= row.selection_start and x <= row.selection_end;
        if (reuse_row) |previous| {
            if (reuseRenderedCell(stable, frame, previous, start + @as(u32, @intCast(x)), row.cells[x].raw, @intCast(x), y, selected)) continue;
        }
        rememberRenderedCell(cache, start + x, cache.next[y].cells[x]);
        var next_cell = source_cells[source_start + x];
        var next_glyph = source_glyphs[source_start + x];
        const cell = &next_cell;
        const glyph = &next_glyph;
        if (cell[3] != 0) cell[1] = top;
        if (glyph[16] != 0) glyph[1] = top + cache.next[y].cells[x].key.?.glyph.offset_y;
        if (!sameRecord(16, cell, &frame.cell_data[start + x])) {
            cell_first = @min(cell_first, @as(u32, @intCast(x)));
            cell_end = @intCast(x + 1);
        }
        if (!sameRecord(24, glyph, &frame.glyph_data[start + x])) {
            glyph_first = @min(glyph_first, @as(u32, @intCast(x)));
            glyph_end = @intCast(x + 1);
        }
        frame.cell_data[start + x] = next_cell;
        frame.glyph_data[start + x] = next_glyph;
    }
    if (frame.ranges_len == frame.ranges_cap) return c.GHOSTTY_OUT_OF_SPACE;
    frame.ranges[frame.ranges_len] = .{
        .cell_offset = (start + if (cell_end == 0) @as(u32, 0) else cell_first) * 64,
        .cell_length = if (cell_end == 0) 0 else (cell_end - cell_first) * 64,
        .glyph_offset = (start + if (glyph_end == 0) @as(u32, 0) else glyph_first) * 96,
        .glyph_length = if (glyph_end == 0) 0 else (glyph_end - glyph_first) * 96,
    };
    frame.ranges_len += 1;
    frame.rows_reused += 1;
    return c.GHOSTTY_SUCCESS;
}

export fn bridge_create_glyph_index() ?*glyph_index.Index {
    return glyph_index.create();
}

export fn bridge_destroy_glyph_index(index: *glyph_index.Index) void {
    glyph_index.destroy(index);
}

export fn bridge_register_glyph(key: *glyph_index.Entry, entry: *const glyph_index.Glyph) void {
    key.glyph = entry.*;
    key.registration +%= 1;
}

export fn bridge_clear_glyphs(index: *glyph_index.Index) void {
    glyph_index.clear(index);
}

export fn bridge_invalidate_glyph_page(index: *glyph_index.Index, kind: u32, layer: u32, generation: u32) void {
    glyph_index.invalidatePage(index, kind, layer, generation);
}

export fn bridge_retry_deferred_glyphs(index: *glyph_index.Index) bool {
    return glyph_index.retryDeferred(index);
}

fn rowGlyphsChanged(frame: *Frame, y: u32) bool {
    const cache = frame.row_cache.?;
    const row = cache.previous[cache.sources[y]];
    for (row.cells[0..frame.columns]) |cell| {
        const key = cell.key orelse continue;
        if (cell.registration != key.registration) return true;
    }
    return false;
}

fn frameColor(cells: c.GhosttyRenderStateRowCells, field: c.GhosttyRenderStateRowCellsData, out: *u32) c.GhosttyResult {
    var rgb: c.GhosttyColorRgb = undefined;
    const result = c.ghostty_render_state_row_cells_get(cells, field, &rgb);
    if (result == c.GHOSTTY_INVALID_VALUE) {
        out.* = 0xffffffff;
        return c.GHOSTTY_SUCCESS;
    }
    if (result != c.GHOSTTY_SUCCESS) return result;
    out.* = @as(u32, rgb.r) | (@as(u32, rgb.g) << 8) | (@as(u32, rgb.b) << 16);
    return c.GHOSTTY_SUCCESS;
}

// Inlined: as a call it showed up at 3% of plain-text frame builds.
inline fn writeColor(out: []f32, rgb: u32, alpha: f32) void {
    out[0] = @as(f32, @floatFromInt(rgb & 255)) / 255;
    out[1] = @as(f32, @floatFromInt((rgb >> 8) & 255)) / 255;
    out[2] = @as(f32, @floatFromInt((rgb >> 16) & 255)) / 255;
    out[3] = alpha;
}

fn missingGlyph(frame: *Frame, key: *glyph_index.Entry) c.GhosttyResult {
    if (key.queued_generation == frame.glyph_index.build_generation) return c.GHOSTTY_SUCCESS;
    if (frame.missing_len == frame.missing_cap) return c.GHOSTTY_OUT_OF_SPACE;
    key.queued_generation = frame.glyph_index.build_generation;
    frame.missing[frame.missing_len] = @intFromPtr(key);
    frame.missing_len += 1;
    frame.status = 2;
    return c.GHOSTTY_SUCCESS;
}

fn isSymbol(cp: u32) bool {
    return (cp >= 0xe000 and cp <= 0xf8ff) or
        (cp >= 0xf0000 and cp <= 0xffffd) or
        (cp >= 0x100000 and cp <= 0x10fffd) or
        (cp >= 0x2190 and cp <= 0x21ff) or
        (cp >= 0x2700 and cp <= 0x27bf) or
        (cp >= 0x1f600 and cp <= 0x1f64f) or
        (cp >= 0x2600 and cp <= 0x26ff) or
        (cp >= 0x2460 and cp <= 0x24ff) or
        (cp >= 0x1f100 and cp <= 0x1f1ff) or
        (cp >= 0x1f300 and cp <= 0x1f5ff) or
        (cp >= 0x1f680 and cp <= 0x1f6ff);
}

fn isGraphicsElement(cp: u32) bool {
    return (cp >= 0x2500 and cp <= 0x259f) or
        (cp >= 0x1fb00 and cp <= 0x1fbff) or
        (cp >= 0x1cc00 and cp <= 0x1cebf) or
        (cp >= 0xe0b0 and cp <= 0xe0d7);
}

fn constraintWidth(raws: []const c.GhosttyCell, x: u32, span: u32, cp: u32, out: *u32) c.GhosttyResult {
    out.* = 1;
    if (span > 1) {
        out.* = 2;
        return c.GHOSTTY_SUCCESS;
    }
    if (!isSymbol(cp) or x + 1 >= raws.len) return c.GHOSTTY_SUCCESS;
    if (x > 0) {
        var previous: u32 = 0;
        const result = c.ghostty_cell_get(raws[x - 1], c.GHOSTTY_CELL_DATA_CODEPOINT, &previous);
        if (result != c.GHOSTTY_SUCCESS) return result;
        if (isSymbol(previous) and !isGraphicsElement(previous)) return c.GHOSTTY_SUCCESS;
    }
    var next: u32 = 0;
    const result = c.ghostty_cell_get(raws[x + 1], c.GHOSTTY_CELL_DATA_CODEPOINT, &next);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (next == 0 or next == 0x20 or next == 0x2002) out.* = 2;
    return c.GHOSTTY_SUCCESS;
}

const CellContent = struct {
    codepoint: u32,
    continuation: bool,
    span: u32,
    constraint_width: u32,
    tag: c.GhosttyCellContentTag,
    joined: ?[]const u32 = null,
    // A glyph already resolved for this content and brush, from the plain-cell cache.
    resolved: ?*glyph_index.Entry = null,
    // Styled cells repeat within a row; plain repeats across frames use the plain-cell cache.
    memo: bool = false,
};

fn resolveCellKey(comptime bidi: bool, projection: ?[*]const BidiCell, frame: *Frame, cells: c.GhosttyRenderStateRowCells, x: u32, y: u32, content: CellContent, style: c.GhosttyStyle, foreground: u32, background: u32, out: *?*glyph_index.Entry) c.GhosttyResult {
    var scalar = content.codepoint;
    var text: []const u32 = content.joined orelse @as(*const [1]u32, &scalar);
    if (content.joined == null and content.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) {
        var length: u32 = 0;
        var result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &length);
        if (result != c.GHOSTTY_SUCCESS) return result;
        const scratch = glyph_index.scratch(frame.glyph_index, length) orelse return c.GHOSTTY_OUT_OF_MEMORY;
        result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, scratch.ptr);
        if (result != c.GHOSTTY_SUCCESS) return result;
        text = scratch;
    }
    if (bidi) {
        const mirror = projection.?[y * frame.columns + x].mirror;
        if (mirror != 0) {
            const scratch = glyph_index.scratch(frame.glyph_index, @intCast(text.len)) orelse return c.GHOSTTY_OUT_OF_MEMORY;
            @memmove(scratch, text);
            scratch[0] = mirror;
            text = scratch;
        }
    }
    out.* = glyph_index.resolve(frame.glyph_index, .{
        .text = text.ptr,
        .text_len = @intCast(text.len),
        .span = content.span,
        .style = @as(u32, @intFromBool(style.bold)) | (@as(u32, @intFromBool(style.italic)) << 1),
        .foreground = foreground,
        .background = background,
        .minimum_contrast = frame.glyph_minimum_contrast,
        .constraint_width = content.constraint_width,
    }) orelse return c.GHOSTTY_OUT_OF_MEMORY;
    return c.GHOSTTY_SUCCESS;
}

const BidiCell = extern struct { visual: u32, mirror: u32, selected: u32 };

fn writeInstances(comptime stable: bool, comptime bidi: bool, projection: ?[*]const BidiCell, frame: *Frame, cells: c.GhosttyRenderStateRowCells, slot: u32, x: u32, y: u32, content: CellContent, style: c.GhosttyStyle, fg: u32, bg: u32, selected: bool) c.GhosttyResult {
    const index = if (stable or bidi) slot else y * frame.columns + x;
    const cell = &frame.cell_data[index];
    const glyph = &frame.glyph_data[index];
    cell.* = @splat(0);
    glyph.* = @splat(0);
    var foreground = if (fg == 0xffffffff) frame.foreground else fg;
    var background = if (bg == 0xffffffff) frame.background else bg;
    var draw_background = bg != 0xffffffff;
    if (style.inverse) {
        const previous = foreground;
        foreground = background;
        background = previous;
        draw_background = true;
    }
    if (selected) {
        foreground = frame.selection_foreground;
        background = frame.selection_background;
        draw_background = true;
    }
    const cursor = frame.cursor_visible != 0 and frame.cursor_x == x and frame.cursor_y == y;
    if (cursor and frame.cursor_style == 0) {
        foreground = frame.cursor_text;
        background = frame.cursor;
        draw_background = true;
    }
    const painted = if (bidi) projection.?[y * frame.columns + x].visual else x;
    const left = @as(f32, @floatFromInt(painted)) * frame.cell_width;
    const top = if (stable) 0 else @as(f32, @floatFromInt(y)) * frame.cell_height;
    if (draw_background or cursor or style.underline > 0 or style.strikethrough or style.overline) {
        cell[0..4].* = .{ left, top, frame.cell_width, frame.cell_height };
    }
    writeColor(cell[4..8], foreground, 1);
    writeColor(cell[8..12], background, if (draw_background) 1 else 0);
    const flags: u32 = @as(u32, @intFromBool(cursor)) | (@as(u32, @intFromBool(style.overline)) << 1) |
        (@as(u32, @intFromBool(style.strikethrough)) << 2);
    cell[12] = @floatFromInt(flags | (@as(u32, @intFromBool(style.blink)) << 3));
    if (style.blink and !style.invisible and (style.underline > 0 or style.strikethrough or style.overline)) frame.row_cache.?.next[y].blinking = true;
    cell[13] = @floatFromInt(style.underline);
    cell[14] = if (cursor) @floatFromInt(frame.cursor_style) else 0;
    cell[15] = frame.minimum_contrast;
    if (content.continuation or content.codepoint == 0 or style.invisible) return c.GHOSTTY_SUCCESS;
    var resolved = content.resolved;
    if (resolved == null) {
        // A BiDi mirror replaces the codepoint, so mirrored rows never use the memo.
        const result = if (!bidi and content.memo)
            resolveMemoKey(frame, cells, x, y, content, style, foreground, background, &resolved)
        else
            resolveCellKey(bidi, projection, frame, cells, x, y, content, style, foreground, background, &resolved);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    const key = resolved.?;
    frame.row_cache.?.next[y].cells[x].key = key;
    frame.row_cache.?.next[y].cells[x].registration = key.registration;
    const entry = key.glyph;
    if (entry.valid == 0) {
        frame.row_cache.?.next[y].unresolved = true;
        return missingGlyph(frame, key);
    }
    if (entry.width == 0 or entry.height == 0) return c.GHOSTTY_SUCCESS;
    glyph[0..4].* = .{ left + entry.offset_x, top + entry.offset_y, entry.width, entry.height };
    writeColor(glyph[4..8], foreground, if (style.faint) 0.5 else 1);
    glyph[8..12].* = .{ entry.u0, entry.v0, entry.u1, entry.v1 };
    writeColor(glyph[12..16], background, 1);
    glyph[16] = if (style.blink) 3 else 1;
    if (style.blink) frame.row_cache.?.next[y].blinking = true;
    glyph[18] = frame.minimum_contrast;
    glyph[20] = entry.layer;
    glyph[21] = entry.generation;
    glyph[22] = entry.kind;
    return c.GHOSTTY_SUCCESS;
}

// `plain` enables the plain-cell cache; full rebuilds skip it because they follow glyph clears.
fn buildCell(comptime stable: bool, comptime bidi: bool, projection: ?[*]const BidiCell, frame: *Frame, raws: []const c.GhosttyCell, cells: c.GhosttyRenderStateRowCells, slot: u32, x: u32, y: u32, selected: bool, joined: u32, plain: bool) c.GhosttyResult {
    const raw = raws[x];
    if (plain and !bidi and joined == 0) {
        if (plainCellKey(frame, raws, x, y, selected)) |key| return buildPlainCell(stable, frame, cells, raw, slot, x, y, key);
    }
    var fields: CellFields = undefined;
    var result = readCellFields(frame, raw, cells, x, &fields);
    if (result != c.GHOSTTY_SUCCESS) return result;
    const codepoint = fields.codepoint;
    const wide = fields.wide;
    const tag = fields.tag;
    const styled = fields.styled;
    const fg = fields.fg;
    const bg = fields.bg;
    var span: u32 = 1;
    while (x + span < raws.len) : (span += 1) {
        var next_wide: c.GhosttyCellWide = 0;
        result = c.ghostty_cell_get(raws[x + span], c.GHOSTTY_CELL_DATA_WIDE, &next_wide);
        if (result != c.GHOSTTY_SUCCESS) return result;
        if (next_wide != c.GHOSTTY_CELL_WIDE_SPACER_TAIL) break;
    }
    var constraint_width: u32 = 1;
    result = constraintWidth(raws, x, span, codepoint, &constraint_width);
    if (result != c.GHOSTTY_SUCCESS) return result;
    var joined_text: ?[]const u32 = null;
    if (joined != 0 and joined != ligature_interior) {
        const text = glyph_index.scratch(frame.glyph_index, joined) orelse return c.GHOSTTY_OUT_OF_MEMORY;
        for (text, 0..) |*point, offset| {
            result = c.ghostty_cell_get(raws[x + offset], c.GHOSTTY_CELL_DATA_CODEPOINT, point);
            if (result != c.GHOSTTY_SUCCESS) return result;
        }
        joined_text = text;
        span = joined;
        constraint_width = 1;
    }
    frame.row_cache.?.next[y].cells[x] = .{
        .raw = raw,
        .foreground = fg,
        .background = bg,
        .style = visualStyle(fields.style),
        .styled = styled,
        .tag = tag,
        .key = null,
    };
    result = writeInstances(stable, bidi, projection, frame, cells, slot, x, y, .{
        .codepoint = codepoint,
        .continuation = wide == c.GHOSTTY_CELL_WIDE_SPACER_TAIL or joined == ligature_interior,
        .span = span,
        .constraint_width = constraint_width,
        .tag = tag,
        .joined = joined_text,
        .memo = styled,
    }, fields.style, fg, bg, selected);
    if (result != c.GHOSTTY_SUCCESS or !plain or bidi or joined != 0 or styled) return result;
    if (tag != c.GHOSTTY_CELL_CONTENT_CODEPOINT or wide != c.GHOSTTY_CELL_WIDE_NARROW or span != 1) return result;
    // Symbols take their constraint width from neighbors, so their glyph is not a function of the cell.
    if (codepoint == 0 or selected or cursorAt(frame, x, y) or isSymbol(codepoint)) return result;
    const key = frame.row_cache.?.next[y].cells[x].key orelse return result;
    if (key.glyph.valid != 0) glyph_index.fastStore(frame.glyph_index, raw, key, frame.foreground, frame.background, frame.glyph_minimum_contrast);
    return result;
}

// Identical raw cells in one row share every field, except a grapheme's extra codepoints.
// A memo hit skips the native cell select, which only grapheme reads depend on.
// A miss leaves the memo alone: an identical raw cell anywhere in the row has the same fields.
inline fn readCellFields(frame: *Frame, raw: c.GhosttyCell, cells: c.GhosttyRenderStateRowCells, x: u32, out: *CellFields) c.GhosttyResult {
    const cache = frame.row_cache.?;
    if (cache.last_cell_valid and cache.last_raw == raw) {
        out.* = cache.last_cell;
        return c.GHOSTTY_SUCCESS;
    }
    out.style = cache.default_style;
    out.styled = false;
    out.fg = 0xffffffff;
    out.bg = 0xffffffff;
    var result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CODEPOINT, &out.codepoint);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_WIDE, &out.wide);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CONTENT_TAG, &out.tag);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_HAS_STYLING, &out.styled);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = if (out.styled and out.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT)
        readStyledRun(frame, raw, cells, x, &out.style, &out.fg, &out.bg)
    else
        readCellColors(cells, x, out.tag, out.styled, &out.style, &out.fg, &out.bg);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (out.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) return c.GHOSTTY_SUCCESS;
    // Plain text reads no colors, so remembering it costs more than it saves.
    if (!out.styled and out.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT) return c.GHOSTTY_SUCCESS;
    cache.last_raw = raw;
    cache.last_cell = out.*;
    cache.last_cell_valid = true;
    return c.GHOSTTY_SUCCESS;
}

fn readCellColors(cells: c.GhosttyRenderStateRowCells, x: u32, tag: c.GhosttyCellContentTag, styled: bool, style: *c.GhosttyStyle, fg: *u32, bg: *u32) c.GhosttyResult {
    // Unstyled text has no explicit background; graphemes still need native text selection.
    const default_colors = !styled and (tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT or tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME);
    if (default_colors and tag != c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) return c.GHOSTTY_SUCCESS;
    var result = c.ghostty_render_state_row_cells_select(cells, @intCast(x));
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (styled) {
        result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, style);
        if (result != c.GHOSTTY_SUCCESS) return result;
        result = frameColor(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, fg);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    if (default_colors) return c.GHOSTTY_SUCCESS;
    return frameColor(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, bg);
}

// A styled codepoint cell's style and colors depend only on its style id within the row, so a run
// of cells sharing one style reads them once.
fn readStyledRun(frame: *Frame, raw: c.GhosttyCell, cells: c.GhosttyRenderStateRowCells, x: u32, style: *c.GhosttyStyle, fg: *u32, bg: *u32) c.GhosttyResult {
    const run = &frame.row_cache.?.run;
    var id: u16 = 0;
    const result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_STYLE_ID, &id);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (run.valid and run.id == id) {
        style.* = run.style;
        fg.* = run.fg;
        bg.* = run.bg;
        return c.GHOSTTY_SUCCESS;
    }
    run.valid = false;
    const read = readCellColors(cells, x, c.GHOSTTY_CELL_CONTENT_CODEPOINT, true, style, fg, bg);
    if (read != c.GHOSTTY_SUCCESS) return read;
    run.* = .{ .valid = true, .id = id, .style = style.*, .fg = fg.*, .bg = bg.* };
    return c.GHOSTTY_SUCCESS;
}

// Styled runs repeat one glyph and brush, so the row's last resolved glyph often answers.
fn resolveMemoKey(frame: *Frame, cells: c.GhosttyRenderStateRowCells, x: u32, y: u32, content: CellContent, style: c.GhosttyStyle, foreground: u32, background: u32, out: *?*glyph_index.Entry) c.GhosttyResult {
    const brush = @as(u32, @intFromBool(style.bold)) | (@as(u32, @intFromBool(style.italic)) << 1);
    out.* = memoGlyph(frame, content, brush, foreground, background);
    if (out.* != null) return c.GHOSTTY_SUCCESS;
    const result = resolveCellKey(false, null, frame, cells, x, y, content, style, foreground, background, out);
    if (result != c.GHOSTTY_SUCCESS) return result;
    rememberGlyph(frame, content, brush, foreground, background, out.*);
    return c.GHOSTTY_SUCCESS;
}

fn memoGlyph(frame: *Frame, content: CellContent, style: u32, foreground: u32, background: u32) ?*glyph_index.Entry {
    const memo = &frame.row_cache.?.last_glyph;
    if (content.joined != null or content.tag != c.GHOSTTY_CELL_CONTENT_CODEPOINT) return null;
    const key = memo.key orelse return null;
    if (memo.codepoint != content.codepoint or memo.span != content.span or memo.constraint_width != content.constraint_width) return null;
    if (memo.style != style) return null;
    // glyph_index.resolve returns a registered grayscale or empty base entry for every brush.
    if (key.variant == 0 and key.glyph.valid != 0 and key.glyph.kind == 0) return key;
    if (memo.foreground != foreground or memo.background != background) return null;
    return key;
}

fn rememberGlyph(frame: *Frame, content: CellContent, style: u32, foreground: u32, background: u32, key: ?*glyph_index.Entry) void {
    const eligible = content.joined == null and content.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT;
    frame.row_cache.?.last_glyph = .{
        .key = if (eligible) key else null,
        .codepoint = content.codepoint,
        .span = content.span,
        .constraint_width = content.constraint_width,
        .style = style,
        .foreground = foreground,
        .background = background,
    };
}

fn cursorAt(frame: *const Frame, x: u32, y: u32) bool {
    return frame.cursor_visible != 0 and frame.cursor_x == x and frame.cursor_y == y;
}

// An unstyled narrow cell seen before needs none of its fields read again: its raw value
// determines its codepoint and glyph under the frame's default brush.
fn plainCellKey(frame: *Frame, raws: []const c.GhosttyCell, x: u32, y: u32, selected: bool) ?*glyph_index.Entry {
    if (selected or frame.ligatures != 0 or cursorAt(frame, x, y)) return null;
    const key = glyph_index.fastLookup(frame.glyph_index, raws[x], frame.foreground, frame.background, frame.glyph_minimum_contrast) orelse return null;
    if (key.glyph.valid == 0) return null;
    if (x + 1 >= raws.len) return key;
    var next_wide: c.GhosttyCellWide = 0;
    if (c.ghostty_cell_get(raws[x + 1], c.GHOSTTY_CELL_DATA_WIDE, &next_wide) != c.GHOSTTY_SUCCESS) return null;
    if (next_wide == c.GHOSTTY_CELL_WIDE_SPACER_TAIL) return null;
    return key;
}

fn buildPlainCell(comptime stable: bool, frame: *Frame, cells: c.GhosttyRenderStateRowCells, raw: c.GhosttyCell, slot: u32, x: u32, y: u32, key: *glyph_index.Entry) c.GhosttyResult {
    const cache = frame.row_cache.?;
    cache.next[y].cells[x] = .{
        .raw = raw,
        .foreground = 0xffffffff,
        .background = 0xffffffff,
        .style = visualStyle(cache.default_style),
        .styled = false,
        .tag = c.GHOSTTY_CELL_CONTENT_CODEPOINT,
        .key = null,
    };
    return writeInstances(stable, false, null, frame, cells, slot, x, y, .{
        .codepoint = key.key.text[0],
        .continuation = false,
        .span = 1,
        .constraint_width = 1,
        .tag = c.GHOSTTY_CELL_CONTENT_CODEPOINT,
        .resolved = key,
    }, cache.default_style, 0xffffffff, 0xffffffff, false);
}

fn rememberRenderedCell(cache: *FrameCache, slot: usize, input: CachedCell) void {
    const symbol = if (input.key) |key| key.key.text_len > 0 and isSymbol(key.key.text[0]) else false;
    cache.rendered[slot] = .{
        .raw = input.raw,
        .key = input.key,
        .registration = input.registration,
        .reusable = !symbol and !input.styled and input.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT and
            (input.key == null or input.key.?.key.span == 1),
    };
}

// Row-wide reuse conditions, checked once per row; null when no cell of the row can be reused.
fn reusableRow(comptime stable: bool, frame: *Frame, owner: *const CachedRow, y: u32) ?*const CachedRow {
    const cache = frame.row_cache.?;
    // A joined run depends on its neighbors, which per-cell reuse does not compare.
    if (frame.ligatures != 0) return null;
    const previous = if (stable) owner else &cache.previous[y];
    if (!std.mem.eql(u32, &previous.appearance, &cache.appearance)) return null;
    if (sameRowId(previous.id, std.mem.zeroes(c.GhosttyRenderStateRowId))) return null;
    return previous;
}

// Bitwise equality of instance records; a byte loop here dominated full-screen redraws.
fn sameRecord(comptime n: usize, left: *const [n]f32, right: *const [n]f32) bool {
    const a: *align(4) const [n / 2]u64 = @ptrCast(left);
    const b: *align(4) const [n / 2]u64 = @ptrCast(right);
    for (a, b) |first, second| {
        if (first != second) return false;
    }
    return true;
}

fn reuseRenderedCell(comptime stable: bool, frame: *Frame, previous: *const CachedRow, address: u32, raw: c.GhosttyCell, x: u32, y: u32, selected: bool) bool {
    const cache = frame.row_cache.?;
    const slot = if (stable) address else y * frame.columns + x;
    const old_selected = previous.selected and x >= previous.selection_start and x <= previous.selection_end;
    if (selected != old_selected) return false;
    const input = cache.rendered[slot];
    if (!input.reusable or input.raw != raw) return false;
    if (input.key) |key| {
        // An unresolved glyph must be rebuilt so the retry queues it again.
        if (input.registration != key.registration or key.glyph.valid == 0) return false;
    }
    const cursor = frame.cursor_visible != 0 and frame.cursor_x == x and frame.cursor_y == y;
    const old_cursor = (@as(u32, @intFromFloat(frame.cell_data[slot][12])) & 1) != 0;
    if (cursor != old_cursor or (cursor and frame.cell_data[slot][14] != @as(f32, @floatFromInt(frame.cursor_style)))) return false;
    cache.next[y].cells[x] = .{
        .raw = raw,
        .foreground = 0xffffffff,
        .background = 0xffffffff,
        .style = 0,
        .styled = false,
        .tag = c.GHOSTTY_CELL_CONTENT_CODEPOINT,
        .key = input.key,
        .registration = input.registration,
    };
    return true;
}

const LigatureInk = struct { style: u32, foreground: u32, background: u32, selected: bool };

// Matches runs.ts: one code point per narrow visible cell, keyed by everything that changes ink.
fn ligatureCell(frame: *Frame, raw: c.GhosttyCell, cells: c.GhosttyRenderStateRowCells, x: u32, selected: bool, codepoint: *u32, ink: *LigatureInk) c.GhosttyResult {
    codepoint.* = 0;
    var wide: c.GhosttyCellWide = 0;
    var tag: c.GhosttyCellContentTag = 0;
    var styled = false;
    var point: u32 = 0;
    var result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_WIDE, &wide);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CONTENT_TAG, &tag);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (wide != c.GHOSTTY_CELL_WIDE_NARROW or tag != c.GHOSTTY_CELL_CONTENT_CODEPOINT) return c.GHOSTTY_SUCCESS;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CODEPOINT, &point);
    if (result != c.GHOSTTY_SUCCESS) return result;
    // Symbols, box drawing and icons from U+2000 keep their per-cell sprites and constraints.
    if (point <= 0x20 or point >= 0x2000) return c.GHOSTTY_SUCCESS;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_HAS_STYLING, &styled);
    if (result != c.GHOSTTY_SUCCESS) return result;
    ink.* = .{ .style = 0, .foreground = 0xffffffff, .background = 0xffffffff, .selected = selected };
    if (styled) {
        var style = frame.row_cache.?.default_style;
        result = c.ghostty_render_state_row_cells_select(cells, @intCast(x));
        if (result != c.GHOSTTY_SUCCESS) return result;
        result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
        if (result != c.GHOSTTY_SUCCESS) return result;
        if (style.invisible) return c.GHOSTTY_SUCCESS;
        ink.style = visualStyle(style);
        result = frameColor(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &ink.foreground);
        if (result != c.GHOSTTY_SUCCESS) return result;
        // Minimum contrast adjusts each glyph against its own background, so it changes ink too.
        if (style.inverse or frame.glyph_minimum_contrast > 1) {
            result = frameColor(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &ink.background);
            if (result != c.GHOSTTY_SUCCESS) return result;
        }
    }
    codepoint.* = point;
    return c.GHOSTTY_SUCCESS;
}

// Native Ghostty and Rio keep fi, fl and st apart to protect the cell grid.
fn latinPairBreak(previous: u32, next: u32) bool {
    if (previous == 'f') return next == 'i' or next == 'l';
    return previous == 's' and next == 't';
}

// With BiDi, a run joins only where its cells keep logical order on screen, unmirrored.
fn visualOrderKept(frame: *Frame, projection: ?[*]const BidiCell, y: u32, start: u32, end: u32) bool {
    const cells = projection orelse return true;
    const row = cells + y * frame.columns;
    for (start..end) |x| {
        if (row[x].mirror != 0) return false;
        if (x > start and row[x].visual != row[x - 1].visual + 1) return false;
    }
    return true;
}

fn flushLigatures(frame: *Frame, projection: ?[*]const BidiCell, spans: []u32, codepoints: []u32, out: []u32, start: u32, len: u32, y: u32) void {
    if (len < 2) return;
    const count = ligature_ranges(frame.ligatures, codepoints.ptr, len, out.ptr);
    const cursor = frame.ligature_cursor_visible != 0 and frame.ligature_cursor_y == y;
    for (0..@min(count, len / 2)) |index| {
        const first = out[index * 2];
        const last = out[index * 2 + 1];
        if (first >= last or last > len or last - first < 2) continue;
        const run_start = start + first;
        const run_end = start + last;
        if (cursor and frame.ligature_cursor_x >= run_start and frame.ligature_cursor_x < run_end) continue;
        if (!visualOrderKept(frame, projection, y, run_start, run_end)) continue;
        spans[run_start] = last - first;
        @memset(spans[run_start + 1 .. run_end], ligature_interior);
    }
}

fn planLigatures(frame: *Frame, projection: ?[*]const BidiCell, raws: []const c.GhosttyCell, cells: c.GhosttyRenderStateRowCells, y: u32, has_selection: bool, selection: c.GhosttyRenderStateRowSelection) c.GhosttyResult {
    const columns = frame.columns;
    const scratch = frame.ligature_scratch.?;
    const spans = scratch[0..columns];
    const codepoints = scratch[columns .. columns * 2];
    const out = scratch[columns * 2 .. columns * 3];
    @memset(spans, 0);
    var start: u32 = 0;
    var len: u32 = 0;
    var ink: LigatureInk = undefined;
    for (raws, 0..) |raw, index| {
        const x: u32 = @intCast(index);
        const selected = if (projection) |cells_order| cells_order[y * frame.columns + x].selected != 0 else has_selection and x >= selection.start_x and x <= selection.end_x;
        var point: u32 = 0;
        var cell_ink: LigatureInk = undefined;
        const result = ligatureCell(frame, raw, cells, x, selected, &point, &cell_ink);
        if (result != c.GHOSTTY_SUCCESS) return result;
        if (point == 0) {
            flushLigatures(frame, projection, spans, codepoints, out, start, len, y);
            len = 0;
            continue;
        }
        if (len > 0 and (!std.meta.eql(cell_ink, ink) or latinPairBreak(codepoints[len - 1], point))) {
            flushLigatures(frame, projection, spans, codepoints, out, start, len, y);
            len = 0;
        }
        if (len == 0) start = x;
        ink = cell_ink;
        codepoints[len] = point;
        len += 1;
    }
    flushLigatures(frame, projection, spans, codepoints, out, start, len, y);
    return c.GHOSTTY_SUCCESS;
}

fn buildRow(comptime stable: bool, comptime bidi: bool, projection: ?[*]const BidiCell, frame: *Frame, iterator: c.GhosttyRenderStateRowIterator, cells: *c.GhosttyRenderStateRowCells, y: u32, force: bool) c.GhosttyResult {
    var raw: c.GhosttyCellsView = undefined;
    var result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW, &raw);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (raw.len != frame.columns or y >= frame.rows) return c.GHOSTTY_OUT_OF_SPACE;
    var selection: c.GhosttyRenderStateRowSelection = undefined;
    selection.size = @sizeOf(c.GhosttyRenderStateRowSelection);
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION, &selection);
    const has_selection = result == c.GHOSTTY_SUCCESS;
    if (!has_selection and result != c.GHOSTTY_NO_VALUE) return result;
    const cached = &frame.row_cache.?.next[y];
    cached.appearance = frame.row_cache.?.appearance;
    cached.blinking = false;
    cached.unresolved = false;
    cached.selected = has_selection;
    cached.selection_start = if (has_selection) selection.start_x else 0;
    cached.selection_end = if (has_selection) selection.end_x else 0;
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, @ptrCast(cells));
    if (result != c.GHOSTTY_SUCCESS) return result;
    const spans: ?[*]u32 = if (frame.ligatures != 0) frame.ligature_scratch else null;
    if (spans != null) {
        result = planLigatures(frame, if (bidi) projection else null, raw.ptr[0..raw.len], cells.*, y, has_selection, selection);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    frame.rows_built += 1;
    frame.row_cache.?.run.valid = false;
    frame.row_cache.?.last_glyph.key = null;
    frame.row_cache.?.last_cell_valid = false;
    var cell_first = frame.columns;
    var cell_end: u32 = 0;
    var glyph_first = frame.columns;
    var glyph_end: u32 = 0;
    const start = if (stable) frame.row_cache.?.row_starts.?[y] else y * frame.columns;
    const owner = if (stable) &frame.row_cache.?.previous[previousLogicalRow(frame, y)] else undefined;
    const reuse_row = if (force) null else reusableRow(stable, frame, owner, y);
    for (0..raw.len) |x| {
        const selected = if (bidi) projection.?[y * frame.columns + x].selected != 0 else has_selection and x >= selection.start_x and x <= selection.end_x;
        const visual = if (bidi) projection.?[y * frame.columns + x].visual else @as(u32, @intCast(x));
        const slot = start + visual;
        if (reuse_row) |previous| {
            if (reuseRenderedCell(stable, frame, previous, slot, raw.ptr[x], @intCast(x), y, selected)) continue;
        }
        const previous_cell = frame.cell_data[slot];
        const previous_glyph = frame.glyph_data[slot];
        const joined = if (spans) |values| values[x] else 0;
        result = buildCell(stable, bidi, projection, frame, raw.ptr[0..raw.len], cells.*, slot, @intCast(x), y, selected, joined, !force);
        if (result != c.GHOSTTY_SUCCESS) return result;
        rememberRenderedCell(frame.row_cache.?, slot, cached.cells[x]);
        if (force or !sameRecord(16, &previous_cell, &frame.cell_data[slot])) {
            cell_first = @min(cell_first, @as(u32, @intCast(x)));
            cell_end = @intCast(x + 1);
        }
        if (force or !sameRecord(24, &previous_glyph, &frame.glyph_data[slot])) {
            glyph_first = @min(glyph_first, @as(u32, @intCast(x)));
            glyph_end = @intCast(x + 1);
        }
    }
    // Logical row changes can leave GPU bytes identical, such as concealed text.
    if (frame.ranges_len == frame.ranges_cap) return c.GHOSTTY_OUT_OF_SPACE;
    frame.ranges[frame.ranges_len] = .{
        .cell_offset = (start + if (cell_end == 0) @as(u32, 0) else cell_first) * 64,
        .cell_length = if (cell_end == 0) 0 else (cell_end - cell_first) * 64,
        .glyph_offset = (start + if (glyph_end == 0) @as(u32, 0) else glyph_first) * 96,
        .glyph_length = if (glyph_end == 0) 0 else (glyph_end - glyph_first) * 96,
    };
    frame.ranges_len += 1;
    return c.GHOSTTY_SUCCESS;
}

fn collectFrameGlyphs(frame: *Frame) bool {
    const cache = frame.row_cache.?;
    for (cache.inputs[0 .. frame.columns * frame.rows]) |input| {
        if (input.key) |key| key.retained = true;
    }
    for (cache.rendered[0 .. frame.columns * frame.rows]) |input| {
        if (input.key) |key| key.retained = true;
    }
    return glyph_index.collect(frame.glyph_index);
}

fn unionSpan(offset: *u32, length: *u32, other_offset: u32, other_length: u32) void {
    if (other_length == 0) return;
    if (length.* == 0) {
        offset.* = other_offset;
        length.* = other_length;
        return;
    }
    const end = @max(offset.* + length.*, other_offset + other_length);
    offset.* = @min(offset.*, other_offset);
    length.* = end - offset.*;
}

// Each pass emits at most one range per physical row, so the union keeps that invariant.
fn mergePendingRanges(frame: *Frame, cache: *FrameCache) void {
    const none = cache.rows;
    const row_bytes = frame.columns * 64;
    @memset(cache.range_slots[0..cache.rows], none);
    for (frame.ranges[0..frame.ranges_len], 0..) |range, index| cache.range_slots[range.cell_offset / row_bytes] = @intCast(index);
    for (cache.pending[0..cache.pending_len]) |pending| {
        const row = pending.cell_offset / row_bytes;
        const slot = cache.range_slots[row];
        if (slot == none) {
            cache.range_slots[row] = frame.ranges_len;
            frame.ranges[frame.ranges_len] = pending;
            frame.ranges_len += 1;
            continue;
        }
        const range = &frame.ranges[slot];
        unionSpan(&range.cell_offset, &range.cell_length, pending.cell_offset, pending.cell_length);
        unionSpan(&range.glyph_offset, &range.glyph_length, pending.glyph_offset, pending.glyph_length);
    }
}

fn buildFrame(comptime bidi: bool, projection: ?[*]const BidiCell, state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator, cells: c.GhosttyRenderStateRowCells, mask: ?[*]const u8, mask_len: u32, dirty_only: bool, frame: *Frame) c.GhosttyResult {
    // Grayscale brushes share entries; color histories get eight viewports of headroom.
    const recycle = frame.status != 2 and frame.glyph_index.count >= frame.columns * frame.rows * 8;
    if (recycle) {
        if (!collectFrameGlyphs(frame)) return c.GHOSTTY_OUT_OF_MEMORY;
        frame.index_rebuilds += 1;
    }
    const rebuild_all = frame.glyph_index.rebuild_all != 0;
    const residency_changed = frame.glyph_index.residency_changed != 0;
    // A missing-glyph retry rebuilds only changed cells; the earlier pass's ranges are merged in.
    const retry = frame.status == 2;
    var force = !dirty_only or rebuild_all;
    const previous_stable = frame.stable_rows;
    if (frame.row_cache == null) frame.row_cache = createFrameCache(frame.columns, frame.rows) orelse return c.GHOSTTY_OUT_OF_MEMORY;
    frame.rows_built = 0;
    frame.rows_reused = 0;
    var result = planFrameRows(frame, state, iterator);
    if (result != c.GHOSTTY_SUCCESS) return result;
    const cache = frame.row_cache.?;
    if (!retry) frame.row_changes = 0;
    // Full rebuilds repair remaps that a failed frame never uploaded.
    if (!dirty_only) frame.row_changes |= 4;
    frame.row_changes |= @as(u32, @intFromBool(cache.moved)) | (@as(u32, @intFromBool(previous_stable != frame.stable_rows)) << 1);
    // Glyph retries must retain both remap delivery and every coordinate-layout upload.
    const layout_changed = (frame.row_changes & 2) != 0;
    force = force or layout_changed;
    defer {
        if (result != c.GHOSTTY_SUCCESS) {
            for (0..cache.rows) |row| cache.previous[row].id = std.mem.zeroes(c.GhosttyRenderStateRowId);
        }
    }
    glyph_index.beginBuild(frame.glyph_index);
    frame.ranges_len = 0;
    frame.missing_len = 0;
    frame.status = 0;
    var it = iterator;
    var row_cells = cells;
    result = c.ghostty_render_state_get(state, c.GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, @ptrCast(&it));
    if (result != c.GHOSTTY_SUCCESS) return result;
    var y: u32 = 0;
    frame.blinking_rows = 0;
    while (c.ghostty_render_state_row_iterator_next(it)) : (y += 1) {
        defer frame.blinking_rows += @intFromBool(cache.next[y].blinking);
        var dirty = false;
        result = c.ghostty_render_state_row_get(it, c.GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &dirty);
        if (result != c.GHOSTTY_SUCCESS) return result;
        var write = !dirty_only or dirty or rebuild_all or layout_changed;
        if (residency_changed and !rebuild_all) write = write or rowGlyphsChanged(frame, y);
        if (mask) |m| write = write or (y < mask_len and m[y] != 0);
        write = write or cache.sources[y] != y or cache.next[y].unresolved;
        cache.next[y].cursor = frame.cursor_visible != 0 and frame.cursor_y == y;
        if (!write) continue;
        var matches = false;
        if (!force) {
            result = matchingFrameRow(frame, it, &row_cells, y, &matches);
            if (result != c.GHOSTTY_SUCCESS) return result;
        }
        if (frame.stable_rows != 0) {
            result = if (matches) reuseFrameRow(true, frame, y) else buildRow(true, bidi, projection, frame, it, &row_cells, y, force);
        } else {
            result = if (matches) reuseFrameRow(false, frame, y) else buildRow(false, bidi, projection, frame, it, &row_cells, y, force);
        }
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    if (retry) mergePendingRanges(frame, cache);
    // Any later build in the same frame is a retry, so it must still deliver these ranges.
    @memcpy(cache.pending[0..frame.ranges_len], frame.ranges[0..frame.ranges_len]);
    cache.pending_len = frame.ranges_len;
    std.mem.swap([*]CachedRow, &cache.previous, &cache.next);
    if (frame.status == 0) {
        frame.glyph_index.rebuild_all = 0;
        frame.glyph_index.residency_changed = 0;
    }
    return c.GHOSTTY_SUCCESS;
}

export fn bridge_build_frame(state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator, cells: c.GhosttyRenderStateRowCells, mask: ?[*]const u8, mask_len: u32, dirty_only: bool, frame: *Frame) c.GhosttyResult {
    return buildFrame(false, null, state, iterator, cells, mask, mask_len, dirty_only, frame);
}

export fn bridge_build_bidi_frame(state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator, cells: c.GhosttyRenderStateRowCells, frame: *Frame, projection: [*]const BidiCell) c.GhosttyResult {
    frame.stable_allowed = 0;
    return buildFrame(true, projection, state, iterator, cells, null, 0, false, frame);
}
