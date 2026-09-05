const std = @import("std");
const builtin = @import("builtin");
const Config = @import("src/config/Config.zig");
const file_load = @import("src/config/file_load.zig");
const global = @import("src/global.zig");
const terminal_color = @import("src/terminal/color.zig");

const upstream_revision = "c8554f28e0efe2f5595f32020371c34b25ec628f";
const macos_app_support_suffix = "Library/Application Support/com.mitchellh.ghostty";
const exit_not_configured: u8 = 20;
const exit_resolver_error: u8 = 21;
const maximum_payload_bytes = 128 * 1024;
const canonical_protocol_golden = @embedFile("native-protocol-golden.json");
const canonical_protocol_golden_sha256 = "5b9997766094f19fe871435458d2df4a2003f894cc0fd49f9620d0225b3a2629";

comptime {
    if (canonical_protocol_golden.len != 13_705) @compileError("native protocol golden length changed");
    if (canonical_protocol_golden[canonical_protocol_golden.len - 1] != '\n') {
        @compileError("native protocol golden lacks its canonical LF");
    }
    if (canonical_protocol_golden_sha256.len != 64) {
        @compileError("native protocol golden digest is malformed");
    }
}

pub const std_options: std.Options = .{
    .log_level = .err,
    .logFn = discardLog,
};

const LoadResult = enum {
    loaded,
    not_configured,
    resolver_error,
};

const CandidateSet = struct {
    paths: [4]?[]const u8 = .{ null, null, null, null },
    len: usize = 0,

    fn append(self: *CandidateSet, path: []const u8) void {
        self.paths[self.len] = path;
        self.len += 1;
    }

    fn deinit(self: *CandidateSet, alloc: std.mem.Allocator) void {
        for (self.paths[0..self.len]) |path| alloc.free(path.?);
    }
};

pub fn main(minimal: std.process.Init.Minimal) void {
    if (minimal.args.vector.len != 1) std.process.exit(exit_resolver_error);
    global.init(.{ .tool = minimal }) catch std.process.exit(exit_resolver_error);
    defer global.deinit();

    mainInitialized() catch std.process.exit(exit_resolver_error);
}

fn mainInitialized() !void {
    const alloc = global.alloc();
    var config = try Config.default(alloc);
    defer config.deinit();

    const load_result = try loadReadOnlyDefaults(&config, alloc);
    if (load_result == .not_configured) std.process.exit(exit_not_configured);
    if (load_result == .resolver_error) std.process.exit(exit_resolver_error);

    try config.loadRecursiveFiles(alloc);
    try config.finalize();

    var dark = (try config.changeConditionalState(.{ .theme = .dark })) orelse
        try config.clone(alloc);
    defer dark.deinit();

    try writeReady(&config, &dark);
}

fn loadReadOnlyDefaults(config: *Config, alloc: std.mem.Allocator) !LoadResult {
    var candidates = try discoverCandidates(alloc);
    defer candidates.deinit(alloc);

    if (try racePauseEnabled()) try pauseForRace();

    var loaded = false;
    for (candidates.paths[0..candidates.len]) |candidate| {
        const action = config.loadOptionalFile(alloc, candidate.?);
        if (action == .@"error") return .resolver_error;
        if (action == .loaded) loaded = true;
    }

    if (!loaded) return .not_configured;
    return .loaded;
}

fn discoverCandidates(alloc: std.mem.Allocator) !CandidateSet {
    var result: CandidateSet = .{};
    errdefer result.deinit(alloc);

    result.append(try file_load.legacyDefaultXdgPath(alloc));
    result.append(try file_load.defaultXdgPath(alloc));
    if (comptime builtin.os.tag != .macos) return result;

    try appendReadOnlyMacosCandidates(&result, alloc);
    return result;
}

fn appendReadOnlyMacosCandidates(result: *CandidateSet, alloc: std.mem.Allocator) !void {
    var environ = try global.environMap();
    defer environ.deinit();

    const home = environ.get("HOME") orelse return error.HomeUnavailable;
    const base = try std.fs.path.join(alloc, &.{ home, macos_app_support_suffix });
    defer alloc.free(base);

    result.append(try std.fs.path.join(alloc, &.{ base, "config" }));
    result.append(try std.fs.path.join(alloc, &.{ base, "config.ghostty" }));
}

fn racePauseEnabled() !bool {
    var environ = try global.environMap();
    defer environ.deinit();
    const value = environ.get("GHOSTTY_CONFIG_RESOLVER_TEST_RACE") orelse return false;
    return std.mem.eql(u8, value, "1");
}

fn pauseForRace() !void {
    if (builtin.os.tag == .windows) return error.UnsupportedRaceProof;

    const ready_file: std.Io.File = .{
        .handle = 3,
        .flags = .{ .nonblocking = false },
    };
    var ready_buffer: [1]u8 = undefined;
    var ready_writer = ready_file.writerStreaming(global.io(), &ready_buffer);
    try ready_writer.interface.writeByte('1');
    try ready_writer.interface.flush();

    const continue_file: std.Io.File = .{
        .handle = 4,
        .flags = .{ .nonblocking = false },
    };
    var continue_buffer: [1]u8 = undefined;
    var continue_reader = continue_file.readerStreaming(global.io(), &continue_buffer);
    if (try continue_reader.interface.takeByte() != '1') return error.InvalidRaceSignal;
}

