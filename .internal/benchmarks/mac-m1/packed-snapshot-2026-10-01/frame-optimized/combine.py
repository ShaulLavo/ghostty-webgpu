import hashlib
import json
import shutil
from pathlib import Path

# NOT-PORTABLE: Default input requires external raw captures under /work/tmp/plan-283-fix2.
root = Path('/work/tmp/plan-283-fix2/frame-optimized')
for count in [17]:
    for phase in ['ascii', 'sgr']:
        windows = json.loads((root / f'{count}-{phase}-windows.json').read_text())
        assert len(windows) == 6
        for kind in ['before', 'after']:
            selected = sorted([w for w in windows if w['kind'] == kind], key=lambda w: w['repetition'])
            assert [w['repetition'] for w in selected] == [0, 1, 2]
            parts = [json.loads((root / w['directory'] / 'comparison.json').read_text()) for w in selected]
            manifests = [p['manifest'] for p in parts]
            assert manifests[0] == manifests[1] == manifests[2]
            assert all(not p.get('invalid') and not p.get('error') and p.get('finishedAt') for p in parts)
            assert all(p['traceCounts'] == [count] and p['tracePhases'] == [phase] and p['traceFrames'] == 180 for p in parts)
            combined = dict(parts[0])
            combined['runs'] = [r for p in parts for r in p['runs']]
            combined['qualifications'] = [q for p in parts for q in p['qualifications']]
            combined['startedAt'] = min(p['startedAt'] for p in parts)
            combined['finishedAt'] = max(p['finishedAt'] for p in parts)
            combined['environment'] = dict(combined['environment'])
            args = combined['environment']['arguments']
            index = args.index('--only-repetition')
            combined['environment']['arguments'] = args[:index] + args[index + 2:]
            combined['sourceWindows'] = [
                {'directory': w['directory'], 'repetition': w['repetition'], 'attempt': w['attempt'],
                 'startedAt': p['startedAt'], 'finishedAt': p['finishedAt'],
                 'arguments': p['environment']['arguments'],
                 'comparisonSha256': hashlib.sha256((root / w['directory'] / 'comparison.json').read_bytes()).hexdigest()}
                for w, p in zip(selected, parts)
            ]
            destination = root / f'{kind}-{count}-{phase}'
            destination.mkdir(exist_ok=True)
            for w in selected:
                directory = root / w['directory']
                for source in directory.glob('*.trace.json.gz'):
                    assert not (destination / source.name).exists()
                    shutil.copy2(source, destination / source.name)
                for source in directory.glob('*.png'):
                    shutil.copy2(source, destination / source.name)
            for index, run in enumerate(combined['runs']):
                run['executionOrder'] = index
            (destination / 'comparison.json').write_text(json.dumps(combined, indent=2) + '\n')
            print(destination)
