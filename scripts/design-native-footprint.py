"""Read physical footprint for the benchmark's explicit owned process set.

The public libproc RUSAGE_INFO_V0 ABI includes GPU/IOSurface and compressed
memory in ri_phys_footprint. No system-wide scan, argv or credentials are read.
Unavailable processes stay unavailable; resident memory is never substituted.
"""
import ctypes
import json
import sys


class RusageInfoV0(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in [
        'user_time', 'system_time', 'pkg_idle_wkups', 'interrupt_wkups', 'pageins',
        'wired_size', 'resident_size', 'phys_footprint', 'proc_start_abstime', 'proc_exit_abstime']]


def main(pids):
    if sys.platform != 'darwin':
        raise RuntimeError('Physical-footprint sampling requires macOS.')
    if not isinstance(pids, list) or not 1 <= len(pids) <= 2048 or len(set(pids)) != len(pids):
        raise ValueError('An explicit bounded owned-process set is required.')
    if any(type(pid) is not int or not 0 < pid < 2**31 for pid in pids):
        raise ValueError('Invalid process identity.')
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    read = library.proc_pid_rusage
    read.restype = ctypes.c_int
    read.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    rows = []
    for pid in pids:
        info = RusageInfoV0()
        ctypes.set_errno(0)
        result = read(pid, 0, ctypes.byref(info))
        rows.append({'pid': pid, 'physicalFootprintBytes': info.phys_footprint if result == 0 else None,
                     'error': None if result == 0 else ctypes.get_errno() or -1})
    print(json.dumps({'source': 'proc_pid_rusage', 'version': 1, 'rows': rows}))


if __name__ == '__main__':
    main(json.loads(sys.argv[1]))
