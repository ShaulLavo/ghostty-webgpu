const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const dependency = b.dependency("ghostty", .{ .target = target, .optimize = optimize, .simd = false });
    const module = b.createModule(.{
        .root_source_file = b.path("paint-test.zig"),
        .target = target,
        .optimize = optimize,
    });
    module.addImport("ghostty-vt", dependency.module("ghostty-vt"));
    module.addIncludePath(dependency.path("include"));
    module.linkLibrary(dependency.artifact("ghostty-vt-static"));
    const tests = b.addTest(.{ .root_module = module });
    b.step("test", "Test native positional painting").dependOn(&b.addRunArtifact(tests).step);
}
