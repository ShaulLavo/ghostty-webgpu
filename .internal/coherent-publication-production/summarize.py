import json
import statistics
import sys
from collections import defaultdict

def metric(row, field):
    if field == 'rendererMs':
        return row['rendererCpu'] * row['elapsedMs'] / row['frames'] / 100
    if field == 'gpuMs':
        return row['gpuCpu'] * row['elapsedMs'] / row['frames'] / 100
    if field == 'jsHeapMiB':
        return row['jsHeapUsed'] / 1048576
    if field == 'wasmMiB':
        return row['wasmBytes'] / 1048576
    return row[field]


for path in sys.argv[1:]:
    packet = json.load(open(path))
    cells = defaultdict(lambda: defaultdict(list))
    for row in packet['results']:
        key = tuple(row[name] for name in ('backend', 'count', 'workload', 'observers', 'parity', 'discard'))
        cells[key][row['arm']].append(row)
    print(path, packet['sources'], packet['browserVersion'])
    for key, arms in cells.items():
        result = {}
        for field in ('rendererMs', 'gpuMs', 'scriptMs', 'taskMs', 'jsHeapMiB', 'wasmMiB'):
            values = []
            for arm in ('before', 'after'):
                values.append(statistics.median(metric(row, field) for row in arms[arm]))
            result[field] = [round(value, 4) for value in values]
        print(json.dumps({'cell': key, **result}))
