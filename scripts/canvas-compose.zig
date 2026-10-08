const std = @import("std");
const builtin = @import("builtin");
const simd = std.Target.wasm.featureSetHas(builtin.cpu.features, .simd128);

extern var __heap_base: u8;
var heap_start: u32 = 0;
var heap_end: u32 = 0;
const Block = extern struct { bytes: u32, live: u32, reserved0: u32, reserved1: u32 };
const block_bytes = @sizeOf(Block);

fn memoryBytes() u32 {
    return @as(u32, @intCast(@wasmMemorySize(0))) * 65536;
}

fn inRange(ptr: u32, bytes: u64) bool {
    const available = memoryBytes();
    return ptr >= @intFromPtr(&__heap_base) and bytes <= available and ptr <= available - bytes;
}

fn blockAt(ptr: u32) *Block {
    return @ptrFromInt(ptr);
}

fn reuseBlock(ptr: u32, bytes: u32) u32 {
    const block = blockAt(ptr);
    if (block.live != 0 or block.bytes < bytes) return 0;
    const spare = block.bytes - bytes;
    if (spare >= block_bytes + 16) {
        blockAt(ptr + block_bytes + bytes).* = .{ .bytes = spare - block_bytes, .live = 0, .reserved0 = 0, .reserved1 = 0 };
        block.bytes = bytes;
    }
    block.live = 1;
    return ptr + block_bytes;
}

export fn compose_alloc(requested: u32) u32 {
    if (requested == 0 or requested > 268435440) return 0;
    const bytes = (requested + 15) & ~@as(u32, 15);
    if (heap_start == 0) {
        heap_start = (@as(u32, @intCast(@intFromPtr(&__heap_base))) + 15) & ~@as(u32, 15);
        heap_end = heap_start;
    }
    var ptr = heap_start;
    while (ptr < heap_end) : (ptr += block_bytes + blockAt(ptr).bytes) {
        const reused = reuseBlock(ptr, bytes);
        if (reused != 0) return reused;
    }
    const next = @as(u64, heap_end) + block_bytes + bytes;
    if (next > 268435456) return 0;
    const available = memoryBytes();
    if (next > available and @wasmMemoryGrow(0, @intCast((next - available + 65535) / 65536)) == -1) return 0;
    blockAt(heap_end).* = .{ .bytes = bytes, .live = 1, .reserved0 = 0, .reserved1 = 0 };
    const result = heap_end + block_bytes;
    heap_end = @intCast(next);
    return result;
}

fn coalesce(ptr: u32) void {
    const block = blockAt(ptr);
    var next = ptr + block_bytes + block.bytes;
    while (next < heap_end) {
        const after = blockAt(next);
        if (after.live != 0) break;
        block.bytes += block_bytes + after.bytes;
        next = ptr + block_bytes + block.bytes;
    }
}

fn freeBlock(ptr: u32, previous: u32) i32 {
    const block = blockAt(ptr);
    if (block.live == 0) return 0;
    block.live = 0;
    var combined = ptr;
    if (previous != 0 and blockAt(previous).live == 0) {
        blockAt(previous).bytes += block_bytes + block.bytes;
        combined = previous;
    }
    coalesce(combined);
    return 1;
}

export fn compose_free(offset: u32) i32 {
    var previous: u32 = 0;
    var ptr = heap_start;
    while (ptr < heap_end) : (ptr += block_bytes + blockAt(ptr).bytes) {
        if (ptr + block_bytes == offset) return freeBlock(ptr, previous);
        previous = ptr;
    }
    return 0;
}

fn validFrame(ptr: u32, width: u32, height: u32) bool {
    const pixels = @as(u64, width) * height;
    if (width == 0 or height == 0 or pixels > memoryBytes() / 4) return false;
    return inRange(ptr, pixels * 4);
}

fn validRect(width: u32, height: u32, x: u32, y: u32, w: u32, h: u32) bool {
    return x <= width and y <= height and w <= width - x and h <= height - y;
}

fn pixelAt(ptr: u32, width: u32, x: u32, y: u32) *[4]u8 {
    return @ptrFromInt(@as(usize, @intCast(ptr + (@as(u64, y) * width + x) * 4)));
}

fn readPixel(pixel: [*]const u8) u32 {
    return @as(u32, pixel[0]) | (@as(u32, pixel[1]) << 8) | (@as(u32, pixel[2]) << 16) | (@as(u32, pixel[3]) << 24);
}

