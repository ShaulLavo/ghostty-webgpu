const std = @import("std");
const c = @cImport({
    @cInclude("ghostty/vt/render.h");
    @cInclude("ghostty/vt/screen.h");
    @cInclude("ghostty/vt/style.h");
});
extern "env" fn ghostty_wasm_alloc(len: usize) ?[*]u8;
extern "env" fn ghostty_wasm_free(ptr: ?[*]u8, len: usize) void;

const Decoration = struct { foreground: u32 = 0xffffffff, background: u32 = 0xffffffff, flags: u32 = 0 };
const Grapheme = struct { pointer: ?[*]u32 = null, length: u32 = 0 };
const RawRow = struct { selection: c.GhosttyRenderStateRowSelection, selected: bool = false, revision: u64 = 0 };
pub const Frame = struct {
    columns: u32,
    rows: u32,
    raw: [*]c.GhosttyCell,
    decorations: [*]Decoration,
    graphemes: [*]Grapheme,
    metadata: [*]RawRow,
    revision: u64 = 0,
};

fn allocate(comptime T: type, count: usize) ?[*]T {
    return @ptrCast(@alignCast(ghostty_wasm_alloc(count * @sizeOf(T)) orelse return null));
}
fn free(comptime T: type, pointer: [*]T, count: usize) void {
    ghostty_wasm_free(@ptrCast(pointer), count * @sizeOf(T));
}

pub fn create(columns: u32, rows: u32) callconv(.c) ?*Frame {
    const memory = allocate(Frame, 1) orelse return null;
    const raw = allocate(c.GhosttyCell, columns * rows) orelse {
        free(Frame, memory, 1);
        return null;
    };
    const decorations = allocate(Decoration, columns * rows) orelse {
        free(c.GhosttyCell, raw, columns * rows);
        free(Frame, memory, 1);
        return null;
    };
    const graphemes = allocate(Grapheme, columns * rows) orelse {
        free(Decoration, decorations, columns * rows);
        free(c.GhosttyCell, raw, columns * rows);
        free(Frame, memory, 1);
        return null;
    };
    const metadata = allocate(RawRow, rows) orelse {
        free(Grapheme, graphemes, columns * rows);
        free(Decoration, decorations, columns * rows);
        free(c.GhosttyCell, raw, columns * rows);
        free(Frame, memory, 1);
        return null;
    };
    @memset(graphemes[0 .. columns * rows], .{});
    @memset(metadata[0..rows], .{ .selection = undefined });
    memory[0] = .{ .columns = columns, .rows = rows, .raw = raw, .decorations = decorations, .graphemes = graphemes, .metadata = metadata };
    return &memory[0];
}

pub fn destroy(frame: *Frame) callconv(.c) void {
    for (frame.graphemes[0 .. frame.columns * frame.rows]) |g| if (g.pointer) |p| {
        free(u32, p, g.length);
    };
    free(c.GhosttyCell, frame.raw, frame.columns * frame.rows);
    free(Decoration, frame.decorations, frame.columns * frame.rows);
    free(Grapheme, frame.graphemes, frame.columns * frame.rows);
    free(RawRow, frame.metadata, frame.rows);
    ghostty_wasm_free(@ptrCast(frame), @sizeOf(Frame));
}

fn color(cells: c.GhosttyRenderStateRowCells, field: c.GhosttyRenderStateRowCellsData, out: *u32) c.GhosttyResult {
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
fn decoration(cells: c.GhosttyRenderStateRowCells, styled: bool, out: *Decoration) c.GhosttyResult {
    out.* = .{};
    if (styled) {
        var style: c.GhosttyStyle = undefined;
        style.size = @sizeOf(c.GhosttyStyle);
        var result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
        if (result != c.GHOSTTY_SUCCESS) return result;
        out.flags = 8 | (@as(u32, @intFromBool(style.bold)) << 4) | (@as(u32, @intFromBool(style.italic)) << 5) |
            (@as(u32, @intFromBool(style.faint)) << 6) | (@as(u32, @intFromBool(style.blink)) << 7) |
            (@as(u32, @intFromBool(style.inverse)) << 8) | (@as(u32, @intFromBool(style.invisible)) << 9) |
            (@as(u32, @intFromBool(style.strikethrough)) << 10) | (@as(u32, @intFromBool(style.overline)) << 11) |
            (@as(u32, @intCast(style.underline)) << 12);
        result = color(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &out.foreground);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    return color(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &out.background);
}

fn captureGrapheme(frame: *Frame, slot: usize, cells: c.GhosttyRenderStateRowCells) c.GhosttyResult {
    const g = &frame.graphemes[slot];
    var length: u32 = 0;
    var result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &length);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (length != g.length) {
        const pointer = allocate(u32, length) orelse return c.GHOSTTY_OUT_OF_MEMORY;
        if (g.pointer) |old| free(u32, old, g.length);
        g.* = .{ .pointer = pointer, .length = length };
    }
    result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, g.pointer);
    return result;
}

