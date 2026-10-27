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

def load_inventory():
    inventory = json.loads((OUT / 'channel-inventory.json').read_text())
    channels = inventory['channels']
    ids = {row['id'] for row in channels}
    assert len(ids) == len(channels), 'Duplicate measurement channel IDs'
    required = {
        'M2.queue.main.200',
        'M2.timestamp.main.builtins',
        'M2.timestamp.main.external',
        'M2.queue.main.80',
        'M2.timestamp.main.80',
        'M2.queue.worker',
        'M2.timestamp.worker',
        'M2.write-ack.hosted',
        'M2.input-present.mac-main',
        'M2.input-present.pc-main',
        'M2.input-present.worker',
        'M2.write-present.main',
        'M2.write-present.worker',
        'M2.input-present.workloads',
        'M2.input-present.busy',
        'M2.presentation.80',
        'M2.presented-counts',
        'M2.screenshot-boundary',
        'M5.real-dpr',
        'M5.real-hidden-tab',
        'M7.worker-heap',
        'M7.clone-transfer.pc',
        'M7.clone-transfer.mac',
        'M7.backlog-ack',
        'M8.font-rebuild',
        'M8.device-rebuild',
        'M8.replacement-adapter.pc',
        'M8.replacement-adapter.mac',
        'M8.context-rebuild',
        'M8.dpr-rebuild.mac',
        'M8.dpr-rebuild.pc',
        'M8.rebuild-peak-memory',
    }
    assert required <= ids, f'Missing required channels: {required - ids}'
    allowed = {'measured', 'partial', 'not_probed', 'blocked_trace_join', 'blocked_observation', 'blocked_host'}
    assert all(row['status'] in allowed and row['reason'] for row in channels)
    assert all(inventory['itemStatus'][item] == 'partial' for item in ['M2', 'M5', 'M7', 'M8'])
    return inventory


def write_inventory(inventory):
    lines = ['# Measurement channel inventory', '',
        'M2, M5, M7 and M8 remain partial. `not_probed` means an acquisition or diagnostic endpoint was omitted; it does not mean the API or adapter lacks support.', '',
        'Coverage applies only to the host, entry, backend, geometry and workload named in the row. JSON and trace evidence paths are relative to the raw packet; CSV and script basenames refer to this packet.', '',
        '| Channel | Coverage | Status | Evidence and reason |',
        '| --- | --- | --- | --- |']
    for row in inventory['channels']:
        coverage = '; '.join([', '.join(row['hosts']), row['entry'], ', '.join(row['backends']), row['grid'], row['workloads']])
        reason = row['reason']
        if row['evidence']:
            reason += ' Evidence: ' + ', '.join(f"`{path}`" for path in row['evidence']) + '.'
        if row['nextProbe']:
            reason += ' Next probe: ' + row['nextProbe']
        lines.append(f"| `{row['id']}` | {coverage} | `{row['status']}` | {reason} |")
    (OUT / 'channel-inventory.md').write_text('\n'.join(lines) + '\n')


def compact_transport(record):
    samples = record.get('observations', [])
    return {
        'backend': record['backend'], 'mode': record['mode'], 'byteLength': record['byteLength'],
        'order': record['order'], 'updates': record.get('updates'), 'error': record.get('error'),
        'acknowledgements': len(samples),
        'ack_sequence_contiguous': all(value['sequence'] == index + 5 for index, value in enumerate(samples)),
        'post_p50_ms': quantile([value['postMilliseconds'] for value in samples], .5),
        'post_p95_ms': quantile([value['postMilliseconds'] for value in samples], .95),
        'ack_p50_ms': quantile([value['acknowledgementMilliseconds'] for value in samples], .5),
        'ack_p95_ms': quantile([value['acknowledgementMilliseconds'] for value in samples], .95),
        'sender_lengths': sorted({value['senderByteLength'] for value in samples}),
        'parsed_calls': sum(span['operation'] == 'ghostty_terminal_vt_write' for span in (record.get('trace') or {}).get('spans', [])),
        'submitted_frames': record.get('after', {}).get('metrics', {}).get('submittedFrames', 0) - record.get('before', {}).get('metrics', {}).get('submittedFrames', 0),
        'output_sha256': record.get('outputSha256'),
    }


