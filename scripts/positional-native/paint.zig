const vt = @import("ghostty-vt");

const Anchor = struct {
    terminal: *vt.Terminal,
    screen: vt.ScreenSet.Key,
    generation: usize,
    pin: *vt.Pin,
    pending_wrap: bool,

    fn capture(terminal: *vt.Terminal) !Anchor {
        const screen = terminal.screens.active;
        return .{
            .terminal = terminal,
            .screen = terminal.screens.active_key,
            .generation = terminal.screens.generation(terminal.screens.active_key),
            .pin = try screen.pages.trackPin(screen.cursor.page_pin.*),
            .pending_wrap = screen.cursor.pending_wrap,
        };
    }

    fn pageList(self: *const Anchor) ?*vt.PageList {
        if (self.terminal.screens.generation(self.screen) != self.generation) return null;
        const screen = self.terminal.screens.get(self.screen) orelse return null;
        return &screen.pages;
    }

    fn deinit(self: *Anchor) void {
        if (self.pageList()) |list| list.untrackPin(self.pin);
    }

    fn position(self: *const Anchor, tag: vt.point.Tag) ?vt.Coordinate {
        const list = self.pageList() orelse return null;
        if (self.pin.garbage) return null;
        const point = list.pointFromPin(tag, self.pin.*) orelse return null;
        return point.coord();
    }

    fn restore(self: *const Anchor) !void {
        if (self.terminal.screens.active_key != self.screen) return error.ScreenChanged;
        const point = self.position(.active) orelse return error.OutsideActive;
        const screen = self.terminal.screens.active;
        // Match Screen.resize's saved-cursor insertion position after reflow.
        const pending = self.pending_wrap and point.x == self.terminal.cols - 1;
        const x = point.x + @as(u16, @intFromBool(self.pending_wrap and !pending));
        screen.cursorAbsolute(x, @intCast(point.y));
        screen.cursor.pending_wrap = pending;
    }
};

pub const Position = struct {
    coordinate: vt.Coordinate,
    pending_wrap: bool,
};

pub const Painted = struct {
    origin: ?vt.Coordinate,
    caret: Position,
    end: Position,
};

// The owner reserves the active display from this origin onward and frees the
// region before its terminal. This leaf has no C-handle or public JS binding.
pub const Region = struct {
    origin: Anchor,
    painting: bool = false,

    pub fn init(terminal: *vt.Terminal) !Region {
        if (terminal.screens.active.cursor.pending_wrap) return error.OriginPendingWrap;
        return .{ .origin = try Anchor.capture(terminal) };
    }

    pub fn deinit(self: *Region) void {
        self.origin.deinit();
    }

    pub fn originPosition(self: *const Region, tag: vt.point.Tag) ?vt.Coordinate {
        return self.origin.position(tag);
    }

    // Pass the authoritative stream and two VT slices split at a native printing
    // boundary. Prompt escapes and CRLF/secondary prompts stay in that stream.
    pub fn paint(self: *Region, stream: *vt.TerminalStream, before: []const u8, after: []const u8) !Painted {
        if (self.painting) return error.ReentrantPaint;
        if (stream.handler.terminal != self.origin.terminal) return error.TerminalMismatch;
        self.painting = true;
        defer self.painting = false;

        try self.origin.restore();
        const terminal = self.origin.terminal;
        terminal.eraseDisplay(.below, false);
        stream.nextSlice(before);
        if (stream.handler.semantic_failure) return error.NativeProcessing;
        if (self.origin.pageList() == null or terminal.screens.active_key != self.origin.screen) return error.ScreenChanged;
        var caret = try Anchor.capture(terminal);
        defer caret.deinit();
        stream.nextSlice(after);
        if (stream.handler.semantic_failure) return error.NativeProcessing;
        const end: Position = .{
            .coordinate = .{ .x = terminal.screens.active.cursor.x, .y = terminal.screens.active.cursor.y },
            .pending_wrap = terminal.screens.active.cursor.pending_wrap,
        };
        try caret.restore();
        return .{
            .origin = self.origin.position(.active),
            .caret = .{
                .coordinate = .{ .x = terminal.screens.active.cursor.x, .y = terminal.screens.active.cursor.y },
                .pending_wrap = terminal.screens.active.cursor.pending_wrap,
            },
            .end = end,
        };
    }
};
