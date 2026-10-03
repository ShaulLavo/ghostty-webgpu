const std = @import("std");
const vt = @import("ghostty-vt");
const native = @import("paint.zig");
const expect = std.testing.expect;
const equal = std.testing.expectEqual;
const alloc = std.testing.allocator;

test {
    _ = @import("c-controls.zig");
}

fn terminal(cols: u16, rows: u16) !vt.Terminal {
    return vt.Terminal.init(std.testing.io, alloc, .{ .cols = cols, .rows = rows });
}

fn cursor(t: *vt.Terminal, x: u16, y: u16, pending: bool) !void {
    try equal(x, t.screens.active.cursor.x);
    try equal(y, t.screens.active.cursor.y);
    try equal(pending, t.screens.active.cursor.pending_wrap);
}

fn text(t: *vt.Terminal, expected: []const u8) !void {
    const actual = try t.plainString(alloc);
    defer alloc.free(actual);
    try std.testing.expectEqualStrings(expected, actual);
}

test "native ASCII known-good paint and tail replacement" {
    var t = try terminal(8, 4);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    var region = try native.Region.init(&t);
    defer region.deinit();
    const result = try region.paint(&stream, "$ ab", "cd");
    try cursor(&t, 4, 0, false);
    try equal(@as(u16, 6), result.end.coordinate.x);
    try text(&t, "$ abcd");
    _ = try region.paint(&stream, "$ a", "");
    try text(&t, "$ a");
    try cursor(&t, 3, 0, false);
}

test "native CJK combining and ZWJ follow the live 2027 mode" {
    for ([_]bool{ false, true }) |enabled| {
        for ([_][]const u8{ "界", "e\xcc\x81", "👩‍👩‍👧‍👦" }) |sample| {
            var t = try terminal(24, 4);
            defer t.deinit(alloc);
            var stream = t.vtStream();
            defer stream.deinit();
            var reference = try terminal(24, 4);
            defer reference.deinit(alloc);
            var reference_stream = reference.vtStream();
            defer reference_stream.deinit();
            const mode = if (enabled) "\x1b[?2027h" else "\x1b[?2027l";
            stream.nextSlice(mode);
            reference_stream.nextSlice(mode);
            reference_stream.nextSlice(sample);
            const expected = reference.screens.active.cursor;
            reference_stream.nextSlice("z");
            var region = try native.Region.init(&t);
            defer region.deinit();
            _ = try region.paint(&stream, sample, "z");
            try cursor(&t, expected.x, expected.y, expected.pending_wrap);
            const rendered = try reference.plainString(alloc);
            defer alloc.free(rendered);
            try text(&t, rendered);
        }
    }
}

test "wide glyph at the right edge uses native spacer and wrap" {
    var t = try terminal(4, 4);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    var region = try native.Region.init(&t);
    defer region.deinit();
    const result = try region.paint(&stream, "abc界", "z");
    try cursor(&t, 2, 1, false);
    try equal(@as(u32, 1), result.end.coordinate.y);
    try text(&t, "abc\n界z");
}

test "colored wrapped prompt and CRLF secondary prompt repaint" {
    var t = try terminal(6, 5);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    var region = try native.Region.init(&t);
    defer region.deinit();
    _ = try region.paint(&stream, "\x1b[31m> \x1b[0mab\r\n\x1b[32m..\x1b[0m 界", "cd");
    try cursor(&t, 5, 1, false);
    try text(&t, "> ab\n.. 界c\nd");
    _ = try region.paint(&stream, "\x1b[31m> \x1b[0mx", "");
    try text(&t, "> x");
}

test "bottom-scroll keeps origin and pending-wrap caret pinned" {
    var t = try terminal(6, 3);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("0\r\n1\r\n");
    var region = try native.Region.init(&t);
    defer region.deinit();
    const result = try region.paint(&stream, "\x1b[31m> \x1b[0mabcd", "efghij");
    try cursor(&t, 5, 1, true);
    try equal(@as(u32, 1), result.origin.?.y);
    try equal(@as(u32, 2), result.end.coordinate.y);
    try equal(@as(u32, 2), region.originPosition(.screen).?.y);
    _ = try region.paint(&stream, "> x", "");
    try text(&t, "1\n> x");
}

