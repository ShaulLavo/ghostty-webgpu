const std = @import("std");

pub const Entry = struct {
    id: [2]u64 = .{ 0, 0 },
    source: u32,
};

pub fn capacity(rows: u32) u32 {
    return std.math.ceilPowerOfTwo(u32, @max(2, rows * 2)) catch unreachable;
}

pub fn reset(entries: []Entry, missing: u32) void {
    for (entries) |*entry| entry.source = missing;
}

fn slot(entries: []const Entry, id: [2]u64, missing: u32) usize {
    const mask = entries.len - 1;
    var index: usize = @intCast(std.hash.Wyhash.hash(0, std.mem.asBytes(&id)) & mask);
    while (entries[index].source != missing) : (index = (index + 1) & mask) {
        if (std.mem.eql(u64, &entries[index].id, &id)) return index;
    }
    return index;
}

pub fn insert(entries: []Entry, id: [2]u64, source: u32, missing: u32) void {
    const entry = &entries[slot(entries, id, missing)];
    // Matching always chooses the first source, even when several rows share an id.
    if (entry.source != missing) return;
    entry.* = .{ .id = id, .source = source };
}

pub fn lookup(entries: []const Entry, id: [2]u64, missing: u32) u32 {
    return entries[slot(entries, id, missing)].source;
}

test "both identity words, duplicates, misses, and reset" {
    var entries: [8]Entry = undefined;
    reset(&entries, 4);
    insert(&entries, .{ 1, 2 }, 0, 4);
    insert(&entries, .{ 1, 3 }, 1, 4);
    insert(&entries, .{ 2, 2 }, 2, 4);
    insert(&entries, .{ 1, 2 }, 3, 4);
    try std.testing.expectEqual(0, lookup(&entries, .{ 1, 2 }, 4));
    try std.testing.expectEqual(0, lookup(&entries, .{ 1, 2 }, 4));
    try std.testing.expectEqual(1, lookup(&entries, .{ 1, 3 }, 4));
    try std.testing.expectEqual(2, lookup(&entries, .{ 2, 2 }, 4));
    try std.testing.expectEqual(4, lookup(&entries, .{ 0, 0 }, 4));
    reset(&entries, 4);
    try std.testing.expectEqual(4, lookup(&entries, .{ 1, 2 }, 4));
}

test "collision chains preserve the first source at tall viewport sizes" {
    var entries: [1024]Entry = undefined;
    reset(&entries, 500);
    for (0..500) |row| insert(&entries, .{ row, row * 17 }, @intCast(row), 500);
    for (0..500) |row| try std.testing.expectEqual(row, lookup(&entries, .{ row, row * 17 }, 500));
    try std.testing.expectEqual(500, lookup(&entries, .{ 999, 999 }, 500));
}
