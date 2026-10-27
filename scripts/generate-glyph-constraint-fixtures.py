#!/usr/bin/env python3
"""Render pinned Ghostty glyph constraints with native Zig and FreeType.

Usage: native-reference.py GHOSTTY_REPO ZIG OUTPUT
"""

import ctypes as c
import hashlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

from PIL import Image

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent / "sprites"))
from font_metrics import BBox, NativeFont

PIN = "7b11f3dca034d8d24369ad3856afe57946d7902a"
repo, zig, destination = sys.argv[1:]
output = Path(destination).resolve()
output.mkdir(parents=True, exist_ok=True)
font_path = output / "JetBrainsMonoNerdFont-Regular.ttf"
codepoints = [
    0xEA61,
    0xF013,
    0xF07B,
    0xF120,
    0x2630,
    0xE30E,
    0xE701,
    0xF300,
    0xE0C0,
    0xE0C1,
    0xE0C2,
    0xE0C3,
    0xE0C4,
    0xE0C5,
    0xE0C6,
    0xE0C8,
    0xE0CA,
    0xE0CC,
    0xE0CD,
    0xE0CE,
    0xE0D0,
    0xE0D1,
    0xE0D2,
    0xE0D4,
]


class Vector(c.Structure):
    _fields_ = [("x", c.c_long), ("y", c.c_long)]


class Outline(c.Structure):
    _fields_ = [
        ("n_contours", c.c_short),
        ("n_points", c.c_short),
        ("points", c.POINTER(Vector)),
        ("tags", c.c_void_p),
        ("contours", c.POINTER(c.c_short)),
        ("flags", c.c_int),
    ]


class Bitmap(c.Structure):
    _fields_ = [
        ("rows", c.c_uint),
        ("width", c.c_uint),
        ("pitch", c.c_int),
        ("buffer", c.POINTER(c.c_ubyte)),
        ("num_grays", c.c_ushort),
        ("pixel_mode", c.c_ubyte),
        ("palette_mode", c.c_ubyte),
        ("palette", c.c_void_p),
    ]


class GlyphMetrics(c.Structure):
    _fields_ = [(name, c.c_long) for name in [
        "width", "height", "horiBearingX", "horiBearingY",
        "horiAdvance", "vertBearingX", "vertBearingY", "vertAdvance",
    ]]


class GlyphSlot(c.Structure):
    _fields_ = [
        ("library", c.c_void_p),
        ("face", c.c_void_p),
        ("next", c.c_void_p),
        ("glyph_index", c.c_uint),
        ("generic", c.c_byte * 16),
        ("metrics", GlyphMetrics),
        ("linearHoriAdvance", c.c_long),
        ("linearVertAdvance", c.c_long),
        ("advance", Vector),
        ("format", c.c_uint),
        ("bitmap", Bitmap),
        ("bitmap_left", c.c_int),
        ("bitmap_top", c.c_int),
        ("outline", Outline),
    ]


def fixed(value):
    return value / 64.0


def round_fixed(value):
    scaled = value * 64
    rounded = math.floor(scaled + 0.5) if scaled >= 0 else math.ceil(scaled - 0.5)
    return int(rounded)


