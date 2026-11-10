"""Regenerate or check the Canvas ZWJ fixture from Twemoji Mozilla 0.7.0.

Requires fontTools 4.66.1. See src/render/canvas/tests/zwj-emoji.provenance.md.
Browser tests use the committed subset and need no Python installation.
"""

import argparse
import hashlib
from io import BytesIO
from pathlib import Path

from fontTools import __version__, subset

SOURCE_SHA256 = "6d90152ee0d29e82fe2a87793af5aa4b7ad13e6538360889e141e81ed299ee8e"
OUTPUT = Path(__file__).resolve().parents[1] / "src/render/canvas/tests/zwj-emoji.ttf"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path, help="Twemoji.Mozilla.ttf from release v0.7.0")
parser.add_argument("--check", action="store_true", help="Check committed bytes without writing")
args = parser.parse_args()
if __version__ != "4.66.1":
    parser.error("Regeneration requires fontTools 4.66.1")
source = args.source.read_bytes()
if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
    parser.error("Source does not match Twemoji Mozilla 0.7.0")

options = subset.Options()
options.recalc_timestamp = False
options.harfbuzz_repacker = False
options.drop_tables.append("FFTM")
font = subset.load_font(BytesIO(source), options)
subsetter = subset.Subsetter(options=options)
subsetter.populate(text="👩‍💻👨‍👩‍👧‍👦😀")
subsetter.subset(font)
result = BytesIO()
subset.save_font(font, result, options)
data = result.getvalue()
if args.check:
    if OUTPUT.read_bytes() != data:
        parser.error("Committed Canvas ZWJ fixture differs from the generated subset")
else:
    OUTPUT.write_bytes(data)
print(f"Canvas ZWJ fixture: {len(data)} bytes, SHA-256 {hashlib.sha256(data).hexdigest()}")
