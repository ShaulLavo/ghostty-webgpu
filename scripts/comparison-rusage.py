"""Line server: each stdin line is space-separated PIDs; replies one JSON line of rusage v6 counters.
Times are converted from Mach absolute units to nanoseconds."""
import ctypes
import json
import os
import sys
import time

FIELDS = ['ri_user_time', 'ri_system_time', 'ri_pkg_idle_wkups', 'ri_interrupt_wkups', 'ri_pageins', 'ri_wired_size', 'ri_resident_size', 'ri_phys_footprint', 'ri_proc_start_abstime', 'ri_proc_exit_abstime', 'ri_child_user_time', 'ri_child_system_time', 'ri_child_pkg_idle_wkups', 'ri_child_interrupt_wkups', 'ri_child_pageins', 'ri_child_elapsed_abstime', 'ri_diskio_bytesread', 'ri_diskio_byteswritten', 'ri_cpu_time_qos_default', 'ri_cpu_time_qos_maintenance', 'ri_cpu_time_qos_background', 'ri_cpu_time_qos_utility', 'ri_cpu_time_qos_legacy', 'ri_cpu_time_qos_user_initiated', 'ri_cpu_time_qos_user_interactive', 'ri_billed_system_time', 'ri_serviced_system_time', 'ri_logical_writes', 'ri_lifetime_max_phys_footprint', 'ri_instructions', 'ri_cycles', 'ri_billed_energy', 'ri_serviced_energy', 'ri_interval_max_phys_footprint', 'ri_runnable_time', 'ri_flags', 'ri_user_ptime', 'ri_system_ptime', 'ri_pinstructions', 'ri_pcycles', 'ri_energy_nj', 'ri_penergy_nj', 'ri_secure_time_in_system', 'ri_secure_ptime_in_system', 'ri_neural_footprint', 'ri_lifetime_max_neural_footprint', 'ri_interval_max_neural_footprint']
KEEP = ['ri_proc_start_abstime', 'ri_proc_exit_abstime', 'ri_user_time', 'ri_system_time', 'ri_user_ptime', 'ri_system_ptime', 'ri_instructions', 'ri_cycles', 'ri_pinstructions', 'ri_pcycles', 'ri_energy_nj', 'ri_penergy_nj', 'ri_runnable_time', 'ri_interrupt_wkups', 'ri_pkg_idle_wkups', 'ri_cpu_time_qos_user_interactive', 'ri_cpu_time_qos_user_initiated', 'ri_cpu_time_qos_default', 'ri_cpu_time_qos_utility', 'ri_phys_footprint']
TIMES = {'ri_user_time', 'ri_system_time', 'ri_user_ptime', 'ri_system_ptime', 'ri_runnable_time', 'ri_cpu_time_qos_user_interactive', 'ri_cpu_time_qos_user_initiated', 'ri_cpu_time_qos_default', 'ri_cpu_time_qos_utility'}


class Usage(ctypes.Structure):
    _fields_ = [('ri_uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in FIELDS] + [('ri_reserved', ctypes.c_uint64 * 9)]


class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


libproc = None
timebase = Timebase()
if sys.platform == 'darwin':
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    libproc.proc_pid_rusage.restype = ctypes.c_int
    system = ctypes.CDLL('/usr/lib/libSystem.dylib')
    system.mach_timebase_info.argtypes = [ctypes.POINTER(Timebase)]
    system.mach_timebase_info(ctypes.byref(timebase))


def nanoseconds(value, numer, denom):
    return value * numer // denom


def read(pid):
    if libproc is None:
        return {'error': 'RUSAGE_INFO_V6 requires macOS'}
    usage = Usage()
    if libproc.proc_pid_rusage(pid, 6, ctypes.byref(usage)) != 0:
        return {'error': ctypes.get_errno()}
    return {name: nanoseconds(getattr(usage, name), timebase.numer, timebase.denom) if name in TIMES else getattr(usage, name) for name in KEEP}


def snapshot(pids):
    requested = time.monotonic_ns()
    processes = {}
    for pid in pids:
        start = time.monotonic_ns()
        value = read(pid)
        end = time.monotonic_ns()
        processes[str(pid)] = {'requestedNs': str(start), 'completedNs': str(end), 'values': {key: str(amount) for key, amount in value.items()}}
    return {'requestedNs': str(requested), 'completedNs': str(time.monotonic_ns()), 'processes': processes}


CAPABILITY_FIELDS = {
    'instructions': ['ri_instructions'],
    'cycles': ['ri_cycles'],
    'pCoreSeconds': ['ri_user_ptime', 'ri_system_ptime'],
    'pInstructions': ['ri_pinstructions'],
    'pCycles': ['ri_pcycles'],
    'energyJ': ['ri_energy_nj'],
    'pEnergyJ': ['ri_penergy_nj'],
}


def capabilities_from_samples(before, after):
    capabilities = {}
    for name, fields in CAPABILITY_FIELDS.items():
        supported = 'error' not in before and 'error' not in after and any(after.get(field, 0) > before.get(field, 0) for field in fields)
        capabilities[name] = {'available': supported, 'evidence': 'positive owned-helper calibration delta'} if supported else {'available': False, 'reason': 'Owned-helper calibration could not establish support for ' + name}
    return capabilities


def calibrate():
    requested = time.monotonic_ns()
    # A successful rusage call can zero-fill unsupported kernel channels.
    # Positive calibration deltas establish support independently of an idle or E-only window.
    set_qos = getattr(system, 'pthread_set_qos_class_self_np', None)
    if set_qos is not None:
        set_qos(0x21, 0)
    before = read(os.getpid())
    value = 1
    for index in range(200000):
        value = ((value << 1) ^ index) & 0xffffffff
    time.sleep(0.001)
    after = read(os.getpid())
    if set_qos is not None:
        set_qos(0x15, 0)
    return {'requestedNs': str(requested), 'completedNs': str(time.monotonic_ns()), 'capabilities': capabilities_from_samples(before, after)}


def main():
    if libproc is None:
        print(json.dumps({'ready': False, 'reason': 'RUSAGE_INFO_V6 requires macOS'}), flush=True)
        return
    calibration = calibrate()
    print(json.dumps({'ready': True, 'source': 'proc_pid_rusage/RUSAGE_INFO_V6', 'timebase': [timebase.numer, timebase.denom], 'units': {'time': 'ns', 'energy': 'nJ', 'start': 'Mach absolute ticks'}, 'capabilities': calibration['capabilities'], 'calibration': calibration}), flush=True)
    for line in sys.stdin:
        if line.startswith('{'):
            request = json.loads(line)
            pids = request['pids']
            result = snapshot(pids)
        else:
            pids = [int(value) for value in line.split()]
            result = {str(pid): read(pid) for pid in pids}
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
