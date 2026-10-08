"""Run unmodified esctest2 test bodies over a JSON-line browser adapter.

The upstream checkout is a runtime input. No upstream source is vendored.
"""
import importlib.util
import json
import re
from pathlib import Path
import sys

SUITES = (
    "cuu", "cud", "cuf", "cup", "cha", "cnl", "cpl", "ed", "el", "ech",
    "ich", "dch", "il", "dl", "tbc", "cht", "cbt", "su", "sd", "rep",
    "cr", "lf",
)


def rpc(message):
    print(json.dumps(message), flush=True)
    response = json.loads(sys.stdin.readline())
    if "error" in response:
        raise RuntimeError(response["error"])
    return response.get("value")


root = Path(sys.argv[1]) / "esctest"
sys.path.insert(0, str(root))
import escargs
import esc
import escio
import esccmd
import escutil
from esctypes import Size

escargs.args = escargs.parser.parse_args([])
escargs.args.expected_terminal = "browser"
escargs.args.xterm_checksum = 334
escargs.args.xterm_reverse_wrap = 383
escargs.args.v = 0
esc.vtLevel = 5


def write(text, sideChannelOk=True):
    rpc({"op": "write", "bytes": list(text.encode("utf-8"))})


reply_offset = 0


def read_csi(expected_final, expected_prefix=None):
    global reply_offset
    replies = rpc({"op": "screen"})["replies"]
    pending = replies[reply_offset:]
    prefix = expected_prefix or ""
    match = re.match(r"\x1b\[" + re.escape(prefix) + r"([0-9;]*)" + re.escape(expected_final), pending)
    if match is None:
        raise RuntimeError("Missing or unexpected CSI reply: " + repr(pending))
    reply_offset += match.end()
    return [int(value) if value else None for value in match.group(1).split(";")]


def assert_rect(rect, expected_lines):
    escutil.gHaveAsserted = True
    cells = rpc({"op": "screen"})["cells"]
    actual = ["".join(row[rect.left() - 1:rect.right()])
              for row in cells[rect.top() - 1:rect.bottom()]]
    # These APIs expose empty cells as spaces. Upstream's checksum oracle can
    # distinguish NUL from space; this adapter deliberately cannot.
    expected = [line.replace("\x00", " ") for line in expected_lines]
    escutil.AssertEQ(actual, expected)


escio.Write = write
escio.ReadCSI = read_csi
escutil.GetScreenSize = lambda: Size(80, 24)
escutil.AssertScreenCharsInRectEqual = assert_rect

for suite in SUITES:
    spec = importlib.util.spec_from_file_location(suite, root / "tests" / (suite + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    classes = [value for value in vars(module).values()
               if isinstance(value, type) and value.__module__ == suite]
    assert len(classes) == 1, "Pinned suite must have one test class"
    cls = classes[0]
    for name in sorted(name for name in dir(cls) if name.startswith("test_")):
        rpc({"op": "reset", "variant": sys.argv[2], "suite": suite})
        reply_offset = 0
        escio.use8BitControls = False
        esc.vtLevel = 5
        escutil.gHaveAsserted = False
        status = "pass"
        detail = ""
        try:
            getattr(cls(), name)()
            if not escutil.gHaveAsserted:
                raise RuntimeError("Test completed without an assertion")
        except Exception as error:
            status = "fail"
            detail = type(error).__name__ + ": " + str(error)
        rpc({"op": "result", "suite": suite, "name": name,
             "status": status, "detail": detail})