fn writeReady(light: *const Config, dark: *const Config) !void {
    var buffer: [maximum_payload_bytes]u8 = undefined;
    var fixed_writer: std.Io.Writer = .fixed(&buffer);
    const writer = &fixed_writer;
    const diagnostic_count = @min(
        @max(light._diagnostics.items().len, dark._diagnostics.items().len),
        65_535,
    );

    try writer.print(
        "{{\"diagnosticCount\":{d},\"nativeSchemaVersion\":1,\"profiles\":{{\"dark\":",
        .{diagnostic_count},
    );
    try writeProfile(writer, dark);
    try writer.writeAll(",\"light\":");
    try writeProfile(writer, light);
    try writer.print("}},\"upstreamRevision\":\"{s}\"}}\n", .{upstream_revision});
    const payload = writer.buffered();
    const written = std.c.write(1, payload.ptr, payload.len);
    if (written != @as(isize, @intCast(payload.len))) return error.StdoutWriteFailed;
}

fn writeProfile(writer: *std.Io.Writer, config: *const Config) !void {
    try writer.writeAll("{\"background\":");
    try writeRgb(writer, config.background);
    try writer.writeAll(",\"cursorColor\":");
    try writeColor(writer, config.@"cursor-color");
    try writer.writeAll(",\"cursorText\":");
    try writeColor(writer, config.@"cursor-text");
    try writer.writeAll(",\"foreground\":");
    try writeRgb(writer, config.foreground);
    try writer.writeAll(",\"minimumContrast\":");
    try writeCanonicalBoundedFloat(writer, config.@"minimum-contrast");
    try writer.writeAll(",\"palette\":[");
    try writePalette(writer, config);
    try writer.writeAll("],\"selectionBackground\":");
    try writeColor(writer, config.@"selection-background");
    try writer.writeAll(",\"selectionForeground\":");
    try writeColor(writer, config.@"selection-foreground");
    try writer.writeAll(",\"surface\":{\"backgroundBlur\":");
    try writeBackgroundBlur(writer, config.@"background-blur");
    try writer.writeAll(",\"backgroundOpacity\":");
    try writeCanonicalBoundedFloat(writer, config.@"background-opacity");
    try writer.writeAll(",\"backgroundOpacityCells\":");
    try writer.writeAll(if (config.@"background-opacity-cells") "true" else "false");
    try writer.writeAll("},\"windowColorspace\":\"");
    try writer.writeAll(switch (config.@"window-colorspace") {
        .srgb => "srgb",
        .@"display-p3" => "display-p3",
    });
    try writer.writeAll("\"}");
}

fn writeCanonicalBoundedFloat(writer: *std.Io.Writer, value: f64) !void {
    if (!std.math.isFinite(value)) return error.NonFiniteProtocolNumber;
    if (value == 0) {
        try writer.writeByte('0');
        return;
    }
    if (@abs(value) < 0.000001) {
        try writer.print("{e}", .{value});
        return;
    }
    try writer.print("{d}", .{value});
}

fn writeRgb(writer: *std.Io.Writer, color: anytype) !void {
    try writer.print(
        "{{\"b\":{d},\"g\":{d},\"r\":{d}}}",
        .{ color.b, color.g, color.r },
    );
}

fn writeColor(writer: *std.Io.Writer, value: ?Config.TerminalColor) !void {
    const color = value orelse {
        try writer.writeAll("{\"kind\":\"unset\"}");
        return;
    };

    switch (color) {
        .color => |rgb| {
            try writer.writeAll("{\"kind\":\"rgb\",\"value\":");
            try writeRgb(writer, rgb);
            try writer.writeByte('}');
        },
        .@"cell-foreground" => try writer.writeAll("{\"kind\":\"cell-foreground\"}"),
        .@"cell-background" => try writer.writeAll("{\"kind\":\"cell-background\"}"),
    }
}

fn writePalette(writer: *std.Io.Writer, config: *const Config) !void {
    var palette = config.palette.value;
    if (config.@"palette-generate" and config.palette.mask.findFirstSet() != null) {
        palette = terminal_color.generate256Color(
            palette,
            config.palette.mask,
            config.background.toTerminalRGB(),
            config.foreground.toTerminalRGB(),
            config.@"palette-harmonious",
        );
    }

    for (palette, 0..) |color, index| {
        if (index > 0) try writer.writeByte(',');
        try writeRgb(writer, color);
    }
}

fn writeBackgroundBlur(writer: *std.Io.Writer, blur: Config.BackgroundBlur) !void {
    switch (blur) {
        .false => try writer.writeAll("{\"kind\":\"none\"}"),
        .true => try writer.writeAll("{\"kind\":\"radius\",\"value\":20}"),
        .radius => |radius| try writer.print(
            "{{\"kind\":\"radius\",\"value\":{d}}}",
            .{radius},
        ),
        .@"macos-glass-regular" => try writer.writeAll(
            "{\"kind\":\"macos-glass\",\"variant\":\"regular\"}",
        ),
        .@"macos-glass-clear" => try writer.writeAll(
            "{\"kind\":\"macos-glass\",\"variant\":\"clear\"}",
        ),
    }
}

fn discardLog(
    comptime _: std.log.Level,
    comptime _: @TypeOf(.enum_literal),
    comptime _: []const u8,
    _: anytype,
) void {}
