const std = @import("std");

extern "env" fn ghostty_wasm_alloc(len: usize) ?[*]u8;
extern "env" fn ghostty_wasm_free(ptr: ?[*]u8, len: usize) void;

pub const Glyph = extern struct {
    offset_x: f32,
    offset_y: f32,
    width: f32,
    height: f32,
    u0: f32,
    v0: f32,
    u1: f32,
    v1: f32,
    layer: f32,
    generation: f32,
    kind: f32,
    valid: f32,
};

// Text is owned by the index; keys remain stable until clear or disposal.
pub const Key = extern struct {
    text: [*]const u32,
    text_len: u32,
    span: u32,
    style: u32,
    foreground: u32,
    background: u32,
    minimum_contrast: f64,
};
pub const Entry = extern struct { key: Key, glyph: Glyph, queued_generation: u32, variant: u32 };
pub const Index = extern struct {
    entries: [*]?*Entry,
    capacity: u32,
    count: u32,
    scratch: ?[*]u32,
    scratch_cap: u32,
    build_generation: u32,
    rebuild_all: u32,
};

fn allocate(comptime T: type, count: usize) ?[*]T {
    const bytes = ghostty_wasm_alloc(count * @sizeOf(T)) orelse return null;
    return @ptrCast(@alignCast(bytes));
}

pub fn create() ?*Index {
    const memory = allocate(Index, 1) orelse return null;
    const index = &memory[0];
    const entries = allocate(?*Entry, 256) orelse {
        ghostty_wasm_free(@ptrCast(memory), @sizeOf(Index));
        return null;
    };
    @memset(entries[0..256], null);
    index.* = .{ .entries = entries, .capacity = 256, .count = 0, .scratch = null, .scratch_cap = 0, .build_generation = 0, .rebuild_all = 0 };
    return index;
}

pub fn beginBuild(index: *Index) void {
    index.build_generation +%= 1;
    if (index.build_generation != 0) return;
    for (index.entries[0..index.capacity]) |entry| {
        const value = entry orelse continue;
        value.queued_generation = 0;
    }
    index.build_generation = 1;
}

pub fn clear(index: *Index) void {
    for (index.entries[0..index.capacity]) |entry| {
        const value = entry orelse continue;
        ghostty_wasm_free(@ptrCast(value), @sizeOf(Entry) + value.key.text_len * 4);
    }
    @memset(index.entries[0..index.capacity], null);
    index.count = 0;
    index.rebuild_all = 1;
}

pub fn destroy(index: *Index) void {
    clear(index);
    ghostty_wasm_free(@ptrCast(index.entries), index.capacity * @sizeOf(?*Entry));
    ghostty_wasm_free(@ptrCast(index.scratch), index.scratch_cap * 4);
    ghostty_wasm_free(@ptrCast(index), @sizeOf(Index));
}

pub fn scratch(index: *Index, length: u32) ?[]u32 {
    if (length == 0) return &.{};
    if (length <= index.scratch_cap) return index.scratch.?[0..length];
    const capacity = @max(length, index.scratch_cap * 2);
    const memory = allocate(u32, capacity) orelse return null;
    ghostty_wasm_free(@ptrCast(index.scratch), index.scratch_cap * 4);
    index.scratch = memory;
    index.scratch_cap = capacity;
    return memory[0..length];
}

fn hash(key: Key, variant: bool) u32 {
    var value: u32 = 2166136261;
    for ([_]u32{ key.span, key.style }) |word| value = (value ^ word) *% 16777619;
    for (key.text[0..key.text_len]) |word| value = (value ^ word) *% 16777619;
    if (!variant) return value;
    const contrast: u64 = @bitCast(key.minimum_contrast);
    for ([_]u32{ key.foreground, key.background, @truncate(contrast), @truncate(contrast >> 32) }) |word| {
        value = (value ^ word) *% 16777619;
    }
    return value;
}

fn sameShape(first: Key, second: Key) bool {
    return first.span == second.span and first.style == second.style and
        std.mem.eql(u32, first.text[0..first.text_len], second.text[0..second.text_len]);
}

fn sameBrush(first: Key, second: Key) bool {
    return first.foreground == second.foreground and first.background == second.background and
        first.minimum_contrast == second.minimum_contrast;
}

fn slot(index: *Index, key: Key, variant: bool) u32 {
    var position = hash(key, variant) & (index.capacity - 1);
    while (index.entries[position]) |entry| {
        if ((entry.variant != 0) == variant and sameShape(entry.key, key) and
            (!variant or sameBrush(entry.key, key))) return position;
        position = (position + 1) & (index.capacity - 1);
    }
    return position;
}

fn grow(index: *Index) bool {
    const capacity = index.capacity * 2;
    const entries = allocate(?*Entry, capacity) orelse return false;
    @memset(entries[0..capacity], null);
    const previous = index.entries;
    const previous_capacity = index.capacity;
    index.entries = entries;
    index.capacity = capacity;
    for (previous[0..previous_capacity]) |entry| {
        const value = entry orelse continue;
        entries[slot(index, value.key, value.variant != 0)] = value;
    }
    ghostty_wasm_free(@ptrCast(previous), previous_capacity * @sizeOf(?*Entry));
    return true;
}

pub fn resolve(index: *Index, key: Key) ?*Entry {
    var variant = false;
    var position = slot(index, key, false);
    if (index.entries[position]) |entry| {
        // Preserve cold brush order; registered grayscale and empty glyphs share their shape.
        if ((entry.glyph.valid != 0 and entry.glyph.kind == 0) or sameBrush(entry.key, key)) return entry;
        variant = true;
        position = slot(index, key, true);
        if (index.entries[position]) |cached| return cached;
    }
    if (index.count * 2 >= index.capacity) {
        if (!grow(index)) return null;
        position = slot(index, key, variant);
    }
    const bytes = ghostty_wasm_alloc(@sizeOf(Entry) + key.text_len * 4) orelse return null;
    const entry: *Entry = @ptrCast(@alignCast(bytes));
    const text: [*]u32 = @ptrCast(@alignCast(bytes + @sizeOf(Entry)));
    @memcpy(text[0..key.text_len], key.text[0..key.text_len]);
    entry.key = key;
    entry.key.text = text;
    entry.glyph = std.mem.zeroes(Glyph);
    entry.queued_generation = 0;
    entry.variant = @intFromBool(variant);
    index.entries[position] = entry;
    index.count += 1;
    return entry;
}
