import csv
import hashlib
import json
import statistics
import sys
from pathlib import Path

from PIL import Image


def total_span(result, operation):
    spans = result['diagnostics']['trace']['spans']
    return sum(span['end'] - span['start'] for span in spans if span['operation'] == operation)


def calls(result, operation):
    spans = result['diagnostics']['trace']['spans']
    return sum(span['operation'] == operation for span in spans)


def screenshot(path):
    with Image.open(path) as image:
        return image.size, hashlib.sha256(image.convert('RGBA').tobytes()).hexdigest()


def pairs(path):
    packet = json.loads(path.read_text())
    indexed = {}
    for result in packet['results']:
        key = result['backend'], result['scenario'], result['repetition']
        indexed.setdefault(key, {})[result['source']] = result
    for key, arms in indexed.items():
        before, after = arms['before'], arms['candidate']
        for field in ['steps', 'writtenBytes', 'outputSha256']:
            assert before[field] == after[field], (path.name, key, field)
        for operation in ['ghostty_terminal_vt_write', 'acknowledge']:
            assert calls(before, operation) == calls(after, operation), (path.name, key, operation)
        assert before['metrics']['submittedFrames'] == after['metrics']['submittedFrames'], (path.name, key, 'submissions')
        images = [path.with_name(f'{path.stem}-{source}-{key[0]}-{key[1]}-{key[2]}.png') for source in ['before', 'candidate']]
        assert screenshot(images[0]) == screenshot(images[1]), (path.name, key, 'pixels')
        row = {
            'packet': path.stem,
            'backend': key[0],
            'scenario': key[1],
            'repetition': key[2],
            'browser': packet['environment']['browser'],
            'steps': before['steps'],
            'parsed_calls': calls(before, 'ghostty_terminal_vt_write'),
            'submitted': before['metrics']['submittedFrames'],
            'presented': 'unmeasured',
            'pixels_equal': True,
        }
        for source, result in [('before', before), ('after', after)]:
            row[f'{source}_callback_ms'] = sum(result['callbackMilliseconds']['samples']) / result['steps']
            row[f'{source}_bridge_ms'] = total_span(result, 'bridge_build_frame') / result['steps']
            row[f'{source}_renderer_ms'] = total_span(result, 'drawFrame') / result['steps']
            row[f'{source}_process_cpu_ms'] = result['cpu']['totalSeconds'] * 1000 / result['steps']
            row[f'{source}_upload_bytes'] = result['metrics']['uploadedBytes'] / result['steps']
        row['renderer_change_percent'] = (row['after_renderer_ms'] / row['before_renderer_ms'] - 1) * 100
        yield row


def main():
    raw = Path(sys.argv[1])
    manifest = raw / 'mac-manifest.json'
    if manifest.exists():
        for name, digest in json.loads(manifest.read_text()).items():
            assert hashlib.sha256((raw / 'mac-results' / name).read_bytes()).hexdigest() == digest, name
    paths = sorted(raw.glob('pc-pilot.json')) + sorted(raw.glob('pc-*-standard.json'))
    paths += sorted(raw.glob('pc-*-ascii.json')) + sorted(raw.glob('pc-*-ntcharts-heatmap.json')) + sorted(raw.glob('pc-*-opentui-plasma.json'))
    paths += sorted((raw / 'mac-results').glob('mac-*.json'))
    paths = [path for path in paths if not path.name.endswith('-availability.json') and (path.name == 'pc-pilot.json' or path.with_suffix('.done').exists())]
    rows = [row for path in paths for row in pairs(path)]
    assert rows
    with open(raw / 'pairs.csv', 'w') as target:
        writer = csv.DictWriter(target, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    grouped = {}
    for row in rows:
        key = row['packet'], row['backend'], row['scenario']
        grouped.setdefault(key, []).append(row)
    summary = []
    for key, entries in grouped.items():
        record = dict(zip(['packet', 'backend', 'scenario'], key))
        for field in rows[0]:
            if field.startswith(('before_', 'after_')):
                record[field] = statistics.mean(entry[field] for entry in entries)
        record['renderer_change_percent'] = (record['after_renderer_ms'] / record['before_renderer_ms'] - 1) * 100
        summary.append(record)
    (raw / 'summary.json').write_text(json.dumps({'pairs': len(rows), 'all_pixels_equal': True, 'all_text_equal': True, 'all_parse_ack_submission_counts_equal': True, 'presentation': 'unmeasured; screenshots prove content only', 'results': summary}, indent=2) + '\n')
    print(f'{len(paths)} packets, {len(rows)} pairs; exact pixels, text, parser, acknowledgement and submission counts match')
    for row in summary:
        if row['backend'] == 'webgl2' and row['scenario'] == 'sustained-scroll':
            print(row['packet'], round(row['before_renderer_ms'], 4), round(row['after_renderer_ms'], 4), round(row['renderer_change_percent'], 1))


if __name__ == '__main__':
    main()
