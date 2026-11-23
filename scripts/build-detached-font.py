from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


def detached():
    # A short base and a mark far above the ascent, with clear space between them.
    pen = TTGlyphPen(None)
    for bottom, top in ((0, 400), (1520, 1620)):
        pen.moveTo((100, bottom))
        pen.lineTo((500, bottom))
        pen.lineTo((500, top))
        pen.lineTo((100, top))
        pen.closePath()
    return pen.glyph()


builder = FontBuilder(1000, isTTF=True)
glyphs = [".notdef", "detached"]
builder.setupGlyphOrder(glyphs)
builder.setupCharacterMap({ord("D"): "detached"})
builder.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "detached": detached()})
builder.setupHorizontalMetrics({name: (600, 100) for name in glyphs})
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupNameTable(
    {
        "familyName": "Detached Contour",
        "styleName": "Regular",
        "psName": "DetachedContour-Regular",
    }
)
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
builder.font.recalcTimestamp = False
builder.font["head"].created = 2082844800
builder.font["head"].modified = 2082844800
builder.save(
    Path(__file__).resolve().parents[1] / "src/render/tests/fixtures/detached-contour.ttf"
)
