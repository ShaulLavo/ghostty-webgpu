"""The FreeType fields consumed by pinned Ghostty's font/face/freetype.zig."""

import ctypes as c
import ctypes.util


class Generic(c.Structure):
    _fields_ = [("data", c.c_void_p), ("finalizer", c.c_void_p)]


class BBox(c.Structure):
    _fields_ = [(name, c.c_long) for name in ["xmin", "ymin", "xmax", "ymax"]]


class SizeMetrics(c.Structure):
    _fields_ = [("x_ppem", c.c_ushort), ("y_ppem", c.c_ushort)] + [
        (name, c.c_long)
        for name in [
            "x_scale",
            "y_scale",
            "ascender",
            "descender",
            "height",
            "max_advance",
        ]
    ]


class Face(c.Structure):
    pass


class Size(c.Structure):
    _fields_ = [
        ("face", c.POINTER(Face)),
        ("generic", Generic),
        ("metrics", SizeMetrics),
    ]


Face._fields_ = (
    [
        (name, c.c_long)
        for name in [
            "num_faces",
            "face_index",
            "face_flags",
            "style_flags",
            "num_glyphs",
        ]
    ]
    + [
        ("family_name", c.c_char_p),
        ("style_name", c.c_char_p),
        ("num_fixed_sizes", c.c_int),
        ("available_sizes", c.c_void_p),
        ("num_charmaps", c.c_int),
        ("charmaps", c.c_void_p),
        ("generic", Generic),
        ("bbox", BBox),
        ("units_per_em", c.c_ushort),
    ]
    + [
        (name, c.c_short)
        for name in [
            "ascender",
            "descender",
            "height",
            "max_advance_width",
            "max_advance_height",
            "underline_position",
            "underline_thickness",
        ]
    ]
    + [("glyph", c.c_void_p), ("size", c.POINTER(Size))]
)


class Post(c.Structure):
    _fields_ = [
        ("format", c.c_long),
        ("italic_angle", c.c_long),
        ("underline_position", c.c_short),
        ("underline_thickness", c.c_short),
    ]


class NativeFont:
    def __init__(self, path):
        library = ctypes.util.find_library("freetype")
        if not library:
            raise RuntimeError("FreeType is required for the native font reference")
        self.api = c.CDLL(library)
        self.api.FT_New_Face.argtypes = [
            c.c_void_p,
            c.c_char_p,
            c.c_long,
            c.POINTER(c.POINTER(Face)),
        ]
        self.api.FT_Set_Char_Size.argtypes = [
            c.POINTER(Face),
            c.c_long,
            c.c_long,
            c.c_uint,
            c.c_uint,
        ]
        self.api.FT_Get_Sfnt_Table.argtypes = [c.POINTER(Face), c.c_int]
        self.api.FT_Get_Sfnt_Table.restype = c.POINTER(Post)
        self.library = c.c_void_p()
        self.face = c.POINTER(Face)()
        self.check(self.api.FT_Init_FreeType(c.byref(self.library)))
        error = self.api.FT_New_Face(
            self.library, str(path).encode(), 0, c.byref(self.face)
        )
        if error:
            self.api.FT_Done_FreeType(self.library)
            self.check(error)

    def check(self, error):
        if error:
            raise RuntimeError(f"FreeType error {error}")

    def __enter__(self):
        self.units_per_em = self.face.contents.units_per_em
        post = self.api.FT_Get_Sfnt_Table(self.face, 5)
        if not post:
            self.__exit__(None, None, None)
            raise RuntimeError("Reference font has no native post table")
        self.underline_thickness = post.contents.underline_thickness
        major, minor, patch = c.c_int(), c.c_int(), c.c_int()
        self.api.FT_Library_Version(
            self.library, c.byref(major), c.byref(minor), c.byref(patch)
        )
        self.version = f"{major.value}.{minor.value}.{patch.value}"
        return self

    def ppem(self, css_size, dpr):
        self.check(
            self.api.FT_Set_Char_Size(self.face, 0, int(css_size * dpr * 64), 72, 72)
        )
        return self.face.contents.size.contents.metrics.y_ppem

    def __exit__(self, *_):
        self.api.FT_Done_Face(self.face)
        self.api.FT_Done_FreeType(self.library)
