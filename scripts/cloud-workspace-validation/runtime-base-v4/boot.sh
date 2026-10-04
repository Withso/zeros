#!/bin/sh
umask 077
if [ "$#" -ne 0 ]; then
  printf '%s\n' '{"schema":"zeros.diagnostic/v1","component":"bootstrap","stage":"validate_input","ok":false,"exitCode":64,"timedOut":false,"failedChecks":["input_schema"]}'
  exit 64
fi
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 /usr/bin/python3 -I /opt/zeros-bootstrap/bootstrap.py boot
