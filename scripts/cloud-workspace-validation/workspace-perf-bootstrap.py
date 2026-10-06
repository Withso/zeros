"""Read-only, closed observations on the disposable PERF child. No log text exits."""
import json
import os
import re
from decimal import Decimal
import subprocess
import time

UNITS = (
    'zeros-boot.service',
    'zeros-host.service',
    'systemd-tmpfiles-setup.service',
    'systemd-tmpfiles-setup-dev.service',
    'systemd-remount-fs.service',
    'systemd-udev-trigger.service',
    'systemd-udevd.service',
    'systemd-sysusers.service',
    'systemd-journal-flush.service',
    'systemd-journald.service',
    'systemd-modules-load.service',
    'systemd-sysctl.service',
    'systemd-networkd.service',
    'systemd-networkd-wait-online.service',
    'systemd-user-sessions.service',
    'networking.service',
    'network-online.target',
    'network.target',
    'basic.target',
    'sysinit.target',
    'local-fs.target',
    'local-fs-pre.target',
    'sockets.target',
    'timers.target',
    'paths.target',
    'cloud-init.service',
    'cloud-init-local.service',
    'cloud-config.service',
    'cloud-final.service',
)
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
    return result[:32]


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


def duration_us(value):
    if not value or len(value) > 80:
        return None
    parts = re.findall(r'(\d+(?:\.\d+)?)(min|ms|us|µs|s|h)', value)
    if not parts or ''.join(number+unit for number, unit in parts) != value.replace(' ', ''):
        return None
    multipliers = {'h': 3600000000, 'min': 60000000, 's': 1000000, 'ms': 1000, 'us': 1, 'µs': 1}
    return integer(sum(Decimal(number)*multipliers[unit] for number, unit in parts))


def project_analysis(chain, blame):
    result = {'available': bool(chain or blame), 'criticalChain': [], 'blame': [],
              'unknownCriticalChainUnits': 0, 'unknownBlameUnits': 0}
    for line in chain.splitlines()[:256]:
        row = re.match(r'^\s*(?:[└─├│+|`\- ]*)([^\s]+\.(?:service|target|mount|socket|device|swap|timer))(?: @([^+]+?))?(?: \+(.+))?$', line)
        if not row:
            continue
        if row[1] not in UNITS:
            result['unknownCriticalChainUnits'] += 1
        elif len(result['criticalChain']) < 32:
            result['criticalChain'].append({'unit': row[1], 'activationUs': duration_us(row[2]), 'durationUs': duration_us(row[3])})
    for line in blame.splitlines()[:256]:
        row = re.match(r'^\s*(.+?)\s+([^\s]+\.(?:service|target|mount|socket|device|swap|timer))$', line)
        if not row or duration_us(row[1]) is None:
            continue
        if row[2] not in UNITS:
            result['unknownBlameUnits'] += 1
        elif len(result['blame']) < 32:
            result['blame'].append({'unit': row[2], 'durationUs': duration_us(row[1])})
    return result


def read_command(args):
    try:
        reply = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               timeout=3, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, check=False)
        if reply.returncode == 0 and len(reply.stdout) <= 65536:
            return reply.stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ''


def main():
    fields = ('Id', 'ActiveState', 'SubState', 'Result', 'ExecMainStatus', *TIMES)
    chain = read_command(['/usr/bin/systemd-analyze', '--no-pager', 'critical-chain', 'zeros-boot.service'])
    blame = read_command(['/usr/bin/systemd-analyze', '--no-pager', 'blame'])
    analysis = project_analysis(chain, blame)
    selected = list(dict.fromkeys(['zeros-boot.service', 'zeros-host.service'] + [row['unit'] for row in analysis['criticalChain']]))
    units = read_command(['/usr/bin/systemctl', 'show', '--property='+','.join(fields), *selected])
    journal = read_command(['/usr/bin/journalctl', '--no-pager', '--boot', '-n', '40', '-o', 'json', '-u', 'zeros-boot.service'])
    print(json.dumps({'schema': 'zeros.workspace-perf-bootstrap/v1', 'observedMonotonicUs': time.monotonic_ns()//1000,
                      'hydrationDone': os.path.isfile('/var/lib/ascii-lazy/hydration-done'),
                      'activeDescriptorPresent': os.path.isfile('/run/zeros/active-runtime.json'),
                      'units': project_units(units), 'hydrationEvents': project_events(journal), 'bootAnalysis': analysis}, separators=(',', ':')))


if __name__ == '__main__':
    main()
