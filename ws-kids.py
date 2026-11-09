# Everything inside the main thread's longest WebSocket receipts, small events
# included: count and total ms by name, and the onmessage calls' sizes.
import json, sys, collections
def load(path):
    data = json.load(open(path))
    return data["traceEvents"] if isinstance(data, dict) else data
events = load(sys.argv[1]); count = int(sys.argv[2])
names = {(e["pid"], e["tid"]): e["args"]["name"] for e in events if e.get("ph") == "M" and e.get("name") == "thread_name"}
counts = collections.Counter((e["pid"], e["tid"]) for e in events if e.get("ph") == "X" and e.get("name") == "UpdateLayoutTree")
key = max([k for k, v in names.items() if v == "CrRendererMain"], key=lambda k: counts.get(k, 0))
mine = sorted([e for e in events if (e.get("pid"), e.get("tid")) == key and e.get("ph") == "X"], key=lambda e: (e["ts"], -e.get("dur", 0)))
t0 = mine[0]["ts"]
ws = [e for e in mine if e["name"] == "SimpleWatcher::OnHandleReady" and "WebSocketClient" in json.dumps(e.get("args") or {})]
for top in sorted(ws, key=lambda e: -e["dur"])[:count]:
    end = top["ts"] + top["dur"]
    inside = [e for e in mine if top["ts"] <= e["ts"] < end and e is not top]
    by = collections.Counter(); n = collections.Counter()
    for e in inside: by[e["name"]] += e["dur"] / 1000; n[e["name"]] += 1
    calls = [e for e in inside if e["name"] == "FunctionCall"]
    fn = collections.Counter(); fnn = collections.Counter()
    for e in calls:
        d = (e.get("args") or {}).get("data") or {}
        k = f"{d.get('functionName') or '(anon)'}@{str(d.get('url', '')).split('/')[-1][:34]}:{d.get('lineNumber')}"
        fn[k] += e["dur"] / 1000; fnn[k] += 1
    print(f"=== {top['dur']/1000:.1f} ms at {(top['ts']-t0)/1000:.0f}: " + ", ".join(f"{k} {by[k]:.1f}/{n[k]}" for k in sorted(by, key=lambda k: -by[k])[:12]))
    for k in sorted(fn, key=lambda k: -fn[k])[:8]: print(f"     {fn[k]:7.1f} ms {fnn[k]:5d}x  {k}")