def compact_recovery(record):
    return {
        'backend': record['backend'], 'worker': record['worker'], 'error': record.get('error'),
        'submitted_ms': record.get('submittedMilliseconds'), 'trigger': record.get('trigger'),
        'before_gpu': record.get('before', {}).get('snapshot', {}).get('gpu'),
        'after_gpu': record.get('after', {}).get('snapshot', {}).get('gpu'),
        'restores': record.get('after', {}).get('metrics', {}).get('deviceRestores', 0) - record.get('before', {}).get('metrics', {}).get('deviceRestores', 0),
    }


def review_probes():
    output = []
    for path in sorted((RAW / 'review-r1').glob('*-channels.json')):
        packet = json.loads(path.read_text())
        validate_probe_provenance(path, packet)
        transport = [compact_transport(record) for record in packet['transport']]
        validate_transport(transport)
        output.append({'file': str(path.relative_to(RAW)), 'host': packet['host'], 'sourceHead': packet['sourceHead'],
            'browser': packet.get('browser'), 'errors': packet['errors'], 'transport': transport,
            'recovery': [compact_recovery(record) for record in packet['recovery']]})
    return output


def validate_probe_provenance(path, packet):
    suffix = path.name.removesuffix('channels.json')
    files = packet.get('bundleFiles', {'main': suffix + 'review.bundle.js', 'worker': suffix + 'review.worker.js'})
    for entry, name in files.items():
        actual = hashlib.sha256((path.parent / name).read_bytes()).hexdigest()
        assert actual == packet['bundleHashes'][entry], f'Frozen review bundle mismatch: {name}'
    source = environment[packet['host']]['source']
    assert packet['wasmHashes']['ghostty-vt.wasm'] == source['wasmSha256']
    assert packet['wasmHashes']['bridge.wasm'] == source['bridgeSha256']
    assert packet['wasmHashes']['canvas-compose.wasm'] == source['canvasComposeSha256']
    for record in packet['recovery']:
        validate_recovery(record)


def validate_recovery(record):
    if record.get('error'):
        return
    before = record['before']['snapshot']['gpu']
    after = record['after']['snapshot']['gpu']
    assert record['after']['metrics']['deviceRestores'] - record['before']['metrics']['deviceRestores'] >= 1
    if record['backend'] == 'webgpu':
        assert after['adapter']['fallback'] is False
        assert after['device'] != before['device']
        return
    assert after['contextLost'] is False
    assert after['vendor'] and after['renderer']
    assert record['trigger']['restoreDelayMilliseconds'] == 100


def validate_transport(records):
    grouped = defaultdict(list)
    for record in records:
        if record['error']:
            continue
        expected = [0] if record['mode'] == 'transfer' else [record['byteLength']]
        assert record['sender_lengths'] == expected, record
        assert record['parsed_calls'] == record['updates'] == record['acknowledgements'] == 24, record
        assert record['ack_sequence_contiguous'], record
        grouped[(record['backend'], record['byteLength'])].append(record)
    for records in grouped.values():
        assert len(records) == 4, 'Incomplete clone/transfer ABBA group'
        assert [record['mode'] for record in sorted(records, key=lambda row: row['order'])] == ['clone', 'transfer', 'transfer', 'clone']
        assert len({record['output_sha256'] for record in records}) == 1, 'Clone/transfer output mismatch'
        assert len({record['submitted_frames'] for record in records}) == 1, 'Clone/transfer submission mismatch'


def adapter_label(gpu):
    if not gpu:
        return 'not observed'
    adapter = gpu.get('adapter')
    if adapter:
        return f"vendor={adapter['vendor']}; architecture={adapter['architecture']}; device={adapter['device']!r}; description={adapter['description']!r}; fallback={adapter['fallback']}"
    return f"{gpu.get('vendor', 'unavailable')}; {gpu.get('renderer', 'unavailable')}"


def transport_lines(packet):
    return [transport_line(packet, row) for row in packet['transport'] if not row['error']]


def transport_line(packet, row):
    return f"| {packet['host']} | {row['backend']} | {row['byteLength']} | {row['mode']} / {row['order']} | {row['post_p50_ms']:.3f} | {row['ack_p50_ms']:.3f} / {row['ack_p95_ms']:.3f} | {row['submitted_frames']} |"


def recovery_lines(packet):
    return [recovery_line(packet, row) for row in packet['recovery']]


def recovery_line(packet, row):
    entry = 'worker' if row['worker'] else 'main'
    if row['error']:
        return f"| `{packet['file']}` | {entry}/{row['backend']} | - | - | {row['error'].splitlines()[0]} |"
    return f"| `{packet['file']}` | {entry}/{row['backend']} | {row['submitted_ms']:.3f} | {row['restores']} | {adapter_label(row['after_gpu'])} |"


