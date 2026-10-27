#!/usr/bin/env python3
"""Build pinned Ghostty sprite draw code natively and emit browser fixtures.

Usage: native-reference.py GHOSTTY_REPO ZIG Z2D_TARBALL OUTPUT
Only import wiring changes in the disposable adapter; draw functions are unchanged.
"""

import json
import math
import re
import signal
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
from PIL import Image

PIN = "7b11f3dca034d8d24369ad3856afe57946d7902a"
repo, zig, z2d_archive, destination = sys.argv[1:]
output = Path(destination).resolve()
output.mkdir(parents=True, exist_ok=True)
codepoints = (
    list(range(0x2500, 0x25A0))
    + list(range(0x2800, 0x2900))
    + list(range(0x1FB00, 0x1FB3C))
    + list(range(0xE0B0, 0xE0C0))
)
cases = []
for width, height in [(9, 18), (13, 27), (18, 36)]:
    for dpr in [1, 1.25, 2]:
        w, h = math.floor(width * dpr + 0.5), math.floor(height * dpr + 0.5)
        ascent = math.floor(h * 0.8 + 0.5)
        cases.append(
            dict(
                width=w,
                height=h,
                thickness=math.ceil(0.15 * 0.75 * 0.75 * ascent),
                span=1,
                dpr=dpr,
            )
        )
cases.append(dict(width=16, height=34, thickness=3, span=2, dpr=1.25))


def source(path):
    return subprocess.check_output(
        ["git", "-C", repo, "show", f"{PIN}:src/font/sprite/{path}"], text=True
    )


def adapt(text):
    return (
        text.replace('@import("../../../quirks.zig").inlineAssert', "std.debug.assert")
        .replace('@import("../../quirks.zig").inlineAssert', "std.debug.assert")
        .replace('@import("../../main.zig")', '@import("font.zig")')
        .replace('@import("../main.zig")', '@import("font.zig")')
        .replace('const global = @import("../../global.zig");', "")
        .replace("global.io()", "std.testing.io")
    )


def generate_box_table():
    text = source("draw/box.zig")
    styles = dict(none=0, light=1, heavy=2, double=3)
    values = []
    for cp in range(0x2500, 0x2580):
        pattern = r"0x%04x => linesChar\(metrics, canvas, \.\{(.*?)\}\)" % cp
        match = re.search(pattern, text)
        values.append(-1 if match is None else packed_lines(match[1], styles))
    lines = [
        "// Adapted from Ghostty 7b11f3d, src/font/sprite/draw/box.zig. MIT, see THIRD_PARTY_NOTICES.md.",
        "export const boxLines: readonly number[] = [",
    ]
    for index in range(0, 128, 8):
        lines.append("  " + ", ".join(map(str, values[index : index + 8])) + ",")
    lines.append("]")
    table = output.parent / "sprite-box-lines.ts"
    table.write_text("\n".join(lines) + "\n")
    return table


def packed_lines(text, styles):
    arms = dict(re.findall(r"\.(up|right|down|left) = \.(\w+)", text))
    return sum(
        styles[arms.get(arm, "none")] << (index * 2)
        for index, arm in enumerate(["up", "right", "down", "left"])
    )


def interrupted(number, _frame):
    raise SystemExit(128 + number)


for number in [signal.SIGTERM, signal.SIGHUP]:
    signal.signal(number, interrupted)


