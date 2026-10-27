import collections
import gzip
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])


def analyze(path):
    data = json.loads(gzip.decompress(path.read_bytes()))
    events = data["traceEvents"]
    processes = {e["pid"]: e.get("args", {}).get("name", "") for e in events if e.get("name") == "process_name"}
    threads = {(e["pid"], e["tid"]): e.get("args", {}).get("name", "") for e in events if e.get("name") == "thread_name"}
    pids = {pid for pid, name in processes.items() if re.search("gpu", name, re.I)}
    pids.update(pid for (pid, tid), name in threads.items() if "CrGpuMain" in name)
    timings = collections.Counter()
    counts = collections.Counter()
    cpu_timings = collections.Counter()
    by_thread = collections.Counter()
    for event in events:
        if event.get("pid") not in pids or event.get("ph") != "X":
            continue
        name = event.get("name", "")
        timing = event.get("dur", 0) / 1000
        timings[name] += timing
        cpu_timings[name] += event.get("tdur", 0) / 1000
        counts[name] += 1
        by_thread[threads.get((event["pid"], event["tid"]), str(event["tid"]))] += timing
    return {
        "trace": path.name,
        "gpuProcesses": {pid: processes.get(pid) for pid in pids},
        "threadInclusiveMilliseconds": dict(by_thread),
        "largestInclusiveScopes": [{"name": name, "milliseconds": value, "threadCpuMilliseconds": cpu_timings[name], "count": counts[name]} for name, value in timings.most_common(25)],
        "dawnCommandPresentationScopes": [{"name": name, "milliseconds": value, "threadCpuMilliseconds": cpu_timings[name], "count": counts[name]} for name, value in timings.most_common() if re.search("dawn|webgpu|decoder|commandbuffer|swap|present|metal", name, re.I)],
    }


paths = [path for path in sorted(root.rglob("*.trace.json.gz")) if "gpu-attribution" in path.name or "ascii-attribution" in path.name]
results = [analyze(path) for path in paths]
(root / "gpu-attribution-summary.json").write_text(json.dumps(results, indent=2) + "\n")
for result in results:
    print(result["trace"], result["gpuProcesses"])
    for scope in result["largestInclusiveScopes"][:8]:
        print("  %.2f ms %s (%d)" % (scope["milliseconds"], scope["name"], scope["count"]))
