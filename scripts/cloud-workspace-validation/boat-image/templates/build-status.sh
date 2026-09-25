sudo -n /usr/bin/python3 - <<'PY'
import pathlib,json,os
expected=json.loads({{EXPECTED_JSON_LITERAL}})
p=pathlib.Path('/srv/zeros-qualification')/expected['attempt']
actual=json.loads((p/'attempt.json').read_text())
assert all(actual[k]==v for k,v in expected.items()), 'Attempt manifest differs'
result=json.loads((p/'result.json').read_text()) if (p/'result.json').exists() else None
if result is not None: assert all(result[k]==v for k,v in expected.items()), 'Result identity differs'
started=json.loads((p/'runner-started.json').read_text()) if (p/'runner-started.json').exists() else None
running=False
if started is not None:
 assert all(started[k]==v for k,v in expected.items()), 'Runner identity differs'
 try: running=pathlib.Path('/proc',str(started['pid']),'stat').read_text().split(') ')[1].split()[19]==started['startTicks']
 except FileNotFoundError: pass
tail=''
if (p/'build.log').exists():
 with (p/'build.log').open('rb') as log:
  log.seek(max(0,os.fstat(log.fileno()).st_size-6000));tail=log.read(6000).decode(errors='replace')
print(json.dumps({'attempt':expected['attempt'],'sourceCommit':expected['sourceCommit'],'result':result,'running':running,'tail':tail}))
PY