fn captureRow(frame: *Frame, iterator: c.GhosttyRenderStateRowIterator, cells: c.GhosttyRenderStateRowCells, y: usize, tag_shift: u6, style_shift: u6, style_mask: u64) c.GhosttyResult {
    var raws: c.GhosttyCellsView = undefined;
    var result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW, &raws);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (raws.len != frame.columns) return c.GHOSTTY_INVALID_VALUE;
    const start = y * frame.columns;
    @memcpy(frame.raw[start .. start + frame.columns], raws.ptr[0..raws.len]);
    const row = &frame.metadata[y];
    row.selection.size = @sizeOf(c.GhosttyRenderStateRowSelection);
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION, &row.selection);
    if (result != c.GHOSTTY_SUCCESS and result != c.GHOSTTY_NO_VALUE) return result;
    row.selected = result == c.GHOSTTY_SUCCESS;
    var row_cells = cells;
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, @ptrCast(&row_cells));
    if (result != c.GHOSTTY_SUCCESS) return result;
    var previous_style: u64 = std.math.maxInt(u64);
    var previous_decoration: Decoration = .{};
    for (raws.ptr[0..raws.len], 0..) |raw, x| {
        const slot = start + x;
        const tag = (raw >> tag_shift) & 3;
        const style = (raw >> style_shift) & style_mask;
        const styled = style != 0;
        if (tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME or tag >= c.GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE or (styled and style != previous_style)) {
            result = c.ghostty_render_state_row_cells_select(row_cells, @intCast(x));
            if (result != c.GHOSTTY_SUCCESS) return result;
        }
        if (tag == c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) {
            result = captureGrapheme(frame, slot, row_cells);
            if (result != c.GHOSTTY_SUCCESS) return result;
        } else if (frame.graphemes[slot].pointer) |p| {
            free(u32, p, frame.graphemes[slot].length);
            frame.graphemes[slot] = .{};
        }
        if (tag >= c.GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE) {
            result = decoration(row_cells, styled, &frame.decorations[slot]);
            if (result != c.GHOSTTY_SUCCESS) return result;
            previous_style = std.math.maxInt(u64);
            continue;
        }
        if (!styled) {
            frame.decorations[slot] = .{};
            continue;
        }
        if (style != previous_style) {
            result = decoration(row_cells, true, &previous_decoration);
            if (result != c.GHOSTTY_SUCCESS) return result;
            previous_style = style;
        }
        frame.decorations[slot] = previous_decoration;
    }
    return c.GHOSTTY_SUCCESS;
}

fn copyRow(frame: *Frame, baseline: *const Frame, y: usize) c.GhosttyResult {
    const start = y * frame.columns;
    const end = start + frame.columns;
    // A failed copy must never leave a stale slot marked as matching its accepted baseline.
    frame.metadata[y].revision = 0;
    @memcpy(frame.raw[start..end], baseline.raw[start..end]);
    @memcpy(frame.decorations[start..end], baseline.decorations[start..end]);
    for (start..end) |slot| {
        const source = baseline.graphemes[slot];
        const target = &frame.graphemes[slot];
        if (source.length != target.length) {
            const pointer = if (source.length == 0) null else allocate(u32, source.length) orelse return c.GHOSTTY_OUT_OF_MEMORY;
            if (target.pointer) |old| free(u32, old, target.length);
            target.* = .{ .pointer = pointer, .length = source.length };
        }
        if (source.length > 0) @memcpy(target.pointer.?[0..source.length], source.pointer.?[0..source.length]);
    }
    frame.metadata[y] = baseline.metadata[y];
    return c.GHOSTTY_SUCCESS;
}

pub fn capture(frame: *Frame, baseline: ?*const Frame, full: bool, state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator, cells: c.GhosttyRenderStateRowCells, tag_shift: u32, style_shift: u32, style_width: u32) callconv(.c) c.GhosttyResult {
    const previous = if (baseline) |b| (if (b.columns == frame.columns and b.rows == frame.rows) b else null) else null;
    var damage: c.GhosttyRenderStateDirty = undefined;
    var result = c.ghostty_render_state_get(state, c.GHOSTTY_RENDER_STATE_DATA_DIRTY, &damage);
    if (result != c.GHOSTTY_SUCCESS) return result;
    const capture_all = full or previous == null or damage == c.GHOSTTY_RENDER_STATE_DIRTY_FULL;
    // Revisions stay unique across grid changes and later reuse of an older-sized spare.
    const revision = if (baseline) |b| b.revision + 1 else 1;
    var it = iterator;
    result = c.ghostty_render_state_get(state, c.GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, @ptrCast(&it));
    if (result != c.GHOSTTY_SUCCESS) return result;
    var y: usize = 0;
    while (c.ghostty_render_state_row_iterator_next(it)) : (y += 1) {
        if (y >= frame.rows) return c.GHOSTTY_INVALID_VALUE;
        var dirty = capture_all;
        if (!dirty) {
            result = c.ghostty_render_state_row_get(it, c.GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &dirty);
            if (result != c.GHOSTTY_SUCCESS) return result;
        }
        if (!dirty) {
            const b = previous.?;
            if (frame.metadata[y].revision == b.metadata[y].revision) continue;
            result = copyRow(frame, b, y);
            if (result != c.GHOSTTY_SUCCESS) return result;
            continue;
        }
        frame.metadata[y].revision = 0;
        result = captureRow(frame, it, cells, y, @intCast(tag_shift), @intCast(style_shift), (@as(u64, 1) << @as(u6, @intCast(style_width))) - 1);
        if (result != c.GHOSTTY_SUCCESS) return result;
        frame.metadata[y].revision = revision;
    }
    if (y != frame.rows) return c.GHOSTTY_INVALID_VALUE;
    frame.revision = revision;
    return c.GHOSTTY_SUCCESS;
}

