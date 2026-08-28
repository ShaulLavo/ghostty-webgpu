const std = @import("std");
const buildpkg = @import("src/build/main.zig");

pub fn build(b: *std.Build) !void {
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
        .name = "ghostty-config-resolver-proof",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = config.target,
            .optimize = config.optimize,
            .strip = config.strip,
        }),
        .use_llvm = true,
    });
    _ = try deps.add(exe);
    b.installArtifact(exe);
}
