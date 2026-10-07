"""User-space task counters. JSON lines: {"command":"start","pids":[...]}, then {"pids":[...]}.
Existing threads are attached separately. inherit_thread includes later threads, excluding child processes.
"""
import ctypes
import errno
import json
import os
import pathlib
import platform
import struct
import sys
import time


class Attr(ctypes.Structure):
    _fields_ = [('type', ctypes.c_uint32), ('size', ctypes.c_uint32), ('config', ctypes.c_uint64), ('sample_period', ctypes.c_uint64), ('sample_type', ctypes.c_uint64), ('read_format', ctypes.c_uint64), ('flags', ctypes.c_uint64), ('tail', ctypes.c_uint64 * 10)]


def identity(pid):
    text = pathlib.Path(f'/proc/{pid}/stat').read_text()
    fields = text[text.rfind(')') + 2:].split()
    if fields[0] in {'Z', 'X', 'x'}:
        raise OSError(errno.ESRCH, 'Process exited and is unavailable for counters')
    return fields[19], int(fields[11]), int(fields[12])


def pmus():
    root = pathlib.Path('/sys/bus/event_source/devices')
    hybrid = []
    for name, core in [('cpu_core', 'performance'), ('cpu_atom', 'efficiency')]:
        directory = root / name
        if not directory.exists():
            continue
        hybrid.append({'name': name, 'coreClass': core, 'type': int((directory / 'type').read_text()), 'cpus': (directory / 'cpus').read_text().strip()})
    if hybrid:
        return hybrid
    return [{'name': 'cpu', 'coreClass': 'unknown', 'type': 0, 'cpus': None}]


class Reader:
    def __init__(self):
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.syscall.restype = ctypes.c_long
        self.syscall = {'x86_64': 298, 'aarch64': 241, 'armv7l': 364}.get(platform.machine())
        self.pmus = pmus()
        self.processes = {}
        self.failures = {}
        self.hz = os.sysconf('SC_CLK_TCK')

    def open_event(self, tid, pmu, event):
        if self.syscall is None:
            raise OSError(errno.ENOSYS, 'perf_event_open syscall is unavailable on this architecture')
        attr = Attr()
        attr.size = ctypes.sizeof(attr)
        attr.type = 0
        attr.config = event | (pmu['type'] << 32)
        attr.read_format = 3
        attr.flags = (1 << 0) | (1 << 1) | (1 << 5) | (1 << 6) | (1 << 35)
        fd = self.libc.syscall(self.syscall, ctypes.byref(attr), ctypes.c_int(tid), ctypes.c_int(-1), ctypes.c_int(-1), ctypes.c_ulong(8))
        if fd < 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return fd

    def attach(self, pid):
        start, _, _ = identity(pid)
        threads = sorted(int(path.name) for path in pathlib.Path(f'/proc/{pid}/task').iterdir())
        entry = {'identity': start, 'events': [], 'threads': threads}
        try:
            for tid in threads:
                self.attach_thread(entry, tid)
            if identity(pid)[0] != start:
                raise OSError(errno.ESRCH, 'PID identity changed while attaching counters')
            self.enable_events(entry['events'])
            final_threads = sorted(int(path.name) for path in pathlib.Path(f'/proc/{pid}/task').iterdir())
            if final_threads != threads:
                raise OSError(errno.EAGAIN, 'Thread set changed while attaching counters')
            self.processes[pid] = entry
            return {'identity': start, 'attachedThreads': threads, 'events': len(entry['events'])}
        except OSError:
            for fd, _, _, _ in entry['events']:
                os.close(fd)
            raise

    def enable_events(self, events):
        for fd, _, _, _ in events:
            if self.libc.ioctl(fd, 0x2400, 0) != 0:
                error = ctypes.get_errno()
                raise OSError(error, os.strerror(error))

    def attach_thread(self, entry, tid):
        for pmu in self.pmus:
            for name, event in [('cycles', 0), ('instructions', 1)]:
                fd = self.open_event(tid, pmu, event)
                entry['events'].append((fd, tid, pmu['name'], name))

    def start(self, pids):
        self.close()
        self.failures.clear()
        results = {}
        for pid in pids:
            try:
                results[str(pid)] = self.attach(pid)
            except OSError as error:
                failure = {'error': error.errno, 'reason': str(error)}
                self.failures[pid] = failure
                results[str(pid)] = failure
        return {'started': True, 'processes': results}

    def read_events(self, events):
        per_pmu = {}
        for fd, tid, pmu, name in events:
            raw = os.read(fd, 24)
            if len(raw) != 24:
                raise OSError(errno.EIO, 'Short perf counter read')
            value, enabled, running = struct.unpack('QQQ', raw)
            rows = per_pmu.setdefault(pmu, {}).setdefault(name, [])
            rows.append({'tid': tid, 'value': str(value), 'enabledNs': str(enabled), 'runningNs': str(running)})
        return per_pmu

    def close_process(self, pid):
        entry = self.processes.pop(pid, None)
        if entry is None:
            return
        for fd, _, _, _ in entry['events']:
            os.close(fd)

    def read(self, pid):
        entry = self.processes.get(pid)
        if entry is None:
            return self.failures.get(pid, {'error': 'Process was unavailable when counters were attached'})
        try:
            start, user, system = identity(pid)
            if start != entry['identity']:
                raise OSError(errno.ESRCH, 'PID identity changed')
            per_pmu = self.read_events(entry['events'])
            if identity(pid)[0] != start:
                raise OSError(errno.ESRCH, 'PID identity changed during counter read')
            return {'identity': start, 'userTimeNs': str(user * 1000000000 // self.hz), 'systemTimeNs': str(system * 1000000000 // self.hz), 'pmus': per_pmu}
        except OSError as error:
            self.close_process(pid)
            failure = {'error': error.errno, 'reason': str(error)}
            self.failures[pid] = failure
            return failure

    def snapshot(self, pids):
        start = time.monotonic_ns()
        values = {}
        for pid in pids:
            requested = time.monotonic_ns()
            value = self.read(pid)
            values[str(pid)] = {'requestedNs': str(requested), 'completedNs': str(time.monotonic_ns()), 'values': value}
        return {'requestedNs': str(start), 'completedNs': str(time.monotonic_ns()), 'processes': values}

    def close(self):
        for pid in list(self.processes):
            self.close_process(pid)


def main():
    if sys.platform != 'linux':
        print(json.dumps({'ready': False, 'reason': 'perf_event_open requires Linux'}), flush=True)
        return
    reader = Reader()
    print(json.dumps({'ready': True, 'source': 'perf_event_open', 'scope': 'user-space only; all attached threads and their later threads', 'pmus': reader.pmus, 'cpuTickNs': 1000000000 // reader.hz, 'energyReason': 'No per-process energy source; RAPL is package-wide and usually root-only', 'pCoreTimeReason': 'PMU running time mixes core residency with counter multiplexing; P-core CPU time is unavailable'}), flush=True)
    try:
        for line in sys.stdin:
            request = json.loads(line)
            pids = request['pids']
            value = reader.start(pids) if request.get('command') == 'start' else reader.snapshot(pids)
            print(json.dumps(value), flush=True)
    finally:
        reader.close()


if __name__ == '__main__':
    main()
