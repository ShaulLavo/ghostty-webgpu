const std = @import("std");
const buildpkg = @import("src/build/main.zig");

pub fn build(b: *std.Build) !void {
    const preverified_generated = b.option(
        bool,
        "native-preverified-generated",
        "Consume native-generated modules that were verified before this build",
    ) orelse false;
    var config = try buildpkg.Config.init(b, "1.3.2-dev", "0.1.0-dev");
    config.app_runtime = .none;
    config.emit_lib_vt = false;
    config.sentry = false;
    config.simd = false;
    config.i18n = false;
    config.x11 = false;
    config.wayland = false;

    const deps = try buildpkg.SharedDeps.init(b, &config);
    const exe = b.addExecutable(.{
        .name = "ghostty-config-resolver",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = config.target,
            .optimize = config.optimize,
            .strip = config.strip,
        }),
        .use_llvm = true,
    });
    _ = try deps.add(exe);
    const materialize = b.step(
        "native-materialize-generated",
        "Materialize generated native inputs without compiling the helper",
    );
    const help_strings = bindGeneratedModule(
        b,
        exe,
        materialize,
        preverified_generated,
        "help_strings",
        "help_strings.zig",
    );
    const hb_c = if (config.target.result.os.tag.isDarwin())
        null
    else
        bindGeneratedModule(b, exe, materialize, preverified_generated, "hb_c", "hb_c.zig");
    const wuffs_c = bindGeneratedModule(
        b,
        exe,
        materialize,
        preverified_generated,
        "wuffs_c",
        "wuffs_c.zig",
    );
    if (!preverified_generated) return;
    detachDirectDependency(&exe.step, help_strings, 1);
    if (hb_c) |producer| detachDirectDependency(&exe.step, producer, 0);
    detachDirectDependency(&exe.step, wuffs_c, 0);
    assertProducerDetached(b, &exe.step, help_strings);
    if (hb_c) |producer| assertProducerDetached(b, &exe.step, producer);
    assertProducerDetached(b, &exe.step, wuffs_c);
    b.installArtifact(exe);
}

fn bindGeneratedModule(
    b: *std.Build,
    exe: *std.Build.Step.Compile,
    materialize: *std.Build.Step,
    preverified: bool,
    import_name: []const u8,
    filename: []const u8,
) *std.Build.Step {
    var seen: std.AutoHashMapUnmanaged(*std.Build.Module, void) = .empty;
    defer seen.deinit(b.allocator);
    var found: ?*std.Build.Module = null;
    findImportedModule(b, exe.root_module, import_name, &seen, &found);

    const module = found orelse @panic("native generated module is missing");
    const source = module.root_source_file orelse @panic("native generated module has no source");
    const producer = switch (source) {
        .generated => |generated| generated.file.step,
        else => @panic("native generated module source is not generated"),
    };

    const destination = b.fmt("native-generated/{s}", .{filename});
    if (!preverified) {
        const install = b.addInstallFile(source, destination);
        materialize.dependOn(&install.step);
        return producer;
    }
    module.root_source_file = .{ .cwd_relative = b.getInstallPath(.prefix, destination) };
    return producer;
}

fn detachDirectDependency(step: *std.Build.Step, dependency: *std.Build.Step, expected: usize) void {
    var removed: usize = 0;
    var index: usize = 0;
    while (index < step.dependencies.items.len) {
        if (step.dependencies.items[index] != dependency) {
            index += 1;
            continue;
        }
        _ = step.dependencies.orderedRemove(index);
        removed += 1;
    }
    if (removed != expected) @panic("native generated module dependency count mismatch");
}

fn assertProducerDetached(b: *std.Build, root: *std.Build.Step, producer: *std.Build.Step) void {
    var seen: std.AutoHashMapUnmanaged(*std.Build.Step, void) = .empty;
    defer seen.deinit(b.allocator);
    if (stepReaches(b, root, producer, &seen)) {
        @panic("native generated module producer remains in final graph");
    }
}

fn stepReaches(
    b: *std.Build,
    step: *std.Build.Step,
    target: *std.Build.Step,
    seen: *std.AutoHashMapUnmanaged(*std.Build.Step, void),
) bool {
    if (step == target) return true;
    const result = seen.getOrPut(b.allocator, step) catch @panic("OOM");
    if (result.found_existing) return false;
    for (step.dependencies.items) |dependency| {
        if (stepReaches(b, dependency, target, seen)) return true;
    }
    return false;
}

fn findImportedModule(
    b: *std.Build,
    module: *std.Build.Module,
    import_name: []const u8,
    seen: *std.AutoHashMapUnmanaged(*std.Build.Module, void),
    found: *?*std.Build.Module,
) void {
    const result = seen.getOrPut(b.allocator, module) catch @panic("OOM");
    if (result.found_existing) return;

    for (module.import_table.keys(), module.import_table.values()) |name, imported| {
        if (std.mem.eql(u8, name, import_name)) {
            if (found.* != null and found.* != imported) {
                @panic("native generated module is ambiguous");
            }
            found.* = imported;
        }
        findImportedModule(b, imported, import_name, seen, found);
    }
}
