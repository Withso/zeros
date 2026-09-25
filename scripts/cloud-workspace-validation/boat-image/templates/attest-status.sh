sudo -n /usr/bin/python3 - <<'PYREMOTE'
import pathlib,json
p=pathlib.Path('/srv/zeros-qualification/image-attestation-{{ATTEMPT_HEX}}')
r={'exit':json.loads((p/'native-attest.exit').read_text()) if (p/'native-attest.exit').exists() else None}
if r['exit'] is not None:
 r['report']=(p/'native-attest.out').read_text()[-100000:]
 r['error']=(p/'native-attest.err').read_text()[-3000:]
print(json.dumps(r))
PYREMOTE