class ConstraintFont(NativeFont):
    def __init__(self, path):
        super().__init__(path)
        self.api.FT_Get_Char_Index.argtypes = [c.POINTER(type(self.face.contents)), c.c_uint]
        self.api.FT_Get_Char_Index.restype = c.c_uint
        self.api.FT_Load_Glyph.argtypes = [c.POINTER(type(self.face.contents)), c.c_uint, c.c_int]
        self.api.FT_Render_Glyph.argtypes = [c.POINTER(GlyphSlot), c.c_int]
        self.api.FT_Outline_Get_BBox.argtypes = [c.POINTER(Outline), c.POINTER(BBox)]

    def load(self, cp):
        self.slot = c.cast(self.face.contents.glyph, c.POINTER(GlyphSlot))
        glyph = self.api.FT_Get_Char_Index(self.face, cp)
        self.check(self.api.FT_Load_Glyph(self.face, glyph, 2 | 8))
        bbox = BBox()
        self.check(self.api.FT_Outline_Get_BBox(c.byref(self.slot.contents.outline), c.byref(bbox)))
        return {
            "x": fixed(bbox.xmin),
            "y": fixed(bbox.ymin),
            "width": fixed(bbox.xmax - bbox.xmin),
            "height": fixed(bbox.ymax - bbox.ymin),
        }

    def render(self, original, constrained, cell_baseline):
        slot = self.slot.contents
        scale_x = constrained["width"] / original["width"]
        scale_y = constrained["height"] / original["height"]
        for index in range(slot.outline.n_points):
            point = slot.outline.points[index]
            px = (fixed(point.x) - original["x"]) * scale_x + constrained["x"]
            py = (fixed(point.y) - original["y"]) * scale_y + constrained["y"] - cell_baseline
            point.x = round_fixed(px)
            point.y = round_fixed(py)
        self.check(self.api.FT_Render_Glyph(self.slot, 0))
        bitmap = slot.bitmap
        rows = []
        for row in range(bitmap.rows):
            address = c.cast(bitmap.buffer, c.c_void_p).value + row * bitmap.pitch
            rows.append(c.string_at(address, bitmap.width))
        px_y = slot.bitmap_top + cell_baseline - bitmap.rows
        return rows, slot.bitmap_left, px_y, bitmap.width, bitmap.rows


def font_case(width, height, size, dpr, constraint_width):
    cell_width = round(width * dpr)
    cell_height = round(height * dpr)
    return {
        "width": width,
        "height": height,
        "fontSize": size,
        "dpr": dpr,
        "cellWidth": cell_width,
        "cellHeight": cell_height,
        "cellBaseline": cell_height - round(cell_height * 0.8),
        "constraintWidth": constraint_width,
    }


cases = [
    font_case(w, h, size, dpr, constraint_width)
    for w, h, size in [(9, 18, 14), (13, 27, 20), (18, 36, 28)]
    for dpr in [1, 1.25, 2]
    for constraint_width in [1, 2]
]


def zig_number(value):
    if isinstance(value, int):
        return str(value)
    return repr(float(value))


def zig_metrics(case, cap_height):
    face_height = case["cellHeight"]
    values = {
        "cell_width": case["cellWidth"],
        "cell_height": case["cellHeight"],
        "cell_baseline": case["cellBaseline"],
        "underline_position": 1,
        "underline_thickness": 1,
        "strikethrough_position": 1,
        "strikethrough_thickness": 1,
        "overline_position": 0,
        "overline_thickness": 1,
        "box_thickness": 1,
        "cursor_height": case["cellHeight"],
        "icon_height": face_height,
        "icon_height_single": (2 * cap_height + face_height) / 3,
        "face_width": case["cellWidth"],
        "face_height": face_height,
        "face_y": 0,
    }
    return ".{" + ",".join(f".{k}={zig_number(v)}" for k, v in values.items()) + "}"


