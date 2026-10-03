const std = @import("std");
const c = @cImport({
    @cInclude("ghostty/vt/terminal.h");
    @cInclude("ghostty/vt/grid_ref_tracked.h");
    @cInclude("ghostty/vt/formatter.h");
});
const equal = std.testing.expectEqual;

fn write(t: c.GhosttyTerminal, bytes: []const u8) void {
    c.ghostty_terminal_vt_write(t, bytes.ptr, bytes.len);
}

fn cursor(t: c.GhosttyTerminal, x: u16, y: u16, wrap: bool) !void {
    var actual_x: u16 = undefined;
    var actual_y: u16 = undefined;
    var actual_wrap: bool = undefined;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_get(t, c.GHOSTTY_TERMINAL_DATA_CURSOR_X, &actual_x));
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_get(t, c.GHOSTTY_TERMINAL_DATA_CURSOR_Y, &actual_y));
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_get(t, c.GHOSTTY_TERMINAL_DATA_CURSOR_PENDING_WRAP, &actual_wrap));
    try equal(x, actual_x);
    try equal(y, actual_y);
    try equal(wrap, actual_wrap);
}

fn point(x: u16, y: u32) c.GhosttyPoint {
    return .{ .tag = c.GHOSTTY_POINT_TAG_ACTIVE, .value = .{ .coordinate = .{ .x = x, .y = y } } };
}

fn style(t: c.GhosttyTerminal, x: u16, y: u32) !c.GhosttyStyle {
    var ref: c.GhosttyGridRef = .{ .size = @sizeOf(c.GhosttyGridRef) };
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_grid_ref(t, point(x, y), &ref));
    var value: c.GhosttyStyle = .{ .size = @sizeOf(c.GhosttyStyle) };
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_grid_ref_style(&ref, &value));
    return value;
}

test "official C handle tracked ref follows bottom scroll unlike DECSC" {
    var t: c.GhosttyTerminal = null;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_new(null, &t, 6, 3));
    defer c.ghostty_terminal_free(t);
    write(t, "\x1b[3;1H> abcd\x1b7");
    var ref: c.GhosttyTrackedGridRef = null;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_grid_ref_track(t, point(5, 2), &ref));
    defer c.ghostty_tracked_grid_ref_free(ref);
    write(t, "efghij");
    var coordinate: c.GhosttyPointCoordinate = undefined;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_tracked_grid_ref_point(ref, c.GHOSTTY_POINT_TAG_ACTIVE, &coordinate));
    try equal(@as(u32, 1), coordinate.y);
    write(t, "\x1b8");
    try cursor(t, 5, 2, true);
    write(t, "\x1b[2;6H");
    try cursor(t, 5, 1, false);
}

test "official C handle CUP and last-unit replay recover pending wrap" {
    var t: c.GhosttyTerminal = null;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_new(null, &t, 4, 3));
    defer c.ghostty_terminal_free(t);
    write(t, "abcd");
    try cursor(t, 3, 0, true);
    write(t, "\x1b[1;4H");
    try cursor(t, 3, 0, false);
    write(t, "d");
    try cursor(t, 3, 0, true);
}

test "official C handle replay of native grapheme changes a colored prompt cell" {
    var t: c.GhosttyTerminal = null;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_new(null, &t, 4, 3));
    defer c.ghostty_terminal_free(t);
    write(t, "\x1b[31mabcd\x1b[0m");
    const before = try style(t, 3, 0);
    try equal(@as(c.GhosttyStyleColorTag, c.GHOSTTY_STYLE_COLOR_PALETTE), before.fg_color.tag);
    var ref: c.GhosttyGridRef = .{ .size = @sizeOf(c.GhosttyGridRef) };
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_grid_ref(t, point(3, 0), &ref));
    var grapheme: [4]u32 = undefined;
    var length: usize = undefined;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_grid_ref_graphemes(&ref, &grapheme, grapheme.len, &length));
    try equal(@as(usize, 1), length);
    var encoded: [4]u8 = undefined;
    const encoded_length = try std.unicode.utf8Encode(@intCast(grapheme[0]), &encoded);
    write(t, "\x1b[1;4H");
    write(t, encoded[0..encoded_length]);
    try cursor(t, 3, 0, true);
    const after = try style(t, 3, 0);
    try equal(@as(c.GhosttyStyleColorTag, c.GHOSTTY_STYLE_COLOR_NONE), after.fg_color.tag);
}

test "official native VT formatter restores colored pending-wrap caret after bottom scroll" {
    var t: c.GhosttyTerminal = null;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_new(null, &t, 4, 3));
    defer c.ghostty_terminal_free(t);
    write(t, "\x1b[3;1H\x1b[31mabcd\x1b[0m");
    const before = try style(t, 3, 2);
    var tracked: c.GhosttyTrackedGridRef = null;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_grid_ref_track(t, point(3, 2), &tracked));
    defer c.ghostty_tracked_grid_ref_free(tracked);
    var ref: c.GhosttyGridRef = .{ .size = @sizeOf(c.GhosttyGridRef) };
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_grid_ref(t, point(3, 2), &ref));
    const selection: c.GhosttySelection = .{ .size = @sizeOf(c.GhosttySelection), .start = ref, .end = ref, .rectangle = false };
    var formatter: c.GhosttyFormatter = null;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_formatter_terminal_new(null, &formatter, t, .{
        .size = @sizeOf(c.GhosttyFormatterTerminalOptions),
        .emit = c.GHOSTTY_FORMATTER_FORMAT_VT,
        .unwrap = true,
        .trim = false,
        .selection = &selection,
        .extra = .{
            .size = @sizeOf(c.GhosttyFormatterTerminalExtra),
            .screen = .{ .size = @sizeOf(c.GhosttyFormatterScreenExtra), .style = true, .hyperlink = true, .protection = true, .charsets = true },
        },
    }));
    defer c.ghostty_formatter_free(formatter);
    var bytes: [1024]u8 = undefined;
    var length: usize = undefined;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_formatter_format_buf(formatter, &bytes, bytes.len, &length));
    write(t, "efg");
    var coordinate: c.GhosttyPointCoordinate = undefined;
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_tracked_grid_ref_point(tracked, c.GHOSTTY_POINT_TAG_ACTIVE, &coordinate));
    try equal(@as(u32, 1), coordinate.y);
    var cup: [32]u8 = undefined;
    write(t, try std.fmt.bufPrint(&cup, "\x1b[{d};{d}H", .{ coordinate.y + 1, coordinate.x + 1 }));
    write(t, bytes[0..length]);
    try cursor(t, 3, 1, true);
    const after = try style(t, 3, 1);
    try equal(before.fg_color.tag, after.fg_color.tag);
    try equal(before.fg_color.value.palette, after.fg_color.value.palette);
    write(t, "x");
    try cursor(t, 1, 2, false);
    var next_ref: c.GhosttyGridRef = .{ .size = @sizeOf(c.GhosttyGridRef) };
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_terminal_grid_ref(t, point(0, 2), &next_ref));
    var next_style: c.GhosttyStyle = .{ .size = @sizeOf(c.GhosttyStyle) };
    try equal(c.GHOSTTY_SUCCESS, c.ghostty_grid_ref_style(&next_ref, &next_style));
    try equal(@as(c.GhosttyStyleColorTag, c.GHOSTTY_STYLE_COLOR_NONE), next_style.fg_color.tag);
}
