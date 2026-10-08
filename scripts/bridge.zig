const host = struct {
    extern "env" fn write_pty(terminal: u32, userdata: u32, data: u32, len: u32) void;
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

const std = @import("std");

const c = @cImport({
    @cInclude("ghostty/vt/render.h");
    @cInclude("ghostty/vt/screen.h");
    @cInclude("ghostty/vt/style.h");
});

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
};

fn readTextCell(raw: c.GhosttyCell, cells: c.GhosttyRenderStateRowCells, x: u32, out: *TextCell, text: *TextSnapshot) c.GhosttyResult {
    out.* = .{ .codepoint = 0, .grapheme_start = 0, .grapheme_len = 0 };
    var wide: c.GhosttyCellWide = 0;
    var result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CODEPOINT, &out.codepoint);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_WIDE, &wide);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (wide == c.GHOSTTY_CELL_WIDE_SPACER_TAIL) out.codepoint |= 0x80000000;
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
};

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
};
const CachedRow = struct {
    id: c.GhosttyRenderStateRowId,
    cells: [*]CachedCell,
    selected: bool = false,
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
    inputs: [*]CachedCell,
    cells: [*][16]f32,
    glyphs: [*][24]f32,
    moved: bool = false,
    appearance: [11]u32 = [_]u32{0} ** 11,
    default_style: c.GhosttyStyle,
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
    const inputs = frameAllocate(CachedCell, columns * rows) orelse return error.OutOfMemory;
    errdefer frameFree(CachedCell, inputs, columns * rows);
    const cells = frameAllocate([16]f32, columns * rows) orelse return error.OutOfMemory;
    errdefer frameFree([16]f32, cells, columns * rows);
    const glyphs = frameAllocate([24]f32, columns * rows) orelse return error.OutOfMemory;
    for (0..rows) |y| previous[y] = .{ .id = std.mem.zeroes(c.GhosttyRenderStateRowId), .cells = inputs + y * columns };
    var default_style: c.GhosttyStyle = undefined;
    c.ghostty_style_default(&default_style);
    memory[0] = .{ .columns = columns, .rows = rows, .previous = previous, .next = next, .incoming = incoming, .sources = sources, .used = used, .inputs = inputs, .cells = cells, .glyphs = glyphs, .default_style = default_style };
    return &memory[0];
}

fn createFrameCache(columns: u32, rows: u32) ?*FrameCache {
    return createFrameCacheFallible(columns, rows) catch null;
}

export fn bridge_destroy_frame_cache(cache: *FrameCache) void {
    frameFree(CachedRow, cache.previous, cache.rows);
    frameFree(CachedRow, cache.next, cache.rows);
    frameFree(c.GhosttyRenderStateRowId, cache.incoming, cache.rows);
    frameFree(u32, cache.sources, cache.rows);
    frameFree(bool, cache.used, cache.rows);
    frameFree(CachedCell, cache.inputs, cache.columns * cache.rows);
    frameFree([16]f32, cache.cells, cache.columns * cache.rows);
    frameFree([24]f32, cache.glyphs, cache.columns * cache.rows);
    ghostty_wasm_free(@ptrCast(cache), @sizeOf(FrameCache));
}

fn sameRowId(a: c.GhosttyRenderStateRowId, b: c.GhosttyRenderStateRowId) bool {
    return a.bits[0] == b.bits[0] and a.bits[1] == b.bits[1];
}

fn planFrameRows(frame: *Frame, state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator) c.GhosttyResult {
    const cache = frame.row_cache.?;
    @memset(cache.used[0..cache.rows], false);
    cache.moved = false;
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
        cache.sources[y] = cache.rows;
        for (0..cache.rows) |source| {
            if (!sameRowId(cache.previous[source].id, cache.incoming[y])) continue;
            cache.sources[y] = @intCast(source);
            cache.used[source] = true;
            break;
        }
    }
    if (y != cache.rows) return c.GHOSTTY_OUT_OF_SPACE;
    for (0..cache.rows) |destination| {
        if (cache.sources[destination] == cache.rows) {
            const source = std.mem.indexOfScalar(bool, cache.used[0..cache.rows], false) orelse return c.GHOSTTY_OUT_OF_SPACE;
            cache.sources[destination] = @intCast(source);
            cache.used[source] = true;
        }
        const source = cache.sources[destination];
        cache.next[destination] = cache.previous[source];
        cache.next[destination].id = cache.incoming[destination];
        cache.moved = cache.moved or source != destination;
    }
    if (!cache.moved) return c.GHOSTTY_SUCCESS;
    @memcpy(cache.cells[0 .. cache.columns * cache.rows], frame.cell_data[0 .. cache.columns * cache.rows]);
    @memcpy(cache.glyphs[0 .. cache.columns * cache.rows], frame.glyph_data[0 .. cache.columns * cache.rows]);
    return c.GHOSTTY_SUCCESS;
}