with tempfile.TemporaryDirectory(prefix="ghw-x3-native-", dir="/work/tmp") as scratch:
    path = Path(scratch)
    with tarfile.open(z2d_archive) as archive:
        archive.extractall(path / "z2d", filter="data")
    z2d_root = next((path / "z2d").iterdir()) / "src" / "z2d.zig"
    for name in [
        "canvas.zig",
        "draw/common.zig",
        "draw/block.zig",
        "draw/box.zig",
        "draw/braille.zig",
        "draw/powerline.zig",
        "draw/geometric_shapes.zig",
        "draw/symbols_for_legacy_computing.zig",
    ]:
        (path / Path(name).name).write_text(adapt(source(name)))
    (path / "font.zig").write_text("""pub const Metrics = struct {
    cell_width: u32, cell_height: u32, box_thickness: u32,
};
pub const sprite = struct {
    pub const Canvas = @import("canvas.zig").Canvas;
    pub const Color = @import("canvas.zig").Color;
};
""")
    case_list = ",\n".join(
        ".{%d,%d,%d,%d}" % (c["width"], c["height"], c["thickness"], c["span"])
        for c in cases
    )
    cp_list = ",".join(map(str, codepoints))
    powerline_switch = "\n".join(
        "0x%x => try powerline.draw%X(cp, canvas, w, h, metrics)," % (cp, cp)
        for cp in range(0xE0B0, 0xE0C0)
    )
    (path / "reference.zig").write_text(
        """const std = @import("std");
const font = @import("font.zig");
const z2d = @import("z2d");
const box = @import("box.zig");
const block = @import("block.zig");
const braille = @import("braille.zig");
const legacy = @import("symbols_for_legacy_computing.zig");
const powerline = @import("powerline.zig");
fn draw(cp: u32, canvas: *font.sprite.Canvas, w: u32, h: u32, metrics: font.Metrics) !void {
            switch (cp) {
                0x2500...0x257f => try box.draw2500_257F(cp, canvas, w, h, metrics),
                0x2580...0x259f => try block.draw2580_259F(cp, canvas, w, h, metrics),
                0x2800...0x28ff => try braille.draw2800_28FF(cp, canvas, w, h, metrics),
                0x1fb00...0x1fb3b => try legacy.draw1FB00_1FB3B(cp, canvas, w, h, metrics),
"""
        + powerline_switch
        + """
                else => unreachable,
            }
}
fn copyTile(sheet: []u8, pixels: []const u8, index: usize, tw: usize, th: usize, sheet_width: usize) void {
    for (0..th) |row| {
        const dest = ((index / 16) * th + row) * sheet_width + (index % 16) * tw;
        @memcpy(sheet[dest..][0..tw], pixels[row * tw..][0..tw]);
    }
}
test "native sprite fixtures" {
    const alloc = std.testing.allocator;
    const cases = [_][4]u32{"""
        + case_list
        + """};
    const cps = [_]u32{"""
        + cp_list
        + """};
    for (cases, 0..) |c, case_index| {
        const w = c[0] * c[3];
        const h = c[1];
        const px = w / 4;
        const py = h / 4;
        const tw = w + 2 * px;
        const th = h + 2 * py;
        const sheet_width = tw * 16;
        const sheet_height = th * ((cps.len + 15) / 16);
        const sheet = try alloc.alloc(u8, sheet_width * sheet_height);
        defer alloc.free(sheet);
        @memset(sheet, 0);
        const metrics: font.Metrics = .{ .cell_width = c[0], .cell_height = h, .box_thickness = c[2] };
        for (cps, 0..) |cp, index| {
            var canvas = try font.sprite.Canvas.init(alloc, w, h, px, py);
            defer canvas.deinit();
            try draw(cp, &canvas, w, h, metrics);
            const pixels = std.mem.sliceAsBytes(canvas.sfc.image_surface_alpha8.buf);
            copyTile(sheet, pixels, index, tw, th, sheet_width);
        }
        var name_buffer: [128]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buffer, "case-{d}.alpha", .{case_index});
        try std.Io.Dir.cwd().writeFile(std.testing.io, .{ .sub_path = name, .data = sheet });
    }
}
"""
    )
    (path / "options.zig").write_text("pub const vector_length: u32 = 16;\n")
    subprocess.run(
        [
            zig,
            "test",
            "-O",
            "ReleaseFast",
            "--dep",
            "z2d",
            "-Mroot=" + str(path / "reference.zig"),
            "--dep",
            "z2d_options",
            "-Mz2d=" + str(z2d_root),
            "-Mz2d_options=" + str(path / "options.zig"),
            "--test-filter",
            "native sprite fixtures",
            "--cache-dir",
            str(path / "cache"),
            "--global-cache-dir",
            "/work/cache/zig/global",
        ],
        cwd=path,
        check=True,
    )
    for index, c in enumerate(cases):
        w, h = c["width"] * c["span"], c["height"]
        c["tileWidth"], c["tileHeight"] = w + 2 * (w // 4), h + 2 * (h // 4)
        c["file"] = f"case-{index}.png"
        image = Image.frombytes(
            "L",
            (16 * c["tileWidth"], math.ceil(len(codepoints) / 16) * c["tileHeight"]),
            (path / f"case-{index}.alpha").read_bytes(),
        )
        image.save(output / c["file"])
    (output / "manifest.json").write_text(
        json.dumps(dict(revision=PIN, codepoints=codepoints, cases=cases), indent=2)
        + "\n"
    )

subprocess.run(
    ["bun", "x", "oxfmt", str(output / "manifest.json"), str(generate_box_table())],
    check=True,
)
