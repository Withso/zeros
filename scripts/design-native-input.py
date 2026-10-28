"""Post a bounded gesture only while its isolated app owns the foreground.

Uses the system Python and public CoreGraphics APIs. Never prompts for OS
permission. No app profile, credential, source document or general shell input
is accepted. The Node driver owns cancellation and the finite process timeout.
"""
import ctypes
import json
import math
import os
import signal
import sys
import time

from ctypes import c_bool, c_double, c_int32, c_int64, c_uint32, c_uint64, c_void_p


def bind(library, name, result, arguments):
    fn = getattr(library, name)
    fn.restype = result
    fn.argtypes = arguments
    return fn


def main(config):
    pid, x, y, rate = config['pid'], config['x'], config['y'], config['rateHz']
    events = config['events']
    assert isinstance(pid, int) and pid > 0
    assert all(isinstance(v, (int, float)) and math.isfinite(v) for v in [x, y, rate])
    assert 30 <= rate <= 240 and 5 <= len(events) <= 2401
    assert (len(events) - 1) % 4 == 0
    for index, event in enumerate(events):
        assert event['phase'] == (1 if index == 0 else 4 if index == len(events) - 1 else 2)
        assert event['modifiers'] in [0, 2]
        assert all(math.isfinite(event[k]) for k in ['deltaX', 'deltaY'])
    assert events[-1]['deltaX'] == 0 and events[-1]['deltaY'] == 0

    cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    system = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    if not bind(cg, 'CGPreflightPostEventAccess', c_bool, [])():
        raise RuntimeError('Native input posting is not authorized; no OS permission was requested.')

    class Point(ctypes.Structure):
        _fields_ = [('x', c_double), ('y', c_double)]

    class Timebase(ctypes.Structure):
        _fields_ = [('numer', c_uint32), ('denom', c_uint32)]

    timebase = Timebase()
    bind(system, 'mach_timebase_info', c_int32, [ctypes.POINTER(Timebase)])(ctypes.byref(timebase))
    assert timebase.numer > 0 and timebase.denom > 0
    absolute_time = bind(system, 'mach_absolute_time', c_uint64, [])
    wait_until = bind(system, 'mach_wait_until', c_int32, [c_uint64])
    interval = 1e9 * timebase.denom / timebase.numer / rate
    create = bind(cg, 'CGEventCreateScrollWheelEvent2', c_void_p, [c_void_p, c_uint32, c_uint32, c_int32, c_int32, c_int32])
    set_float = bind(cg, 'CGEventSetDoubleValueField', None, [c_void_p, c_uint32, c_double])
    set_int = bind(cg, 'CGEventSetIntegerValueField', None, [c_void_p, c_uint32, c_int64])
    set_flags = bind(cg, 'CGEventSetFlags', None, [c_void_p, c_uint64])
    set_position = bind(cg, 'CGEventSetLocation', None, [c_void_p, Point])
    post = bind(cg, 'CGEventPost', None, [c_uint32, c_void_p])
    release = bind(cf, 'CFRelease', None, [c_void_p])
    window_list = bind(cg, 'CGWindowListCopyWindowInfo', c_void_p, [c_uint32, c_uint32])
    array_count = bind(cf, 'CFArrayGetCount', c_int64, [c_void_p])
    array_at = bind(cf, 'CFArrayGetValueAtIndex', c_void_p, [c_void_p, c_int64])
    string = bind(cf, 'CFStringCreateWithCString', c_void_p, [c_void_p, ctypes.c_char_p, c_uint32])
    value = bind(cf, 'CFDictionaryGetValue', c_void_p, [c_void_p, c_void_p])
    number = bind(cf, 'CFNumberGetValue', c_bool, [c_void_p, c_int32, c_void_p])
    keys = {k: string(None, k.encode(), 0x08000100) for k in [
        'kCGWindowOwnerPID', 'kCGWindowNumber', 'kCGWindowLayer',
        'kCGWindowBounds', 'X', 'Y', 'Width', 'Height']}

    def integer(dictionary, key):
        v, result = value(dictionary, keys[key]), c_int64()
        if not v or not number(v, 4, ctypes.byref(result)):
            return None
        return result.value

    def foreground_window():
        os.kill(pid, 0)
        windows = window_list(1 | 16, 0)  # On-screen, excluding desktop elements.
        if not windows:
            raise RuntimeError('No foreground window is available for native input.')
        try:
            for i in range(array_count(windows)):
                window = array_at(windows, i)
                if integer(window, 'kCGWindowLayer') != 0:
                    continue
                if integer(window, 'kCGWindowOwnerPID') != pid:
                    raise RuntimeError('The isolated app lost foreground ownership; native input stopped.')
                window_id = integer(window, 'kCGWindowNumber')
                if not window_id:
                    raise RuntimeError('The isolated foreground window has no input identity.')
                bounds = value(window, keys['kCGWindowBounds'])
                if not bounds:
                    raise RuntimeError('The isolated input window has no screen bounds.')
                rect = [integer(bounds, key) for key in ['X', 'Y', 'Width', 'Height']]
                if any(v is None for v in rect) or not (rect[0] <= x < rect[0] + rect[2] and rect[1] <= y < rect[1] + rect[3]):
                    raise RuntimeError('The native gesture point left the isolated input window.')
                return window_id
            raise RuntimeError('The isolated app has no foreground input window.')
        finally:
            release(windows)

    window_id = foreground_window()

    def own_window():
        if foreground_window() != window_id:
            raise RuntimeError('The isolated app changed input windows during its gesture.')

    create_mouse = bind(cg, 'CGEventCreateMouseEvent', c_void_p, [c_void_p, c_uint32, Point, c_uint32])
    move = create_mouse(None, 5, Point(x, y), 0)
    if not move:
        raise RuntimeError('Could not allocate the native pointer event.')
    try:
        set_int(move, 91, window_id)
        set_int(move, 92, window_id)
        post(1, move)
    finally:
        release(move)

    total_x = total_y = previous_x = previous_y = 0

    def deliver(event):
        nonlocal total_x, total_y, previous_x, previous_y
        total_x += event['deltaX']
        total_y += event['deltaY']
        ix, iy = round(total_x) - previous_x, round(total_y) - previous_y
        previous_x, previous_y = round(total_x), round(total_y)
        native = create(None, 0, 2, -iy, -ix, 0)
        if not native:
            raise RuntimeError('Could not allocate the native wheel event.')
        try:
            set_position(native, Point(x, y))
            set_int(native, 91, window_id)
            set_int(native, 92, window_id)
            set_flags(native, (1 << 18) if event['modifiers'] == 2 else 0)
            set_int(native, 99, event['phase'])
            set_int(native, 88, 1)  # Continuous pixel input.
            set_float(native, 93, -event['deltaY'])
            set_float(native, 94, -event['deltaX'])
            set_int(native, 96, -iy)
            set_int(native, 97, -ix)
            post(1, native)
        finally:
            release(native)

    def cancelled(_signal, _frame):
        raise InterruptedError('Native gesture cancelled by its driver.')

    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    started = time.monotonic()
    next_at = absolute_time()
    dispatched, ended, late = 0, False, 0
    try:
        for index, event in enumerate(events):
            wait_until(round(next_at))
            now = absolute_time()
            if now - next_at > interval:
                late += 1
                next_at = now  # No burst of overdue input.
            next_at += interval
            if index % 8 == 0 or index == len(events) - 1:
                own_window()
            deliver(event)
            if event['phase'] == 4:
                ended = True
            else:
                dispatched += 1
    finally:
        if dispatched and not ended:
            # Retire the gesture only while the same isolated window owns it.
            # Losing the foreground must never send more input to another app.
            try:
                own_window()
                deliver(events[-1])
            except (RuntimeError, ProcessLookupError):
                pass
        for key in keys.values():
            release(key)
    print(json.dumps({'backend': 'CoreGraphics', 'pid': pid, 'windowId': window_id,
                      'dispatched': dispatched, 'ended': ended, 'rateHz': rate,
                      'durationMs': (time.monotonic() - started) * 1000,
                      'lateIntervals': late}))


if __name__ == '__main__':
    main(json.loads(sys.argv[1]))