with ConstraintFont(font_path) as native_font:
    originals = []
    cap_heights = []
    for case in cases:
        native_font.ppem(case["fontSize"], case["dpr"])
        cap = native_font.load(ord("H"))
        cap_heights.append(cap["height"])
        for cp in codepoints:
            rect = native_font.load(cp)
            originals.append((case, cp, rect))

    with tempfile.TemporaryDirectory(prefix="ghw-c7-native-", dir="/work/tmp") as scratch:
        path = Path(scratch)
        archive = subprocess.check_output(["git", "-C", repo, "archive", PIN, "src"])
        with tarfile.open(fileobj=io.BytesIO(archive)) as sources:
            sources.extractall(path, filter="data")
        zig_cases = []
        for (case, cp, rect), cap_height in zip(originals, [c for c in cap_heights for _ in codepoints]):
            native_rect = dict(rect)
            native_rect["y"] += case["cellBaseline"]
            glyph = ".{" + ",".join(f".{k}={zig_number(v)}" for k, v in native_rect.items()) + "}"
            zig_cases.append(f".{{.cp={cp},.constraint_width={case['constraintWidth']},.glyph={glyph},.metrics={zig_metrics(case, cap_height)}}}")
        (path / "reference.zig").write_text("""const std = @import("std");
const font = @import("src/font/Glyph.zig");
const attributes = @import("src/font/nerd_font_attributes.zig");
const Case = struct { cp: u21, constraint_width: u2, glyph: font.Size, metrics: @import("src/font/Metrics.zig") };
const cases = [_]Case{""" + ",".join(zig_cases) + """};
pub fn main(init: std.process.Init) !void {
    var buffer: [4096]u8 = undefined;
    var writer = std.Io.File.stdout().writer(init.io, &buffer);
    for (cases) |case| {
        const constraint = attributes.getConstraint(case.cp) orelse font.RenderOptions.Constraint{ .size = .fit };
        var size = constraint.constrain(case.glyph, case.metrics, case.constraint_width);
        if (constraint.size != .stretch and case.metrics.face_width < @as(f64, @floatFromInt(case.metrics.cell_width))) {
            size.x += @round((@as(f64, @floatFromInt(case.metrics.cell_width)) - case.metrics.face_width) / 2);
        }
        try writer.interface.print("{d} {d} {d} {d}\\n", .{ size.x, size.y, size.width, size.height });
    }
    try writer.interface.flush();
}
""")
        env = dict(os.environ)
        env["XDG_CACHE_HOME"] = "/work/cache/zig/global"
        subprocess.run([zig, "build-exe", "-O", "ReleaseFast", str(path / "reference.zig"), "-femit-bin=" + str(path / "reference")], check=True, cwd=path, env=env)
        result = subprocess.check_output([str(path / "reference")], text=True)

    constrained_values = [
        dict(zip(["x", "y", "width", "height"], map(float, line.split())))
        for line in result.splitlines()
    ]
    sheets = [Image.new("L", (8 * (case["cellWidth"] * case["constraintWidth"] + 16), 3 * (case["cellHeight"] + 16)), 0) for case in cases]
    for index, ((case, cp, original), constrained) in enumerate(zip(originals, constrained_values)):
        case_index = index // len(codepoints)
        glyph_index = index % len(codepoints)
        native_font.ppem(case["fontSize"], case["dpr"])
        native_font.load(cp)
        baseline_original = dict(original)
        rows, px_x, px_y, width, height = native_font.render(baseline_original, constrained, case["cellBaseline"])
        tile_width = case["cellWidth"] * case["constraintWidth"] + 16
        tile_height = case["cellHeight"] + 16
        tile_x = (glyph_index % 8) * tile_width + 8
        tile_y = (glyph_index // 8) * tile_height + 8
        top = case["cellHeight"] - px_y - height
        glyph = Image.frombytes("L", (width, height), b"".join(rows))
        sheets[case_index].paste(glyph, (tile_x + px_x, tile_y + top), glyph)

    for index, (case, sheet) in enumerate(zip(cases, sheets)):
        case["tileWidth"] = case["cellWidth"] * case["constraintWidth"] + 16
        case["tileHeight"] = case["cellHeight"] + 16
        case["file"] = f"case-{index}.png"
        sheet.save(output / case["file"])

    manifest = {
        "revision": PIN,
        "font": {
            "file": font_path.name,
            "sha256": hashlib.sha256(font_path.read_bytes()).hexdigest(),
            "freetypeVersion": native_font.version,
        },
        "codepoints": codepoints,
        "cases": cases,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    subprocess.run(["bun", "x", "oxfmt", "--write", str(output / "manifest.json")], check=True)