def write_review_results(packets):
    lines = ['# Review probe results', '',
        'These are bounded hardware diagnostics at 200×50 DPR 2. Both arms use the attached producer port, with the same message, bytes and acknowledgement path; only the transfer list changes. This isolates transport semantics without comparing different public API paths. Four warmup updates precede 24 measured updates per arm. Mode order is clone/transfer/transfer/clone. Timings are experimental and are not a throughput or presentation claim. Short postMessage samples can be zero at the browser timer resolution.', '',
        'Clone buffers stay readable after sending; transferred buffers detach. The exporter checks 24 contiguous acknowledgements and parser calls per arm, plus equal text hashes and submission counts within every backend/size group. WebGPU submits 24 frames per arm; WebGL2 skips identical records in this fixture and submits zero. This does not compare renderer throughput.', '',
        '| Host | Backend | Bytes/update | Mode/order | postMessage p50 ms | Parse-ack p50/p95 ms | Submissions |',
        '| --- | --- | ---: | --- | ---: | ---: | ---: |']
    for packet in packets:
        lines.extend(transport_lines(packet))
    lines.extend(['', '## Recovery adapter observations', '',
        'GPUDevice.adapterInfo is read from the current renderer device before and after recovery. Local device identity and the restore counter prove that the snapshots straddle a device rebuild. WebGL metadata is queried from the restored context. Empty WebGPU device/description strings are preserved, not filled from a stale initial adapter or from the browser-wide GPU label. Web APIs expose no physical GPU serial identity.', '',
        '| Evidence | Entry/backend | Submission ms | Restores | Current adapter metadata after recovery |',
        '| --- | --- | ---: | ---: | --- |'])
    for packet in packets:
        lines.extend(recovery_lines(packet))
    lines.extend(['', 'WebGL restoration is explicitly requested after 100 ms, which is included in its submission latency. The first PC main WebGL attempt queried an extension while the context was lost and failed. Its record is retained; the diagnostic now returns lost-context state before querying extensions. The inventory identifies whether the guarded recovery-only rerun was acquired.', '',
        'M7 and M8 remain partial. The Mac review cohort needs a released shared-host lock. Overload behavior, actual DPR rebuilds and interval peak-memory measurements are outside these new diagnostic results. See the per-channel inventory for each missing acquisition or observed failure.'])
    (OUT / 'review-results.md').write_text('\n'.join(lines) + '\n')


inventory = load_inventory()
write_inventory(inventory)
review = review_probes()
write_review_results(review)
summary = {'schema': 2, 'invalidPackets': invalid_packets, 'runtimeRevision': 'd2ed8989a745f016188e0a2e749009b3e1450f33', 'qualification': 'experimental; two repetitions; no speedup claim', 'environment': environment, 'baseline': baseline, 'hosted': hosted, 'completion': completion, 'workerHeaps': heaps, 'checks': checks, 'itemStatus': inventory['itemStatus'], 'channelInventory': inventory['channels'], 'reviewProbes': review, 'unresolved': [row for row in inventory['channels'] if row['status'] != 'measured']}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
write_csv('baseline.csv', [{key: value for key, value in row.items() if key != 'output_hashes'} for row in baseline])
write_csv('energy.csv', energy)
write_csv('worker-buffers.csv', [{'file': packet['file'], 'host': packet['host'], **record} for packet in review for record in packet['transport']])
write_csv('completion.csv', completion)
write_csv('overhead.csv', controls)
write_csv('hosted.csv', [{key: value for key, value in row.items() if key != 'output_hashes'} for row in hosted])
(OUT / 'raw-manifest.json').write_text(json.dumps({str(path.relative_to(RAW)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(RAW.glob('**/*')) if path.is_file() and path.suffix in ['.json', '.gz', '.js', '.mjs', '.py', '.sh', '.swift', '.bin', '.patch', '.png', '.log']}, indent=2) + '\n')
print(json.dumps({'baseline_rows': len(baseline), 'energy_family_rows': len(energy), 'hosted_rows': len(hosted), 'completion_rows': len(completion), 'worker_heap_records': len(heaps), 'text_parity_groups': len(parity), 'channels': len(inventory['channels']), 'review_probe_hosts': len({row['host'] for row in review})}))
