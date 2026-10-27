# Summarizes X7 hardware pairs: median per cell and after/before ratio, with each pair's digest check.
import json, statistics, sys
from collections import defaultdict

data = json.load(open(sys.argv[1]))
cells = defaultdict(lambda: defaultdict(list))
for row in data['results']:
    key = (row['backend'], row['count'], row['workload'], row['observers'])
    cells[key][row['arm']].append(row)
metrics = ['rendererCpu', 'gpuCpu', 'scriptMs', 'taskMs', 'jsHeapUsed', 'wasmBytes']
print('| backend | n | workload | observers | ' + ' | '.join(f'{m} before → after' for m in metrics) + ' | frames | digests |')
print('|' + ' --- |' * (6 + len(metrics)))
for key in sorted(cells):
    arms = cells[key]
    if 'before' not in arms or 'after' not in arms:
        continue
    out = []
    for m in metrics:
        b = statistics.median(r[m] for r in arms['before'])
        a = statistics.median(r[m] for r in arms['after'])
        if m == 'jsHeapUsed':
            out.append(f'{b / 1e6:.2f} → {a / 1e6:.2f} MB')
        elif m == 'wasmBytes':
            out.append(f'{b / 1048576:.1f} → {a / 1048576:.1f} MiB')
        else:
            out.append(f'{b:.2f} → {a:.2f}')
    frames = '/'.join(str(r['frames']) for r in arms['before'] + arms['after'])
    same = all(r['digest'] == arms['before'][0]['digest'] for r in arms['before'] + arms['after'])
    print(f'| {key[0]} | {key[1]} | {key[2]} | {key[3]} | ' + ' | '.join(out) + f' | {frames} | {"equal" if same else "DIFFER"} |')
