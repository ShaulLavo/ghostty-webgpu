import collections
import gzip
import json
from pathlib import Path

# NOT-PORTABLE: Default input requires external raw captures under /work/tmp/plan-283-fix2.
root = Path('/work/tmp/plan-283-fix2/frame-optimized')
results = []
for kind in ['before', 'after']:
    directory = root / f'{kind}-17-ascii'
    artifact = json.loads((directory / 'comparison.json').read_text())
    analysis = json.loads((directory / 'analysis.json').read_text())
    for run in artifact['runs']:
        if run['variant'] != 'ghostty-webgpu':
            continue
        phase = next(p for p in run['phases'] if p['traced'])
        events = json.loads(gzip.decompress((directory / phase['trace']).read_bytes()))['traceEvents']
        begin = next(e for e in events if e['name'] == 'compare/begin')
        profile = next(e for e in events if e['name'] == 'Profile' and e['pid'] == begin['pid'] and e['tid'] == begin['tid'])
        chunks = sorted((e for e in events if e['name'] == 'ProfileChunk' and e['pid'] == begin['pid'] and e['id'] == profile['id']), key=lambda e: e['ts'])
        nodes = {}
        parents = {}
        for chunk in chunks:
            for node in chunk['args']['data'].get('cpuProfile', {}).get('nodes', []):
                nodes[node['id']] = node
                if 'parent' in node:
                    parents[node['id']] = node['parent']
                for child in node.get('children', []):
                    parents[child] = node['id']
        offset = begin['ts'] / 1000 - begin['args']['data']['startTime']
        start = next(m['time'] for m in phase['records']['markers'] if m['operation'] == 'begin') + offset
        end = next(m['time'] for m in phase['records']['markers'] if m['operation'] == 'end') + offset
        time = profile['args']['data']['startTime'] / 1000
        leaves = collections.defaultdict(float)
        inclusive = collections.defaultdict(float)
        copied = collections.defaultdict(float)
        for chunk in chunks:
            data = chunk['args']['data']
            for i, node_id in enumerate(data.get('cpuProfile', {}).get('samples', [])):
                previous = time
                time += data['timeDeltas'][i] / 1000
                duration = max(0, min(end, time) - max(start, previous))
                if not duration:
                    continue
                leaf = nodes.get(node_id, {}).get('callFrame', {}).get('functionName', '(unknown)')
                leaves[leaf] += duration
                names = set()
                seen = set()
                while node_id in nodes and node_id not in seen:
                    seen.add(node_id)
                    names.add(nodes[node_id].get('callFrame', {}).get('functionName', '(unknown)'))
                    node_id = parents.get(node_id)
                for name in names:
                    inclusive[name] += duration
                if any(name.startswith('copiedFrameRow') for name in names):
                    copied[leaf] += duration
        row = next(r for r in analysis['rows'] if r['variant'] == 'ghostty-webgpu' and r['traced'] and r['repetition'] == run['repetition'])
        expected = row['sampledLeaves']
        assert all(abs(leaves.get(name, 0) - value) < 0.0001 for name, value in expected.items())
        result = {'kind': kind, 'repetition': run['repetition'], 'trace': phase['trace'],
                  'mainTaskMilliseconds': row['mainTaskMilliseconds'],
                  'copiedFrameInclusiveMilliseconds': sum(copied.values()),
                  'copiedFrameLeavesMilliseconds': dict(sorted(copied.items(), key=lambda item: -item[1])),
                  'targetInclusiveMilliseconds': {name: value for name, value in inclusive.items() if name.startswith('copiedFrameRow') or name in ['materialize', 'get cells', 'emptyRenderCell', '(garbage collector)', 'linkFrameSignature']},
                  'garbageCollectorLeafMilliseconds': leaves.get('(garbage collector)', 0),
                  'allocationAttribution': 'CPU samples measure work, not allocation bytes. GC leaf samples cannot be assigned to a prior allocating function.'}
        results.append(result)
        print(kind, run['repetition'], json.dumps(result))
(root / 'frame-profile.json').write_text(json.dumps(results, indent=2) + '\n')