fn visualStyle(style: c.GhosttyStyle) u32 {
    return @as(u32, @intFromBool(style.bold)) | (@as(u32, @intFromBool(style.italic)) << 1) |
        (@as(u32, @intFromBool(style.faint)) << 2) | (@as(u32, @intFromBool(style.inverse)) << 3) |
        (@as(u32, @intFromBool(style.invisible)) << 4) | (@as(u32, @intFromBool(style.strikethrough)) << 5) |
        (@as(u32, @intFromBool(style.overline)) << 6) | (@as(u32, @intCast(style.underline)) << 8);
}

fn matchingFrameRow(frame: *Frame, iterator: c.GhosttyRenderStateRowIterator, cells: *c.GhosttyRenderStateRowCells, y: u32, matches: *bool) c.GhosttyResult {
    matches.* = false;
    const cache = frame.row_cache.?;
    const source = cache.sources[y];
    const row = cache.previous[source];
    if (source == y or row.cursor or cache.next[y].cursor or !sameRowId(row.id, cache.incoming[y])) return c.GHOSTTY_SUCCESS;
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

fn reuseFrameRow(frame: *Frame, y: u32) c.GhosttyResult {
    const cache = frame.row_cache.?;
    const source = cache.sources[y];
    const start = y * frame.columns;
    const source_start = source * frame.columns;
    @memcpy(frame.cell_data[start .. start + frame.columns], cache.cells[source_start .. source_start + frame.columns]);
    @memcpy(frame.glyph_data[start .. start + frame.columns], cache.glyphs[source_start .. source_start + frame.columns]);
    var cell_first = frame.columns;
    var cell_end: u32 = 0;
    var glyph_first = frame.columns;
    var glyph_end: u32 = 0;
    const top = @as(f32, @floatFromInt(y)) * frame.cell_height;
    for (0..frame.columns) |x| {
        const cell = &frame.cell_data[start + x];
        const glyph = &frame.glyph_data[start + x];
        if (cell[3] != 0) cell[1] = top;
        if (glyph[16] != 0) glyph[1] = top + cache.next[y].cells[x].key.?.glyph.offset_y;
        if (!std.mem.eql(u8, std.mem.asBytes(cell), std.mem.asBytes(&cache.cells[start + x]))) {
            cell_first = @min(cell_first, @as(u32, @intCast(x)));
            cell_end = @intCast(x + 1);
        }
        if (!std.mem.eql(u8, std.mem.asBytes(glyph), std.mem.asBytes(&cache.glyphs[start + x]))) {
            glyph_first = @min(glyph_first, @as(u32, @intCast(x)));
            glyph_end = @intCast(x + 1);
        }
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
}

export fn bridge_clear_glyphs(index: *glyph_index.Index) void {
    glyph_index.clear(index);
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

fn writeColor(out: []f32, rgb: u32, alpha: f32) void {
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

const CellContent = struct {
    codepoint: u32,
    continuation: bool,
    span: u32,
    tag: c.GhosttyCellContentTag,
};

fn writeInstances(frame: *Frame, cells: c.GhosttyRenderStateRowCells, x: u32, y: u32, content: CellContent, style: c.GhosttyStyle, fg: u32, bg: u32, selected: bool) c.GhosttyResult {
    const slot = y * frame.columns + x;
    const cell = &frame.cell_data[slot];
    const glyph = &frame.glyph_data[slot];
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
    const left = @as(f32, @floatFromInt(x)) * frame.cell_width;
    const top = @as(f32, @floatFromInt(y)) * frame.cell_height;
    if (draw_background or cursor or style.underline > 0 or style.strikethrough or style.overline) {
        cell[0..4].* = .{ left, top, frame.cell_width, frame.cell_height };
    }
    writeColor(cell[4..8], foreground, 1);
    writeColor(cell[8..12], background, if (draw_background) 1 else 0);
    const flags: u32 = @as(u32, @intFromBool(cursor)) | (@as(u32, @intFromBool(style.overline)) << 1) |
        (@as(u32, @intFromBool(style.strikethrough)) << 2);
    cell[12] = @floatFromInt(flags);
    cell[13] = @floatFromInt(style.underline);
    cell[14] = if (cursor) @floatFromInt(frame.cursor_style) else 0;
    cell[15] = frame.minimum_contrast;
    if (content.continuation or content.codepoint == 0 or style.invisible) return c.GHOSTTY_SUCCESS;
    var scalar = content.codepoint;
    var text: []const u32 = @as(*const [1]u32, &scalar);
    if (content.tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) {
        var length: u32 = 0;
        var result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &length);
        if (result != c.GHOSTTY_SUCCESS) return result;
        const scratch = glyph_index.scratch(frame.glyph_index, length) orelse return c.GHOSTTY_OUT_OF_MEMORY;
        result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, scratch.ptr);
        if (result != c.GHOSTTY_SUCCESS) return result;
        text = scratch;
    }
    const key = glyph_index.resolve(frame.glyph_index, .{
        .text = text.ptr,
        .text_len = @intCast(text.len),
        .span = content.span,
        .style = @as(u32, @intFromBool(style.bold)) | (@as(u32, @intFromBool(style.italic)) << 1),
        .foreground = foreground,
        .background = background,
        .minimum_contrast = frame.glyph_minimum_contrast,
    }) orelse return c.GHOSTTY_OUT_OF_MEMORY;
    frame.row_cache.?.next[y].cells[x].key = key;
    const entry = key.glyph;
    if (entry.valid == 0) return missingGlyph(frame, key);
    if (entry.width == 0 or entry.height == 0) return c.GHOSTTY_SUCCESS;
    glyph[0..4].* = .{ left + entry.offset_x, top + entry.offset_y, entry.width, entry.height };
    writeColor(glyph[4..8], foreground, if (style.faint) 0.5 else 1);
    glyph[8..12].* = .{ entry.u0, entry.v0, entry.u1, entry.v1 };
    writeColor(glyph[12..16], background, 1);
    glyph[16] = 1;
    glyph[18] = frame.minimum_contrast;
    glyph[20] = entry.layer;
    glyph[21] = entry.generation;
    glyph[22] = entry.kind;
    return c.GHOSTTY_SUCCESS;
}

fn buildCell(frame: *Frame, raws: []const c.GhosttyCell, cells: c.GhosttyRenderStateRowCells, x: u32, y: u32, selected: bool) c.GhosttyResult {
    const raw = raws[x];
    var codepoint: u32 = 0;
    var wide: c.GhosttyCellWide = 0;
    var tag: c.GhosttyCellContentTag = 0;
    var result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CODEPOINT, &codepoint);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_WIDE, &wide);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CONTENT_TAG, &tag);
    if (result != c.GHOSTTY_SUCCESS) return result;
    var style = frame.row_cache.?.default_style;
    var styled = false;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_HAS_STYLING, &styled);
    if (result != c.GHOSTTY_SUCCESS) return result;
    // Unstyled text has no explicit background; graphemes still need native text selection.
    const default_colors = !styled and (tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT or tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME);
    if (!default_colors or tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) {
        result = c.ghostty_render_state_row_cells_select(cells, @intCast(x));
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    var fg: u32 = 0xffffffff;
    if (styled) {
        result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
        if (result != c.GHOSTTY_SUCCESS) return result;
        result = frameColor(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &fg);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    var bg: u32 = 0xffffffff;
    if (!default_colors) {
        result = frameColor(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &bg);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    var span: u32 = 1;
    while (x + span < raws.len) : (span += 1) {
        var next_wide: c.GhosttyCellWide = 0;
        result = c.ghostty_cell_get(raws[x + span], c.GHOSTTY_CELL_DATA_WIDE, &next_wide);
        if (result != c.GHOSTTY_SUCCESS) return result;
        if (next_wide != c.GHOSTTY_CELL_WIDE_SPACER_TAIL) break;
    }
    frame.row_cache.?.next[y].cells[x] = .{
        .raw = raw,
        .foreground = fg,
        .background = bg,
        .style = visualStyle(style),
        .styled = styled,
        .tag = tag,
        .key = null,
    };
    return writeInstances(frame, cells, x, y, .{
        .codepoint = codepoint,
        .continuation = wide == c.GHOSTTY_CELL_WIDE_SPACER_TAIL,
        .span = span,
        .tag = tag,
    }, style, fg, bg, selected);
}

fn buildRow(frame: *Frame, iterator: c.GhosttyRenderStateRowIterator, cells: *c.GhosttyRenderStateRowCells, y: u32, force: bool) c.GhosttyResult {
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
    cached.selected = has_selection;
    cached.selection_start = if (has_selection) selection.start_x else 0;
    cached.selection_end = if (has_selection) selection.end_x else 0;
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, @ptrCast(cells));
    if (result != c.GHOSTTY_SUCCESS) return result;
    frame.rows_built += 1;
    var cell_first = frame.columns;
    var cell_end: u32 = 0;
    var glyph_first = frame.columns;
    var glyph_end: u32 = 0;
    for (0..raw.len) |x| {
        const slot = y * frame.columns + x;
        const previous_cell = frame.cell_data[slot];
        const previous_glyph = frame.glyph_data[slot];
        const selected = has_selection and x >= selection.start_x and x <= selection.end_x;
        result = buildCell(frame, raw.ptr[0..raw.len], cells.*, @intCast(x), y, selected);
        if (result != c.GHOSTTY_SUCCESS) return result;
        if (force or !std.mem.eql(u8, std.mem.asBytes(&previous_cell), std.mem.asBytes(&frame.cell_data[slot]))) {
            cell_first = @min(cell_first, @as(u32, @intCast(x)));
            cell_end = @intCast(x + 1);
        }
        if (force or !std.mem.eql(u8, std.mem.asBytes(&previous_glyph), std.mem.asBytes(&frame.glyph_data[slot]))) {
            glyph_first = @min(glyph_first, @as(u32, @intCast(x)));
            glyph_end = @intCast(x + 1);
        }
    }
    // Logical row changes can leave GPU bytes identical, such as concealed text.
    if (frame.ranges_len == frame.ranges_cap) return c.GHOSTTY_OUT_OF_SPACE;
    frame.ranges[frame.ranges_len] = .{
        .cell_offset = (y * frame.columns + if (cell_end == 0) @as(u32, 0) else cell_first) * 64,
        .cell_length = if (cell_end == 0) 0 else (cell_end - cell_first) * 64,
        .glyph_offset = (y * frame.columns + if (glyph_end == 0) @as(u32, 0) else glyph_first) * 96,
        .glyph_length = if (glyph_end == 0) 0 else (glyph_end - glyph_first) * 96,
    };
    frame.ranges_len += 1;
    return c.GHOSTTY_SUCCESS;
}

export fn bridge_build_frame(state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator, cells: c.GhosttyRenderStateRowCells, mask: ?[*]const u8, mask_len: u32, dirty_only: bool, frame: *Frame) c.GhosttyResult {
    // Grayscale brushes share entries; color histories get eight viewports of headroom.
    const recycle = frame.status != 2 and frame.glyph_index.count >= frame.columns * frame.rows * 8;
    if (recycle) {
        glyph_index.clear(frame.glyph_index);
        frame.index_rebuilds += 1;
    }
    const rebuild_all = frame.glyph_index.rebuild_all != 0;
    // A missing-glyph retry must upload cell changes written before registration.
    const force = !dirty_only or frame.status == 2 or rebuild_all;
    if (frame.row_cache == null) frame.row_cache = createFrameCache(frame.columns, frame.rows) orelse return c.GHOSTTY_OUT_OF_MEMORY;
    frame.rows_built = 0;
    frame.rows_reused = 0;
    var result = planFrameRows(frame, state, iterator);
    if (result != c.GHOSTTY_SUCCESS) return result;
    const cache = frame.row_cache.?;
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
    while (c.ghostty_render_state_row_iterator_next(it)) : (y += 1) {
        var dirty = false;
        result = c.ghostty_render_state_row_get(it, c.GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &dirty);
        if (result != c.GHOSTTY_SUCCESS) return result;
        var write = !dirty_only or dirty or rebuild_all;
        if (mask) |m| write = write or (y < mask_len and m[y] != 0);
        write = write or cache.sources[y] != y;
        cache.next[y].cursor = frame.cursor_visible != 0 and frame.cursor_y == y;
        if (!write) continue;
        var matches = false;
        if (!force) {
            result = matchingFrameRow(frame, it, &row_cells, y, &matches);
            if (result != c.GHOSTTY_SUCCESS) return result;
        }
        result = if (matches) reuseFrameRow(frame, y) else buildRow(frame, it, &row_cells, y, force);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    std.mem.swap([*]CachedRow, &cache.previous, &cache.next);
    if (frame.status == 0) frame.glyph_index.rebuild_all = 0;
    return c.GHOSTTY_SUCCESS;
}
