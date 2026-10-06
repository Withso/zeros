"""Read-only, closed observations on the disposable PERF child. No log text exits."""
import json
import os
import subprocess
import time

UNITS = ('zeros-boot.service', 'zeros-host.service')
STATES = ('active', 'activating', 'inactive', 'deactivating', 'failed', 'reloading')
SUBSTATES = ('dead', 'start', 'start-pre', 'start-post', 'running', 'exited', 'failed', 'auto-restart', 'stop', 'stop-sigterm', 'stop-sigkill')
RESULTS = ('success', 'exit-code', 'signal', 'timeout', 'resources', 'start-limit-hit', 'core-dump', 'watchdog', 'oom-kill')
TIMES = ('ExecMainStartTimestampMonotonic', 'ExecMainExitTimestampMonotonic', 'ActiveEnterTimestampMonotonic')
EVENTS = ('persistence_hydration_wait', 'persistence_hydration_ready', 'persistence_hydration_timeout')


def integer(value, maximum=10**15):
    try:
        number = int(value)
        return number if 0 <= number <= maximum else None
    except (ValueError, TypeError):
        return None


def project_units(raw):
    result = []
    for block in raw.split('\n\n'):
        fields = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        if fields.get('Id') not in UNITS:
            continue
        result.append({'unit': fields['Id'], 'active': fields.get('ActiveState') if fields.get('ActiveState') in STATES else 'unknown',
                       'sub': fields.get('SubState') if fields.get('SubState') in SUBSTATES else 'unknown',
                       'result': fields.get('Result') if fields.get('Result') in RESULTS else 'unknown',
                       'exitCode': integer(fields.get('ExecMainStatus'), 255),
                       **{key: integer(fields.get(key)) for key in TIMES}})
    return result[:2]


def project_events(raw):
    result = []
    for line in raw.splitlines()[-40:]:
        try:
            row = json.loads(line)
            message = json.loads(row.get('MESSAGE', ''))
            if message.get('event') not in EVENTS:
                continue
            waited = integer(message.get('waitedSeconds'), 600)
            observed = integer(row.get('__MONOTONIC_TIMESTAMP'))
            if waited is not None and observed is not None:
                result.append({'event': message['event'], 'waitedSeconds': waited, 'observedMonotonicUs': observed})
        except (ValueError, TypeError, AttributeError):
            continue
    return result[-8:]


def read_command(args):
    try:
        reply = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               timeout=5, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, check=False)
        if reply.returncode == 0 and len(reply.stdout) <= 65536:
            return reply.stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ''


def main():
    fields = ('Id', 'ActiveState', 'SubState', 'Result', 'ExecMainStatus', *TIMES)
    units = read_command(['/usr/bin/systemctl', 'show', '--property='+','.join(fields), *UNITS])
    journal = read_command(['/usr/bin/journalctl', '--no-pager', '--boot', '-n', '40', '-o', 'json', '-u', 'zeros-boot.service'])
    print(json.dumps({'schema': 'zeros.workspace-perf-bootstrap/v1', 'observedMonotonicUs': time.monotonic_ns()//1000,
                      'hydrationDone': os.path.isfile('/var/lib/ascii-lazy/hydration-done'),
                      'activeDescriptorPresent': os.path.isfile('/run/zeros/active-runtime.json'),
                      'units': project_units(units), 'hydrationEvents': project_events(journal)}, separators=(',', ':')))


if __name__ == '__main__':
    main()
