const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const dependency = b.dependency("ghostty", .{ .target = target, .optimize = optimize, .simd = false });
    const module = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true });
    module.addIncludePath(dependency.path("include"));
    module.addCSourceFile(.{ .file = b.path("terminal.c"), .flags = &.{"-std=c11", "-Wall", "-Wextra", "-Werror"} });
    const library = dependency.artifact("ghostty-vt-static");
    module.linkLibrary(library);
    b.installArtifact(library);
    const executable = b.addExecutable(.{ .name = "owned-vt-terminal", .root_module = module });
    b.installArtifact(executable);
}
