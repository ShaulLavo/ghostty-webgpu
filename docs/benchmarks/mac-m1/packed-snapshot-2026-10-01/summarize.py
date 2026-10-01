import json
from pathlib import Path
from statistics import median

root = Path('/work/tmp/plan-283-fix2/corrected')
results = []
for count in [1, 17]:
    for output in ['ascii', 'sgr']:
        for kind in ['before', 'after']:
            analysis = json.loads((root / f'{kind}-{count}-{output}' / 'analysis.json').read_text())
            assert all(row['cpuIntervalQualified'] and not row.get('error') for row in analysis['rows'])
            idle = [q for q in analysis['qualifications'] if q['kind'] == 'idle-display']
            assert len(idle) == 6
            assert all(q['visibility'] == 'visible' and 15 <= q['median'] <= 1000 / 60 * 1.1 for q in idle)
            for variant in ['ghostty-webgpu', 'xterm-webgl']:
                selected = [r for r in analysis['rows'] if r['variant'] == variant]
                controls = sorted([r for r in selected if not r['traced']], key=lambda r: r['repetition'])
                traces = sorted([r for r in selected if r['traced']], key=lambda r: r['repetition'])
                assert [r['repetition'] for r in controls] == [0, 1, 2]
                assert [r['repetition'] for r in traces] == [0, 1, 2]
                for trace in traces:
                    assert len(trace['summary']['byTerminal']) == count
                    for terminal in trace['summary']['byTerminal'].values():
                        assert terminal['frames'] == 181
                        if variant == 'ghostty-webgpu':
                            assert terminal['stateUpdates'] == 181
                            assert terminal['rowsCopied'] == 2172
                            assert terminal['cellsCopied'] == 86880
                            assert terminal['submissions'] == 181
                main = sum(r['mainTaskMilliseconds'] for r in traces)
                snapshot = sum(r['summary']['milliseconds'].get('snapshot', 0) for r in traces)
                instances = sum(r['summary']['milliseconds'].get('instances', 0) for r in traces)
                js = sum(r['summary']['milliseconds'].get('js', 0) for r in traces)
                views = sum((r['sampledLeaves'] or {}).get('get view', 0) for r in traces)
                samples = []
                for row in controls:
                    cpu = row['cpu']
                    elapsed = cpu['milliseconds'] / 1000
                    samples.append({'repetition': row['repetition'],
                                    'rendererCpu': cpu['secondsByType']['renderer'] / elapsed * 100,
                                    'totalCpu': cpu['percentOfOneCore'],
                                    'rendererCpuSeconds': cpu['secondsByType']['renderer'],
                                    'totalCpuSeconds': cpu['percentOfOneCore'] / 100 * elapsed,
                                    'gpuProcessCpu': cpu['secondsByType'].get('GPU', 0) / elapsed * 100,
                                    'cpuIntervalMilliseconds': cpu['milliseconds'],
                                    'operationMilliseconds': row['milliseconds'],
                                    'acquisitionUncertaintyMilliseconds': cpu['acquisitionUncertaintyMilliseconds'],
                                    'latency': row.get('latency')})
                result = {'kind': kind, 'count': count, 'variant': variant, 'output': output,
                          'rendererCpu': median(s['rendererCpu'] for s in samples),
                          'totalCpu': median(s['totalCpu'] for s in samples),
                          'rendererCpuSeconds': median(s['rendererCpuSeconds'] for s in samples),
                          'totalCpuSeconds': median(s['totalCpuSeconds'] for s in samples),
                          'operationMilliseconds': median(s['operationMilliseconds'] for s in samples),
                          'gpuProcessCpu': median(s['gpuProcessCpu'] for s in samples),
                          'snapshotShare': snapshot / main * 100, 'getViewShare': views / main * 100,
                          'instancesShare': instances / main * 100,
                          'snapshotAndInstancesShare': (snapshot + instances) / main * 100,
                          'instancesMilliseconds': instances,
                          'jsMilliseconds': js, 'jsShare': js / main * 100,
                          'snapshotInstancesAndJsMilliseconds': snapshot + instances + js,
                          'snapshotAndInstancesMilliseconds': snapshot + instances,
                          'mainTaskMilliseconds': main, 'snapshotMilliseconds': snapshot,
                          'getViewSampledMilliseconds': views, 'controlRuns': samples,
                          'traceRuns': [{'repetition': r['repetition'],
                                         'mainTaskMilliseconds': r['mainTaskMilliseconds'],
                                         'snapshotMilliseconds': r['summary']['milliseconds'].get('snapshot', 0),
                                         'getViewSampledMilliseconds': (r['sampledLeaves'] or {}).get('get view', 0),
                                         'totalCpu': r['cpu']['percentOfOneCore'],
                                         'cadence': r['frameCadence'], 'ownership': r['summary']['ownership']}
                                        for r in traces]}
                results.append(result)
(root / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
for row in results:
    print(f"{row['kind']:6} {row['count']:2} {row['variant']:14} {row['output']:5} renderer {row['rendererCpu']:6.2f} total {row['totalCpu']:6.2f} snapshot {row['snapshotShare']:6.2f} get-view {row['getViewShare']:6.2f}")
