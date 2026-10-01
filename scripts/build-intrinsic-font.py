from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


def rectangle(left, right):
    pen = TTGlyphPen(None)
    pen.moveTo((left, 0))
    pen.lineTo((right, 0))
    pen.lineTo((right, 700))
    pen.lineTo((left, 700))
    pen.closePath()
    return pen.glyph()


builder = FontBuilder(1000, isTTF=True)
glyphs = [".notdef", "ink", "white", "black", "gray", "left", "right", "mixed", "foreground"]
builder.setupGlyphOrder(glyphs)
builder.setupCharacterMap(
    {
        ord("M"): "ink",
        ord("W"): "white",
        ord("B"): "black",
        ord("G"): "gray",
        ord("X"): "mixed",
        ord("C"): "foreground",
    }
)
outlines = {name: TTGlyphPen(None).glyph() for name in glyphs}
outlines.update(ink=rectangle(100, 900), left=rectangle(100, 400), right=rectangle(600, 900))
builder.setupGlyf(outlines)
builder.setupHorizontalMetrics({name: (1000, 600 if name == "right" else 100) for name in glyphs})
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupNameTable(
    {
        "familyName": "Intrinsic Colors",
        "styleName": "Regular",
        "psName": "IntrinsicColors-Regular",
    }
)
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
colors = {name: [("ink", index)] for index, name in enumerate(["white", "black", "gray"])}
colors.update(mixed=[("left", 0xFFFF), ("right", 2)], foreground=[("ink", 0xFFFF)])
builder.setupCOLR(colors)
builder.setupCPAL([[(1, 1, 1, 1), (0, 0, 0, 1), (0.5, 0.5, 0.5, 1)]])
builder.font.recalcTimestamp = False
builder.font["head"].created = 2082844800
builder.font["head"].modified = 2082844800
builder.save(
    Path(__file__).resolve().parents[1] / "src/render/tests/fixtures/intrinsic-colors.ttf"
)
