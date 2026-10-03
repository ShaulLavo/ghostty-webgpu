"""Regenerate the checked-in browser fixture from a Noto Color Emoji font.

Requires fontTools. Run with the path to an OFL-licensed NotoColorEmoji.ttf.
The browser tests use the committed subset and need no Python installation.
"""

import sys
from pathlib import Path

from fontTools import subset

options = subset.Options()
options.recalc_timestamp = False
font = subset.load_font(sys.argv[1], options)
subsetter = subset.Subsetter(options=options)
subsetter.populate(text="👩‍💻👨‍👩‍👧‍👦😀")
subsetter.subset(font)
subset.save_font(
    font,
    str(Path(__file__).resolve().parents[1] / "src/render/canvas/tests/zwj-emoji.ttf"),
    options,
)
