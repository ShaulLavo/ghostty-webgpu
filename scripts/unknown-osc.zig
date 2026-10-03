const std = @import("std");
const c = @cImport({
    @cInclude("ghostty/vt/terminal.h");
});

const host = struct {
    extern "env" fn custom_osc(terminal: c.GhosttyTerminal, userdata: ?*anyopaque, number: f64, payload: [*]const u8, length: usize, terminator: c.GhosttyOscTerminator, truncated: bool) void;
};

pub const max_number: u64 = 9007199254740991;

pub const Projection = struct {
    number: u64,
    payload: []const u8,
};

pub fn project(content: []const u8) ?Projection {
    // A safe integer has at most sixteen decimal digits; inspect only its header.
    const header = content[0..@min(content.len, 17)];
    const separator = std.mem.indexOfScalar(u8, header, ';') orelse return null;
    if (separator == 0) return null;
    if (separator > 1 and content[0] == '0') return null;
    var number: u64 = 0;
    for (content[0..separator]) |byte| {
        if (byte < '0' or byte > '9') return null;
        const digit: u64 = byte - '0';
        if (number > (max_number - digit) / 10) return null;
        number = number * 10 + digit;
    }
    return .{ .number = number, .payload = content[separator + 1 ..] };
}

pub fn callback(terminal: c.GhosttyTerminal, userdata: ?*anyopaque, sequence: *const c.GhosttyTerminalUnknownSequence) callconv(.c) void {
    if (sequence.tag != c.GHOSTTY_TERMINAL_UNKNOWN_SEQUENCE_OSC) return;
    const osc = sequence.value.osc;
    const projected = project(osc.content.ptr[0..osc.content.len]) orelse return;
    host.custom_osc(terminal, userdata, @floatFromInt(projected.number), projected.payload.ptr, projected.payload.len, osc.terminator, osc.truncated);
}

test "canonical safe-integer identifiers preserve arbitrary borrowed payload bytes" {
    const cases = [_]struct { content: []const u8, number: u64, payload: []const u8 }{
        .{ .content = "0;", .number = 0, .payload = "" },
        .{ .content = "7400;status=busy", .number = 7400, .payload = "status=busy" },
        .{ .content = "4294967296;above-u32", .number = 4294967296, .payload = "above-u32" },
        .{ .content = "9007199254740991;\xff;\x80", .number = max_number, .payload = "\xff;\x80" },
    };
    for (cases) |case| {
        const result = project(case.content) orelse return error.TestUnexpectedResult;
        try std.testing.expectEqual(case.number, result.number);
        try std.testing.expectEqualSlices(u8, case.payload, result.payload);
        try std.testing.expectEqual(@intFromPtr(case.content.ptr) + case.content.len - case.payload.len, @intFromPtr(result.payload.ptr));
    }
}

test "malformed aliases overflow and incomplete identifiers are rejected" {
    const cases = [_][]const u8{
        "",        ";payload",           "7400",                   "74",                           "77x;data", "00;x", "07400;x", "+7400;x", "-7400;x",
        "7400 ;x", "9007199254740992;x", "18446744073709551616;x", "99999999999999999999999999;x",
    };
    for (cases) |content| try std.testing.expectEqual(null, project(content));
}

test "a retained complete header projects an empty or shortened body" {
    const empty = project("7400;").?;
    try std.testing.expectEqual(@as(u64, 7400), empty.number);
    try std.testing.expectEqual(@as(usize, 0), empty.payload.len);
    const shortened = project("7400;abc").?;
    try std.testing.expectEqualSlices(u8, "abc", shortened.payload);
}
