import csv
import hashlib
import json
import sys
from collections import defaultdict
from pathlib import Path

RAW = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent
ALIASES = {
    'burst-output': 'rolling-logs',
    'sustained-scroll': 'viewport-scroll',
    'cursor-movement': 'cursor',
}


def quantile(values, fraction):
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * fraction))] if values else None


def trace_for(record):
    hosted = record['diagnostics'].get('hosted') or []
    if hosted and hosted[0] and hosted[0].get('trace'):
        return hosted[0]['trace']
    return record['diagnostics'].get('trace')


def summarize(records):
    operations = defaultdict(float)
    categories = defaultdict(float)
    parses = 0
    for record in records:
        trace = trace_for(record) or {'spans': []}
        for span in trace['spans']:
            operations[span['operation']] += span['self']
            categories[span['category']] += span['self']
            parses += span['operation'] == 'ghostty_terminal_vt_write'
    updates = sum(record['steps'] for record in records)
    elapsed = sum(record['cpu']['totalSeconds'] / (record['cpu']['percentOfOneCore'] / 100) if record['cpu']['percentOfOneCore'] else record['elapsedMilliseconds'] / 1000 for record in records)
    cpu = defaultdict(float)
    for record in records:
        for kind, seconds in record['cpu']['secondsByProcessType'].items():
            cpu[kind] += seconds
    metric = lambda name: sum(record['metrics'].get(name, 0) for record in records)
    return {
        'samples': len(records),
        'updates': updates,
        'parsed_calls': parses,
        'submitted_frames': metric('submittedFrames'),
        'presented_updates': None,
        'parse_ms_per_update': operations['ghostty_terminal_vt_write'] / updates,
        'bridge_ms_per_update': operations['bridge_build_frame'] / updates,
        'raster_ms_per_update': (operations['rasterize'] + operations['rasterizeUncached']) / updates,
        'upload_cpu_ms_per_update': categories['upload'] / updates,
        'encode_submit_cpu_ms_per_update': categories['commands'] / updates,
        'buffer_bytes_per_update': metric('uploadedBytes') / updates,
        'atlas_bytes_per_update': metric('atlasUploadedBytes') / updates,
        'renderer_cpu_percent': 100 * cpu['renderer'] / elapsed,
        'gpu_process_cpu_percent': 100 * cpu['GPU'] / elapsed,
        'all_chrome_cpu_percent': 100 * sum(cpu.values()) / elapsed,
        'write_ack_p95_ms': quantile([sample for record in records for sample in record['diagnostics']['writeCompletions']], .95),
        'output_hashes': sorted(set(record['outputSha256'] for record in records)),
    }


def rows_for(path, packet):
    grouped = defaultdict(list)
    for record in packet['results']:
        scenario = record['scenario']
        workload = Path(record['workload']).name if record.get('workload') else ALIASES.get(scenario, scenario)
        key = (record['backend'], workload, record['info']['columns'], record['info']['rows'])
        grouped[key].append(record)
    rows = []
    for (backend, workload, columns, rows_count), records in grouped.items():
        rows.append({'file': str(path.relative_to(RAW)), 'host': path.name.split('-')[0], 'backend': backend, 'workload': workload, 'grid': f'{columns}x{rows_count}', **summarize(records)})
    return rows


def energy_rows(path, packet):
    rows = []
    for record in packet['results']:
        work = (record.get('nativeCpu') or {}).get('workCounters')
        if not work:
            continue
        workload = Path(record['workload']).name if record.get('workload') else ALIASES.get(record['scenario'], record['scenario'])
        for family, channel in work.get('channels', {}).items():
            rows.append({'file': str(path.relative_to(RAW)), 'backend': record['backend'], 'grid': f"{record['info']['columns']}x{record['info']['rows']}", 'workload': workload, 'repetition': record['repetition'], 'family': family, 'status': work['status'], 'energy_j': channel['energyJ'], 'instructions': channel['instructions'], 'cpu_seconds': channel['cpuSeconds']})
    return rows


def write_csv(name, rows):
    if not rows:
        return
    with (OUT / name).open('w') as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)


packets = []
invalid_packets = []
for path in sorted(RAW.glob('**/*.json')):
    if 'comparison-bundle' in path.parts:
        continue
    try:
        packet = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        invalid_packets.append({'file': str(path.relative_to(RAW)), 'error': str(error)})
        continue
    if isinstance(packet, dict) and packet.get('results') and packet.get('sourceArtifacts'):
        packets.append((path, packet))