test "native DECSC negative control restores a stale row after scrolling" {
    var t = try terminal(6, 3);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("\x1b[3;1H> abcd\x1b7efghij\x1b8");
    try cursor(&t, 5, 2, true);
    try expect(t.screens.active.cursor.y != 1);
}

test "native CUP negative control clears pending wrap" {
    var t = try terminal(4, 3);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("abcd");
    try cursor(&t, 3, 0, true);
    stream.nextSlice("\x1b[1;4H");
    try cursor(&t, 3, 0, false);
}

test "native VT replay restores pending wrap but changes colored cells" {
    var t = try terminal(4, 3);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("\x1b[31mabcd\x1b[0m");
    const before_style = t.screens.active.cursor.page_cell.style_id;
    try expect(before_style != 0);
    stream.nextSlice("\x1b[1;4Hd");
    try cursor(&t, 3, 0, true);
    try equal(@as(u16, 0), t.screens.active.cursor.page_cell.style_id);
}

test "origin pin follows native resize reflow before repaint" {
    var t = try terminal(6, 6);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("abcdefg");
    var region = try native.Region.init(&t);
    defer region.deinit();
    _ = try region.paint(&stream, "> 界", "abc");
    try t.resize(alloc, .{ .cols = 4, .rows = 6 });
    const origin = region.originPosition(.active).?;
    try equal(@as(u16, 3), origin.x);
    try equal(@as(u32, 1), origin.y);
    _ = try region.paint(&stream, "> x", "");
    try cursor(&t, 2, 2, false);
    try text(&t, "abcd\nefg>\n x");
}

test "off-active origin and caret are explicit native limitations" {
    var t = try terminal(4, 2);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    var region = try native.Region.init(&t);
    defer region.deinit();
    try std.testing.expectError(error.OutsideActive, region.paint(&stream, "a", "bcdefghijkl"));
    try expect(region.originPosition(.active) == null);
    try expect(region.originPosition(.history) != null);
    try std.testing.expectError(error.OutsideActive, region.paint(&stream, "x", ""));
}

test "removed screen generation invalidates a pin without dereferencing it" {
    var t = try terminal(6, 4);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("\x1b[?1049h");
    var region = try native.Region.init(&t);
    defer region.deinit();
    stream.nextSlice("\x1b[?1049l");
    t.screens.remove(alloc, .alternate);
    stream.nextSlice("\x1b[?1049h");
    try expect(region.originPosition(.active) == null);
    try std.testing.expectError(error.OutsideActive, region.paint(&stream, "x", ""));
}

test "reentrant native bell observer cannot paint during a paint batch" {
    const Observer = struct {
        var region: *native.Region = undefined;
        var stream: *vt.TerminalStream = undefined;
        var rejected = false;

        fn bell(_: *vt.TerminalStream.Handler) void {
            _ = region.paint(stream, "wrong", "") catch |err| {
                rejected = err == error.ReentrantPaint;
                return;
            };
        }
    };
    var t = try terminal(6, 4);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    var region = try native.Region.init(&t);
    defer region.deinit();
    Observer.region = &region;
    Observer.stream = &stream;
    Observer.rejected = false;
    stream.handler.effects.bell = Observer.bell;
    _ = try region.paint(&stream, "> \x07a", "b");
    try expect(Observer.rejected);
    try cursor(&t, 3, 0, false);
    try text(&t, "> ab");
}

test "reset invalidates origin and pending-wrap ownership is rejected" {
    var t = try terminal(4, 3);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    stream.nextSlice("abcd");
    try std.testing.expectError(error.OriginPendingWrap, native.Region.init(&t));
    stream.nextSlice("\r\n");
    var region = try native.Region.init(&t);
    defer region.deinit();
    stream.nextSlice("\x1bc");
    try expect(region.originPosition(.active) == null);
    try std.testing.expectError(error.OutsideActive, region.paint(&stream, "x", ""));
}

test "screen switch during prefix is rejected before caret capture" {
    var t = try terminal(4, 3);
    defer t.deinit(alloc);
    var stream = t.vtStream();
    defer stream.deinit();
    var region = try native.Region.init(&t);
    defer region.deinit();
    try std.testing.expectError(error.ScreenChanged, region.paint(&stream, "\x1b[?1049h", ""));
}