fn divide255(input: u32) u32 {
    const value = input + 128;
    return (value + (value >> 8)) >> 8;
}

fn writeOpaque(destination: *[4]u8, rgba: u32) void {
    for (0..3) |c| destination[c] = @truncate(rgba >> @as(u5, @intCast(c * 8)));
    destination[3] = 255;
}

fn blendScalar(destination: *[4]u8, rgba: u32, alpha: u32, ad: u32, inverse: u32, denominator: u32) void {
    for (0..3) |c| {
        const channel = (rgba >> @as(u5, @intCast(c * 8))) & 255;
        const source = channel * alpha * 255;
        const retained = @as(u32, destination[c]) * ad * inverse;
        destination[c] = @intCast((source + retained + denominator / 2) / denominator);
    }
    destination[3] = @intCast(divide255(denominator));
}

fn blendSimd(destination: *[4]u8, rgba: u32, alpha: u32, ad: u32, inverse: u32, denominator: u32) void {
    const bytes: @Vector(16, u8) = @bitCast(@as(@Vector(4, u32), .{ rgba, readPixel(destination), 0, 0 }));
    const channels: @Vector(8, u16) = @intCast(@shuffle(u8, bytes, undefined, @as(@Vector(8, i32), .{ 0, 1, 2, 3, 4, 5, 6, 7 })));
    const a: u16 = @intCast(alpha);
    const d: u16 = @intCast(ad);
    const products = channels * @as(@Vector(8, u16), .{ a, a, a, a, d, d, d, d });
    const source: @Vector(4, u32) = @intCast(@shuffle(u16, products, undefined, @as(@Vector(4, i32), .{ 0, 1, 2, 3 })));
    const retained: @Vector(4, u32) = @intCast(@shuffle(u16, products, undefined, @as(@Vector(4, i32), .{ 4, 5, 6, 7 })));
    const numerator = source * @as(@Vector(4, u32), @splat(255)) + retained * @as(@Vector(4, u32), @splat(inverse)) + @as(@Vector(4, u32), @splat(denominator / 2));
    const normalized: @Vector(4, u32) = .{ numerator[0] / denominator, numerator[1] / denominator, numerator[2] / denominator, divide255(denominator) };
    const narrow: @Vector(4, u8) = @intCast(normalized);
    const rgba_word: u32 = @bitCast(narrow);
    for (0..4) |c| destination[c] = @truncate(rgba_word >> @as(u5, @intCast(c * 8)));
}

fn over(destination: *[4]u8, rgba: u32, alpha: u32) void {
    if (alpha == 0) return;
    if (alpha == 255) return writeOpaque(destination, rgba);
    const ad: u32 = destination[3];
    const inverse = 255 - alpha;
    const denominator = alpha * 255 + ad * inverse;
    if (comptime simd) return blendSimd(destination, rgba, alpha, ad, inverse, denominator);
    blendScalar(destination, rgba, alpha, ad, inverse, denominator);
}

fn clearRow(start: [*]u8, bytes: u32) void {
    var i: u32 = 0;
    if (comptime simd) {
        while (i + 16 <= bytes) : (i += 16) {
            const vector: *align(1) @Vector(16, u8) = @ptrCast(start + i);
            vector.* = @splat(0);
        }
    }
    while (i < bytes) : (i += 1) start[i] = 0;
}

export fn compose_clear(ptr: u32, width: u32, height: u32, x: u32, y: u32, w: u32, h: u32) i32 {
    if (!validFrame(ptr, width, height) or !validRect(width, height, x, y, w, h)) return 0;
    var row = y;
    while (row < y + h) : (row += 1) clearRow(@ptrCast(pixelAt(ptr, width, x, row)), w * 4);
    return 1;
}

export fn compose_fill(ptr: u32, width: u32, height: u32, x: u32, y: u32, w: u32, h: u32, rgba: u32, opacity: u32) i32 {
    if (!validFrame(ptr, width, height) or !validRect(width, height, x, y, w, h) or opacity > 65535) return 0;
    const alpha: u32 = @intCast((@as(u64, rgba >> 24) * opacity + 32767) / 65535);
    var row = y;
    while (row < y + h) : (row += 1) {
        var column = x;
        while (column < x + w) : (column += 1) over(pixelAt(ptr, width, column, row), rgba, alpha);
    }
    return 1;
}

