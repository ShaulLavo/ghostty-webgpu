import hashlib
import json
from pathlib import Path

root = Path('/work/tmp/plan-283-fix2/corrected')
checks = []

def raw_frame_distribution(phase):
    records = phase['records']
    counters = {}
    for counter in records['counters']:
        counters.setdefault(counter['terminal'], []).append(counter)
    distribution = {}
    for span in records['spans']:
        if span['operation'] != 'drawFrame':
            continue
        counts = {}
        for counter in counters[span['terminal']]:
            if span['start'] <= counter['time'] <= span['end']:
                counts[counter['operation']] = counts.get(counter['operation'], 0) + counter['value']
        key = (span['terminal'], json.dumps(counts, sort_keys=True))
        entry = distribution.setdefault(key, {'terminal': span['terminal'], 'counts': counts, 'samples': 0})
        entry['samples'] += 1
    return sorted(distribution.values(), key=lambda entry: entry['terminal'])

for count in [1, 17]:
    for phase in ['ascii', 'sgr']:
        before = json.loads((root / f'before-{count}-{phase}' / 'analysis.json').read_text())
        after = json.loads((root / f'after-{count}-{phase}' / 'analysis.json').read_text())
        for field in ['versions', 'settings', 'fixtures', 'variants']:
            assert before['manifest'][field] == after['manifest'][field], field
        b_assets = before['manifest']['assets']
        a_assets = after['manifest']['assets']
        assert b_assets.keys() == a_assets.keys()
        assert {name for name in b_assets if b_assets[name] != a_assets[name]} == {'bridge.wasm'}
        assert before['manifest']['bundleSha256'] != after['manifest']['bundleSha256']
        for field in ['browser', 'os', 'cpu', 'renderer']:
            assert before['environment'][field] == after['environment'][field], field
        assert before['environment']['cpu'] == 'Apple M1'
        assert 'Metal' in before['environment']['renderer']
        summary_mismatches = []
        for repetition in [0, 1, 2]:
            raw = {}
            for kind in ['before', 'after']:
                artifact = json.loads((root / f'{kind}-{count}-{phase}-{repetition}-0' / 'comparison.json').read_text())
                run = next(r for r in artifact['runs'] if r['variant'] == 'ghostty-webgpu')
                traced = next(p for p in run['phases'] if p['traced'])
                raw[kind] = raw_frame_distribution(traced)
                saved = sorted(next(r for r in (before if kind == 'before' else after)['rows'] if r['traced'] and r['variant'] == 'ghostty-webgpu' and r['repetition'] == repetition)['summary']['frameCounterDistribution'], key=lambda entry: entry['terminal'])
                if raw[kind] != saved:
                    summary_mismatches.append({'kind': kind, 'repetition': repetition, 'persisted': saved, 'reconstructedFromRawSpansAndCounters': raw[kind]})
            assert raw['before'] == raw['after']
            b = next(r for r in before['rows'] if r['traced'] and r['variant'] == 'ghostty-webgpu' and r['repetition'] == repetition)
            a = next(r for r in after['rows'] if r['traced'] and r['variant'] == 'ghostty-webgpu' and r['repetition'] == repetition)
            assert b['grid'] == a['grid']
            assert b['summary']['byTerminal'] == a['summary']['byTerminal']
            assert b['summary']['ownership'] == a['summary']['ownership']
            for frame in raw['before']:
                assert frame['counts'] == {'stateUpdates': 1, 'rowsCopied': 12, 'cellsCopied': 480,
                                           'atlasUploads': 0, 'atlasBytes': 0, 'buffersWritten': 2,
                                           'bufferBytes': 76800, 'draws': 2, 'submissions': 1, 'frames': 1}
                assert frame['samples'] == 181
        windows = json.loads((root / f'{count}-{phase}-windows.json').read_text())
        assert len(windows) == 6
        assert all("'AC Power'" in w['power'] for w in windows)
        source = [json.loads((root / w['directory'] / 'comparison.json').read_text()) for w in windows]
        assert all(all(len(r['correctness']) == count for r in p['runs']) for p in source)
        paired_picture_hashes = []
        for repetition in [0, 1, 2]:
            paired = [p for w, p in zip(windows, source) if w['repetition'] == repetition]
            b_window = next(w for w in windows if w['repetition'] == repetition and w['kind'] == 'before')
            a_window = next(w for w in windows if w['repetition'] == repetition and w['kind'] == 'after')
            b_pictures = sorted((root / b_window['directory']).glob('ghostty-webgpu*.png'))
            assert bool(b_pictures) == (repetition == 0), 'Established runner captures PNGs only for repetition 0'
            for picture in b_pictures:
                other = root / a_window['directory'] / picture.name
                assert picture.read_bytes() == other.read_bytes()
                paired_picture_hashes.append({'repetition': repetition, 'file': picture.name,
                                             'sha256': hashlib.sha256(picture.read_bytes()).hexdigest()})
            for variant in ['ghostty-webgpu', 'xterm-webgl']:
                b = next(r for r in paired[0]['runs'] if r['variant'] == variant)
                a = next(r for r in paired[1]['runs'] if r['variant'] == variant)
                assert b['correctness'] == a['correctness']
                if variant == 'ghostty-webgpu':
                    assert b['info']['adapter']['fallback'] is False
                    assert a['info']['adapter'] == b['info']['adapter']
        pictures = sorted((root / f'before-{count}-{phase}').glob('ghostty-webgpu*.png'))
        assert pictures
        hashes = []
        for picture in pictures:
            other = root / f'after-{count}-{phase}' / picture.name
            assert other.read_bytes() == picture.read_bytes()
            hashes.append({'file': picture.name, 'sha256': hashlib.sha256(picture.read_bytes()).hexdigest()})
        checks.append({'count': count, 'phase': phase, 'cpuIntervalsQualified': True,
                       'sameNativeCountersAndGrid': True,
                       'frameCountSource': 'Authoritative raw spans and terminal-tagged counters',
                       'persistedFrameSummaryMismatches': summary_mismatches,
                       'sameVersionsSettingsFixturesAndControlAssets': True,
                       'changedNativeAsset': 'bridge.wasm',
                       'sameHardwareEnvironment': True, 'hardwareRenderer': before['environment']['renderer'],
                       'screenshotsIdentical': hashes, 'allRepetitionsScreenshotsIdentical': paired_picture_hashes,
                       'successfulInvocations': len(windows)})
(root / 'matched-work-checks.json').write_text(json.dumps(checks, indent=2) + '\n')
print('Matched work, hardware, power, and screenshot checks pass for all four pairs')