baseline = []
energy = []
completion = []
hosted = []
controls = []
heaps = []
environment = {}
for path, packet in packets:
    host = path.name.split('-')[0]
    environment.setdefault(host, {'browser': packet['environment']['browser'], 'os': packet['environment']['os'], 'release': packet['environment']['release'], 'gpu': packet['environment']['gpuInfo']['gpu'], 'source': packet['sourceArtifacts'][0]})
    name = path.stem
    if '-energy' in name:
        energy.extend(energy_rows(path, packet))
    elif any(name == f'{host}-{grid}-{workload}' for grid in ['200x50', '80x24'] for workload in ['stages', 'ascii', 'ntcharts-heatmap', 'opentui-plasma']):
        baseline.extend(rows_for(path, packet))
    elif '-hosted-' in name:
        hosted.extend(rows_for(path, packet))
    elif name.endswith('-overhead'):
        for record in packet['results']:
            controls.append({'host': host, 'backend': record['backend'], 'workload': ALIASES.get(record['scenario'], record['scenario']), 'traced': record['repetition'] in [1, 2], 'repetition': record['repetition'], 'cpu_percent': record['cpu']['percentOfOneCore'], 'callback_sum_ms': sum(record['callbackMilliseconds']['samples'])})
    for record in packet['results']:
        samples = record['diagnostics'].get('completions') or []
        gpu = [value / 1e6 for sample in samples for value in sample.get('gpuNanoseconds', [])]
        if samples:
            completion.append({'file': str(path.relative_to(RAW)), 'host': host, 'workload': Path(record['workload']).name if record.get('workload') else ALIASES.get(record['scenario'], record['scenario']), 'repetition': record['repetition'], 'endpoint': samples[0]['endpoint'], 'samples': len(samples), 'completion_p50_ms': quantile([sample['milliseconds'] for sample in samples], .5), 'completion_p95_ms': quantile([sample['milliseconds'] for sample in samples], .95), 'gpu_pass_p50_ms': quantile(gpu, .5), 'gpu_pass_p95_ms': quantile(gpu, .95)})
        for heap in record.get('workerHeaps', []):
            heaps.append({'file': str(path.relative_to(RAW)), 'host': host, 'workload': record['scenario'], 'worker_url': heap['target']['url'], 'response': heap.get('heap'), 'error': heap.get('error')})

assert len(baseline) == 80, f'Expected 80 host/backend/grid/workload rows, got {len(baseline)}'
assert all(row['samples'] == 2 and row['updates'] == 120 for row in baseline)
assert all(row['energy_j'] is not None and row['instructions'] is not None for row in energy)
assert len(energy) == 400, f'Expected 400 Mac energy family rows, got {len(energy)}'
parity = defaultdict(set)
for row in baseline:
    parity[(row['host'], row['grid'], row['workload'])].add(tuple(row['output_hashes']))
assert all(len(values) == 1 for values in parity.values()), 'Backend terminal-text mismatch'
def summarize_check_case(record):
    latency = record.get('latency', {})
    presentation = latency.get('presentation', {})
    samples = latency.get('phase', {}).get('sample', {})
    backlog = record.get('backlog', {})
    keys = [key['acknowledged'] - key['started'] for key in backlog.get('keys', []) if key]
    return {
        'worker': record['worker'], 'index': record['index'], 'errors': record['errors'],
        'input_presentation_samples': presentation.get('input', []),
        'input_acknowledgement_ms': samples.get('acknowledgements', []),
        'presentation_blocker': latency.get('presentationBlocker'),
        'presentation_trace_event_count': latency.get('presentationEventCount'),
        'font_to_submission_ms': record.get('font', {}).get('submittedMilliseconds'),
        'device_loss_to_submission_ms': record.get('loss', {}).get('submittedMilliseconds'),
        'backlog_sent': backlog.get('sent'), 'backlog_acknowledged': backlog.get('acknowledged'),
        'backlog_max_pending': backlog.get('maxPending'), 'backlog_key_to_ack_p95_ms': quantile(keys, .95),
        'main_heap_before_loss': record.get('heapBeforeLoss'), 'main_heap_after_loss': record.get('heapAfterLoss'),
        'worker_heaps': record.get('workerHeaps', []), 'peak_resident_memory': None,
    }


checks = []
for path in sorted(RAW.glob('**/*-checks.json')):
    check = json.loads(path.read_text())
    checks.append({'host': path.name.split('-')[0], 'file': str(path.relative_to(RAW)), 'cases': [summarize_check_case(record) for record in check['cases']], 'errors': check['errors']})
    for record in check['cases']:
        for heap in record.get('workerHeaps', []):
            heaps.append({'file': str(path.relative_to(RAW)), 'host': path.name.split('-')[0], 'workload': 'after-backlog-and-font-change', 'worker_url': heap['target']['url'], 'response': heap.get('heap'), 'error': heap.get('error')})

summary = {'schema': 1, 'invalidPackets': invalid_packets, 'runtimeRevision': 'd2ed8989a745f016188e0a2e749009b3e1450f33', 'qualification': 'experimental; two repetitions; no speedup claim', 'environment': environment, 'baseline': baseline, 'hosted': hosted, 'completion': completion, 'workerHeaps': heaps, 'checks': checks, 'unresolved': ['presented update counts for each baseline workload', 'worker AnimationFrame::Presentation identity join', 'per-workload input-to-presented latency', 'peak resident memory during rebuilds', 'real DPR transition and real hidden-tab policy pending successful observation']}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
write_csv('baseline.csv', [{key: value for key, value in row.items() if key != 'output_hashes'} for row in baseline])
write_csv('energy.csv', energy)
write_csv('completion.csv', completion)
write_csv('overhead.csv', controls)
write_csv('hosted.csv', [{key: value for key, value in row.items() if key != 'output_hashes'} for row in hosted])
(OUT / 'raw-manifest.json').write_text(json.dumps({str(path.relative_to(RAW)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(RAW.glob('**/*')) if path.is_file() and path.suffix in ['.json', '.gz', '.js', '.mjs', '.py', '.sh', '.swift', '.bin', '.patch', '.png', '.log']}, indent=2) + '\n')
print(json.dumps({'baseline_rows': len(baseline), 'energy_family_rows': len(energy), 'hosted_rows': len(hosted), 'completion_rows': len(completion), 'worker_heap_records': len(heaps), 'text_parity_groups': len(parity)}))