fn stampAlpha(pixel: [*]const u8, rgba: u32, kind: u32, opacity: u32) u32 {
    var numerator = @as(u64, rgba >> 24) * opacity;
    var denominator: u32 = 65535;
    if (kind == 1) {
        numerator *= pixel[0];
        denominator *= 255;
    }
    return @intCast((numerator + denominator / 2) / denominator);
}

const Stamp = struct { ptr: u32, width: u32, source: u32, stride: u32, kind: u32, x: i32, y: i32, tint: u32, opacity: u32 };
fn stampRow(stamp: Stamp, row: i64, left: i64, right: i64) void {
    const bpp: u32 = if (stamp.kind == 1) 1 else 4;
    var column = left;
    while (column < right) : (column += 1) {
        const offset = (row - stamp.y) * stamp.stride + (column - stamp.x) * bpp;
        const pixel: [*]const u8 = @ptrFromInt(@as(usize, @intCast(stamp.source + @as(u64, @intCast(offset)))));
        const rgba = if (stamp.kind == 1) stamp.tint else readPixel(pixel);
        const alpha = stampAlpha(pixel, rgba, stamp.kind, stamp.opacity);
        over(pixelAt(stamp.ptr, stamp.width, @intCast(column), @intCast(row)), rgba, alpha);
    }
}

export fn compose_stamp(ptr: u32, width: u32, height: u32, source: u32, sw: u32, sh: u32, stride: u32, kind: u32, x: i32, y: i32, cx: u32, cy: u32, cw: u32, ch: u32, tint: u32, opacity: u32) i32 {
    const bpp: u32 = if (kind == 1) 1 else 4;
    const rowbytes = @as(u64, sw) * bpp;
    const bytes: u64 = if (sh != 0) @as(u64, sh - 1) * stride +% rowbytes else 0;
    if (!validFrame(ptr, width, height) or sw == 0 or sh == 0 or (kind != 1 and kind != 4) or stride < rowbytes or !inRange(source, bytes) or opacity > 65535 or !validRect(width, height, cx, cy, cw, ch)) return 0;
    if (@as(u64, source) < @as(u64, ptr) + @as(u64, width) * height * 4 and @as(u64, source) + bytes > ptr) return 0;
    const left = @max(@as(i64, x), @as(i64, cx));
    const top = @max(@as(i64, y), @as(i64, cy));
    const right = @min(@as(i64, x) + sw, @as(i64, cx) + cw);
    const bottom = @min(@as(i64, y) + sh, @as(i64, cy) + ch);
    const stamp: Stamp = .{ .ptr = ptr, .width = width, .source = source, .stride = stride, .kind = kind, .x = x, .y = y, .tint = tint, .opacity = opacity };
    var row = top;
    while (row < bottom) : (row += 1) stampRow(stamp, row, left, right);
    return 1;
}

fn moveForward(target: [*]u8, source: [*]const u8, bytes: u32) void {
    var i: u32 = 0;
    if (comptime simd) {
        while (bytes - i >= 16) : (i += 16) {
            const value: @Vector(16, u8) = @as(*align(1) const @Vector(16, u8), @ptrCast(source + i)).*;
            @as(*align(1) @Vector(16, u8), @ptrCast(target + i)).* = value;
        }
    }
    while (i < bytes) : (i += 1) target[i] = source[i];
}

fn moveBackward(target: [*]u8, source: [*]const u8, bytes: u32) void {
    var i = bytes;
    if (comptime simd) {
        while (i >= 16) {
            i -= 16;
            const value: @Vector(16, u8) = @as(*align(1) const @Vector(16, u8), @ptrCast(source + i)).*;
            @as(*align(1) @Vector(16, u8), @ptrCast(target + i)).* = value;
        }
    }
    while (i > 0) {
        i -= 1;
        target[i] = source[i];
    }
}

export fn compose_move(ptr: u32, width: u32, height: u32, source_y: u32, target_y: u32, rows: u32) i32 {
    if (!validFrame(ptr, width, height) or source_y > height or target_y > height or rows > height - source_y or rows > height - target_y) return 0;
    const bytes = rows * width * 4;
    const source: [*]const u8 = @ptrFromInt(ptr + source_y * width * 4);
    const target: [*]u8 = @ptrFromInt(ptr + target_y * width * 4);
    if (@intFromPtr(target) < @intFromPtr(source)) moveForward(target, source, bytes);
    if (@intFromPtr(target) > @intFromPtr(source)) moveBackward(target, source, bytes);
    return 1;
}
