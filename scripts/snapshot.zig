const c = @cImport({
    @cInclude("ghostty/vt/render.h");
    @cInclude("ghostty/vt/screen.h");
    @cInclude("ghostty/vt/style.h");
});

const Row = extern struct { y: u32, dirty: u32, start: u32, len: u32 };
const Cell = extern struct {
    codepoint: u32,
    foreground: u32,
    background: u32,
    flags: u32,
    grapheme_start: u32,
    grapheme_len: u32,
};
const Snapshot = extern struct {
    rows: [*]Row,
    rows_cap: u32,
    rows_len: u32,
    cells: [*]Cell,
    cells_cap: u32,
    cells_len: u32,
    graphemes: [*]u32,
    graphemes_cap: u32,
    graphemes_len: u32,
};

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

fn readCell(raw: c.GhosttyCell, cells: c.GhosttyRenderStateRowCells, selected: bool, out: *Cell, snapshot: *Snapshot) c.GhosttyResult {
    out.* = .{ .codepoint = 0, .foreground = 0xffffffff, .background = 0xffffffff, .flags = 0, .grapheme_start = 0, .grapheme_len = 0 };
    var wide: c.GhosttyCellWide = 0;
    var styled = false;
    var result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CODEPOINT, &out.codepoint);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_WIDE, &wide);
    if (result != c.GHOSTTY_SUCCESS) return result;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_HAS_STYLING, &styled);
    if (result != c.GHOSTTY_SUCCESS) return result;
    out.flags = @as(u32, @intCast(wide)) | (@as(u32, @intFromBool(selected)) << 2);
    if (styled) {
        var style: c.GhosttyStyle = undefined;
        style.size = @sizeOf(c.GhosttyStyle);
        result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
        if (result != c.GHOSTTY_SUCCESS) return result;
        out.flags |= 8 | (@as(u32, @intFromBool(style.bold)) << 4) | (@as(u32, @intFromBool(style.italic)) << 5) |
            (@as(u32, @intFromBool(style.faint)) << 6) | (@as(u32, @intFromBool(style.blink)) << 7) |
            (@as(u32, @intFromBool(style.inverse)) << 8) | (@as(u32, @intFromBool(style.invisible)) << 9) |
            (@as(u32, @intFromBool(style.strikethrough)) << 10) | (@as(u32, @intFromBool(style.overline)) << 11) |
            (@as(u32, @intCast(style.underline)) << 12);
        result = color(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &out.foreground);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    result = color(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &out.background);
    if (result != c.GHOSTTY_SUCCESS) return result;
    var tag: c.GhosttyCellContentTag = 0;
    result = c.ghostty_cell_get(raw, c.GHOSTTY_CELL_DATA_CONTENT_TAG, &tag);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (tag != c.GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME) return c.GHOSTTY_SUCCESS;
    result = c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &out.grapheme_len);
    if (result != c.GHOSTTY_SUCCESS) return result;
    out.grapheme_start = snapshot.graphemes_len;
    snapshot.graphemes_len += out.grapheme_len;
    if (snapshot.graphemes_len > snapshot.graphemes_cap) return c.GHOSTTY_SUCCESS;
    return c.ghostty_render_state_row_cells_get(cells, c.GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, snapshot.graphemes + out.grapheme_start);
}

fn readRow(iterator: c.GhosttyRenderStateRowIterator, cells: *c.GhosttyRenderStateRowCells, y: u32, dirty: bool, snapshot: *Snapshot) c.GhosttyResult {
    var raws: c.GhosttyCellsView = undefined;
    var result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS_RAW, &raws);
    if (result != c.GHOSTTY_SUCCESS) return result;
    if (snapshot.rows_len >= snapshot.rows_cap or snapshot.cells_len + raws.len > snapshot.cells_cap) return c.GHOSTTY_OUT_OF_SPACE;
    snapshot.rows[snapshot.rows_len] = .{ .y = y, .dirty = @intFromBool(dirty), .start = snapshot.cells_len, .len = raws.len };
    snapshot.rows_len += 1;
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, @ptrCast(cells));
    if (result != c.GHOSTTY_SUCCESS) return result;
    var selection: c.GhosttyRenderStateRowSelection = undefined;
    selection.size = @sizeOf(c.GhosttyRenderStateRowSelection);
    result = c.ghostty_render_state_row_get(iterator, c.GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION, &selection);
    const has_selection = result == c.GHOSTTY_SUCCESS;
    if (!has_selection and result != c.GHOSTTY_NO_VALUE) return result;
    for (0..raws.len) |x| {
        result = c.ghostty_render_state_row_cells_select(cells.*, @intCast(x));
        if (result != c.GHOSTTY_SUCCESS) return result;
        const selected = has_selection and x >= selection.start_x and x <= selection.end_x;
        result = readCell(raws.ptr[x], cells.*, selected, &snapshot.cells[snapshot.cells_len], snapshot);
        if (result != c.GHOSTTY_SUCCESS) return result;
        snapshot.cells_len += 1;
    }
    return c.GHOSTTY_SUCCESS;
}

pub fn readRows(state: c.GhosttyRenderState, iterator: c.GhosttyRenderStateRowIterator, cells: c.GhosttyRenderStateRowCells, mask: ?[*]const u8, mask_len: u32, dirty_only: bool, snapshot: *Snapshot) callconv(.c) c.GhosttyResult {
    snapshot.rows_len = 0;
    snapshot.cells_len = 0;
    snapshot.graphemes_len = 0;
    var it = iterator;
    var row_cells = cells;
    var result = c.ghostty_render_state_get(state, c.GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, @ptrCast(&it));
    if (result != c.GHOSTTY_SUCCESS) return result;
    var y: u32 = 0;
    while (c.ghostty_render_state_row_iterator_next(it)) : (y += 1) {
        if (mask) |m| {
            if (y >= mask_len or m[y] == 0) continue;
        }
        var dirty = false;
        result = c.ghostty_render_state_row_get(it, c.GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &dirty);
        if (result != c.GHOSTTY_SUCCESS) return result;
        if (dirty_only and !dirty) continue;
        result = readRow(it, &row_cells, y, dirty, snapshot);
        if (result != c.GHOSTTY_SUCCESS) return result;
    }
    if (snapshot.graphemes_len > snapshot.graphemes_cap) return c.GHOSTTY_OUT_OF_SPACE;
    return c.GHOSTTY_SUCCESS;
}
