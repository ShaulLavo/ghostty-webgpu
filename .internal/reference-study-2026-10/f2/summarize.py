import json
import statistics
import csv
import ijson
import sys
from pathlib import Path

root = Path(sys.argv[1])


def median(records, source, backend):
    rows = [r for r in records if r["source"] == source and r["backend"] == backend]
    return statistics.median(r["cpu"]["percentOfOneCore"] for r in rows)


def compact(row):
    trace = row.pop("diagnostics")["trace"]
    row["parsedCalls"] = sum(span["operation"] == "ghostty_terminal_vt_write" for span in trace["spans"])
    row["acknowledgements"] = sum(span["operation"] == "acknowledge" for span in trace["spans"])
    row.pop("info", None)
    return row


def summary(path):
    with path.open("rb") as source:
        records = [compact(row) for row in ijson.items(source, "results.item", use_float=True)]
    groups = {}
    for row in records:
        key = row["backend"], row["scenario"], row["repetition"]
        groups.setdefault(key, {})[row["source"]] = row
    for key, pair in groups.items():
        if set(pair) != {"before", "candidate"}:
            raise ValueError((path.name, key, "unpaired"))
        before, after = pair["before"], pair["candidate"]
        for field in ["outputSha256", "writtenBytes", "steps"]:
            assert before[field] == after[field], (path.name, key, field)
        assert before["writeMilliseconds"]["count"] == after["writeMilliseconds"]["count"]
        assert before["pendingFrames"] == after["pendingFrames"] == 0
        assert before["parsedCalls"] == after["parsedCalls"], (path.name, key, "parsed calls")
        assert before["acknowledgements"] == after["acknowledgements"], (path.name, key, "acknowledgements")
    output = []
    for scenario in sorted({r["scenario"] for r in records}):
        scenario_records = [r for r in records if r["scenario"] == scenario]
        before = median(scenario_records, "before", "webgpu")
        after = median(scenario_records, "candidate", "webgpu")
        webgl = median(scenario_records, "candidate", "webgl2")
        output.append({
            "case": path.stem, "scenario": scenario,
            "webgpuBeforeCpu": before, "webgpuAfterCpu": after,
            "reductionPercent": 100 * (before - after) / before,
            "webglAfterCpu": webgl, "webgpuExcessPercent": 100 * (after - webgl) / webgl,
            "counts": [{k: r[k] for k in ["source", "backend", "repetition", "steps", "writtenBytes", "metrics", "acknowledgements"]} for r in scenario_records],
            "parsedCalls": [{"source": r["source"], "backend": r["backend"], "repetition": r["repetition"], "count": r["parsedCalls"]} for r in scenario_records],
            "presentedUpdates": None,
        })
    return output


rows = []
for path in sorted(root.rglob("*.json")):
    if not path.name.startswith(("pc-", "mac-")) or path.name.endswith("cleanup.json"):
        continue
    rows.extend(summary(path))
(root / "summary.json").write_text(json.dumps(rows, indent=2) + "\n")
with (root / "summary.csv").open("w") as target:
    fields = ["case", "scenario", "webgpuBeforeCpu", "webgpuAfterCpu", "reductionPercent", "webglAfterCpu", "webgpuExcessPercent", "presentedUpdates"]
    writer = csv.DictWriter(target, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
for row in rows:
    print(row["case"], row["scenario"], "WebGPU %.2f -> %.2f, %.1f%% less; WebGL %.2f; GPU excess %.1f%%" % (
        row["webgpuBeforeCpu"], row["webgpuAfterCpu"], row["reductionPercent"], row["webglAfterCpu"], row["webgpuExcessPercent"]))

from PIL import Image
compared = 0
for candidate in sorted(root.rglob("*-candidate-*.png")):
    before = candidate.with_name(candidate.name.replace("-candidate-", "-before-"))
    assert before.exists(), candidate
    left, right = Image.open(before).convert("RGBA"), Image.open(candidate).convert("RGBA")
    assert left.size == right.size, candidate
    assert left.tobytes() == right.tobytes(), candidate
    compared += 1
print("Identical screenshot pairs:", compared)
