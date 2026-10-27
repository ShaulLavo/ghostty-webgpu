const std = @import("std");
const index = @import("row-index.zig");

fn collision(entries: []const index.Entry, fixed: u64, vary_first: bool, start: u64) [2]u64 {
    var word = start;
    while (true) : (word += 1) {
        const id = if (vary_first) [2]u64{ word, fixed } else [2]u64{ fixed, word };
        const bucket = std.hash.Wyhash.hash(0, std.mem.asBytes(&id)) & (entries.len - 1);
        if (bucket == entries.len - 1) return id;
    }
}

test "deliberate collisions wrap and compare both identity words" {
    var entries: [16]index.Entry = undefined;
    for ([_]bool{ false, true }) |vary_first| {
        index.reset(&entries, 8);
        const ids = collidingIds(&entries, vary_first);
        for (ids, 0..) |id, source| index.insert(&entries, id, @intCast(source), 8);
        for (ids, 0..) |id, source| try std.testing.expectEqual(source, index.lookup(&entries, id, 8));
        const word: usize = if (vary_first) 0 else 1;
        const missing = collision(&entries, 7, vary_first, ids[7][word] + 1);
        try std.testing.expectEqual(8, index.lookup(&entries, missing, 8));
    }
}

fn collidingIds(entries: []const index.Entry, vary_first: bool) [8][2]u64 {
    var ids: [8][2]u64 = undefined;
    var start: u64 = 0;
    for (&ids) |*id| {
        id.* = collision(entries, 7, vary_first, start);
        const word: usize = if (vary_first) 0 else 1;
        start = id.*[word] + 1;
    }
    return ids;
}

test "two current rows select the same first previous source" {
    var entries = [_]index.Entry{.{ .source = 16 }} ** 32;
    index.reset(&entries, 16);
    const id = [2]u64{ 11, 19 };
    index.insert(&entries, id, 4, 16);
    index.insert(&entries, id, 9, 16);
    const current = [2][2]u64{ id, id };
    var sources: [2]u32 = undefined;
    for (current, 0..) |incoming, row| sources[row] = index.lookup(&entries, incoming, 16);
    try std.testing.expectEqual([2]u32{ 4, 4 }, sources);
    index.reset(&entries, 16);
    try std.testing.expectEqual(16, index.lookup(&entries, id, 16));
    index.insert(&entries, id, 12, 16);
    try std.testing.expectEqual(12, index.lookup(&entries, id, 16));
}
