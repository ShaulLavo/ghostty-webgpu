const std = @import("std");
const builtin = @import("builtin");
const Config = @import("src/config/Config.zig");
const file_load = @import("src/config/file_load.zig");
const global = @import("src/global.zig");
const terminal_color = @import("src/terminal/color.zig");

const upstream_revision = "c8554f28e0efe2f5595f32020371c34b25ec628f";
const resolver_error =
    "{\"proofSchemaVersion\":1,\"status\":\"resolver-error\",\"upstreamRevision\":\"" ++
    upstream_revision ++ "\"}\n";

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
    global.init(.{ .tool = minimal }) catch {
        writeResolverError();
        return;
    };
    defer global.deinit();

    mainInitialized(minimal) catch writeResolverError();
}

fn mainInitialized(minimal: std.process.Init.Minimal) !void {
    const pause_after_discovery = try parseArguments(minimal.args.vector);
    const alloc = global.alloc();
    var config = try Config.default(alloc);
    defer config.deinit();

    const load_result = try loadReadOnlyDefaults(
        &config,
        alloc,
        pause_after_discovery,
    );
    if (load_result == .not_configured) {
        try writeUnavailable("not-configured");
        return;
    }
    if (load_result == .resolver_error) {
        writeResolverError();
        return;
    }

    try config.loadRecursiveFiles(alloc);
    try config.finalize();

    var dark = (try config.changeConditionalState(.{ .theme = .dark })) orelse
        try config.clone(alloc);
    defer dark.deinit();

    try writeReady(&config, &dark);
}

fn parseArguments(args: []const [*:0]const u8) !bool {
    if (args.len == 1) return false;
    if (args.len != 2) return error.InvalidArguments;

    const argument = std.mem.span(args[1]);
    if (!std.mem.eql(u8, argument, "--proof-pause-after-discovery")) {
        return error.InvalidArguments;
    }
    return true;
}

fn loadReadOnlyDefaults(
    config: *Config,
    alloc: std.mem.Allocator,
    pause_after_discovery: bool,
) !LoadResult {
    var candidates = try discoverCandidates(alloc);
    defer candidates.deinit(alloc);

    if (pause_after_discovery) try pauseForRace();

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

    const legacy = try file_load.legacyDefaultAppSupportPath(alloc);
    result.append(legacy);
    const preferred = try file_load.preferredAppSupportPath(alloc);
    if (std.mem.eql(u8, legacy, preferred)) {
        alloc.free(preferred);
        return result;
    }

    result.append(preferred);
    return result;
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
    var buffer: [4096]u8 = undefined;
    var file_writer = std.Io.File.stdout().writer(global.io(), &buffer);
    const writer = &file_writer.interface;
    const diagnostic_count = @min(
        @max(light._diagnostics.items().len, dark._diagnostics.items().len),
        65_535,
    );

    try writer.print(
        "{{\"proofSchemaVersion\":1,\"status\":\"ready\",\"upstreamRevision\":\"{s}\",\"diagnosticCount\":{d},\"profiles\":{{\"light\":",
        .{ upstream_revision, diagnostic_count },
    );
    try writeProfile(writer, light);
    try writer.writeAll(",\"dark\":");
    try writeProfile(writer, dark);
    try writer.writeAll("}}\n");
    try writer.flush();
}

fn writeUnavailable(status: []const u8) !void {
    var buffer: [256]u8 = undefined;
    var file_writer = std.Io.File.stdout().writer(global.io(), &buffer);
    try file_writer.interface.print(
        "{{\"proofSchemaVersion\":1,\"status\":\"{s}\",\"upstreamRevision\":\"{s}\"}}\n",
        .{ status, upstream_revision },
    );
    try file_writer.interface.flush();
}

fn writeResolverError() void {
    _ = std.c.write(1, resolver_error.ptr, resolver_error.len);
}

fn writeProfile(writer: *std.Io.Writer, config: *const Config) !void {
    try writer.writeAll("{\"background\":");
    try writeRgb(writer, config.background);
    try writer.writeAll(",\"foreground\":");
    try writeRgb(writer, config.foreground);
    try writer.writeAll(",\"cursorColor\":");
    try writeColor(writer, config.@"cursor-color");
    try writer.writeAll(",\"cursorText\":");
    try writeColor(writer, config.@"cursor-text");
    try writer.writeAll(",\"selectionBackground\":");
    try writeColor(writer, config.@"selection-background");
    try writer.writeAll(",\"selectionForeground\":");
    try writeColor(writer, config.@"selection-foreground");
    try writer.print(",\"minimumContrast\":{d},\"palette\":[", .{config.@"minimum-contrast"});
    try writePalette(writer, config);
    try writer.writeAll("],\"windowColorspace\":\"");
    try writer.writeAll(switch (config.@"window-colorspace") {
        .srgb => "srgb",
        .@"display-p3" => "display-p3",
    });
    try writer.writeAll("\",\"surface\":{\"backgroundOpacity\":");
    try writer.print("{d}", .{config.@"background-opacity"});
    try writer.writeAll(",\"backgroundOpacityCells\":");
    try writer.writeAll(if (config.@"background-opacity-cells") "true" else "false");
    try writer.writeAll(",\"backgroundBlur\":");
    try writeBackgroundBlur(writer, config.@"background-blur");
    try writer.writeAll("}}");
}

fn writeRgb(writer: *std.Io.Writer, color: anytype) !void {
    try writer.print(
        "{{\"r\":{d},\"g\":{d},\"b\":{d}}}",
        .{ color.r, color.g, color.b },
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