const Row = extern struct { y: u32, dirty: u32, start: u32, len: u32 };
const Cell = extern struct { codepoint: u32, foreground: u32, background: u32, flags: u32, grapheme_start: u32, grapheme_len: u32 };
const Snapshot = extern struct { rows: [*]Row, rows_cap: u32, rows_len: u32, cells: [*]Cell, cells_cap: u32, cells_len: u32, graphemes: [*]u32, graphemes_cap: u32, graphemes_len: u32 };
const TextRow = extern struct { y: u32, start: u32, len: u32 };
const TextCell = extern struct { codepoint: u32, grapheme_start: u32, grapheme_len: u32 };
const TextSnapshot = extern struct { rows: [*]TextRow, rows_cap: u32, rows_len: u32, cells: [*]TextCell, cells_cap: u32, cells_len: u32, graphemes: [*]u32, graphemes_cap: u32, graphemes_len: u32, codepoint_mask: u32 };

fn copyGrapheme(g: Grapheme, snapshot: anytype) void {
    if (g.length == 0) return;
    const start = snapshot.graphemes_len;
    snapshot.graphemes_len += g.length;
    if (snapshot.graphemes_len <= snapshot.graphemes_cap) @memcpy(snapshot.graphemes[start .. start + g.length], g.pointer.?[0..g.length]);
}
fn read(comptime text: bool, frame: *Frame, mask: ?[*]const u8, mask_len: u32, snapshot: if (text) *TextSnapshot else *Snapshot) c.GhosttyResult {
    snapshot.rows_len = 0;
    snapshot.cells_len = 0;
    snapshot.graphemes_len = 0;
    if (text) snapshot.codepoint_mask = 0;
    for (0..frame.rows) |y| {
        if (mask) |m| {
            if (y >= mask_len or m[y] == 0) continue;
        }
        if (snapshot.rows_len >= snapshot.rows_cap or snapshot.cells_len + frame.columns > snapshot.cells_cap) return c.GHOSTTY_OUT_OF_SPACE;
        if (text) snapshot.rows[snapshot.rows_len] = .{ .y = @intCast(y), .start = snapshot.cells_len, .len = frame.columns } else snapshot.rows[snapshot.rows_len] = .{ .y = @intCast(y), .dirty = 0, .start = snapshot.cells_len, .len = frame.columns };
        snapshot.rows_len += 1;
        for (0..frame.columns) |x| {
            const slot = y * frame.columns + x;
            const raw = frame.raw[slot];
            const g = frame.graphemes[slot];
            var codepoint: u32 = 0;
            var wide: c.GhosttyCellWide = 0;
            var result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CODEPOINT, &codepoint);
            if (result != c.GHOSTTY_SUCCESS) return result;
            result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_WIDE, &wide);
            if (result != c.GHOSTTY_SUCCESS) return result;
            const out = &snapshot.cells[snapshot.cells_len];
            if (text) {
                out.* = .{ .codepoint = codepoint | (if (wide == c.GHOSTTY_CELL_WIDE_SPACER_TAIL) @as(u32, 0x80000000) else 0), .grapheme_start = snapshot.graphemes_len, .grapheme_len = g.length };
                snapshot.codepoint_mask |= out.codepoint;
            } else {
                const d = frame.decorations[slot];
                const row = frame.metadata[y];
                const selected = row.selected and x >= row.selection.start_x and x <= row.selection.end_x;
                out.* = .{ .codepoint = codepoint, .foreground = d.foreground, .background = d.background, .flags = d.flags | @as(u32, @intCast(wide)) | (@as(u32, @intFromBool(selected)) << 2), .grapheme_start = snapshot.graphemes_len, .grapheme_len = g.length };
            }
            copyGrapheme(g, snapshot);
            snapshot.cells_len += 1;
        }
    }
    return if (snapshot.graphemes_len > snapshot.graphemes_cap) c.GHOSTTY_OUT_OF_SPACE else c.GHOSTTY_SUCCESS;
}

pub fn readText(frame: *Frame, _: u32, _: u32, mask: ?[*]const u8, mask_len: u32, _: bool, snapshot: *TextSnapshot) callconv(.c) c.GhosttyResult {
    return read(true, frame, mask, mask_len, snapshot);
}
pub fn readRows(frame: *Frame, _: u32, _: u32, mask: ?[*]const u8, mask_len: u32, _: bool, snapshot: *Snapshot) callconv(.c) c.GhosttyResult {
    return read(false, frame, mask, mask_len, snapshot);
}
