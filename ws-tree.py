# The event tree under the main thread's longest WebSocket receipts, to name
# the JS and native work each one ran.
import json, sys, collections
def load(path):
    data = json.load(open(path))
    return data["traceEvents"] if isinstance(data, dict) else data
events = load(sys.argv[1]); count = int(sys.argv[2]) if len(sys.argv) > 2 else 2
names = {(e["pid"], e["tid"]): e["args"]["name"] for e in events if e.get("ph") == "M" and e.get("name") == "thread_name"}
counts = collections.Counter((e["pid"], e["tid"]) for e in events if e.get("ph") == "X" and e.get("name") == "UpdateLayoutTree")
key = max([k for k, v in names.items() if v == "CrRendererMain"], key=lambda k: counts.get(k, 0))
mine = sorted([e for e in events if (e.get("pid"), e.get("tid")) == key and e.get("ph") in ("X", "I", "i", "n")], key=lambda e: (e["ts"], -e.get("dur", 0)))
t0 = min(e["ts"] for e in mine)
ws = [e for e in mine if e.get("ph") == "X" and e["name"] == "SimpleWatcher::OnHandleReady" and "WebSocketClient" in json.dumps(e.get("args") or {})]
for top in sorted(ws, key=lambda e: -e["dur"])[:count]:
    end = top["ts"] + top["dur"]
    print(f"=== {top['dur']/1000:.1f} ms at {(top['ts']-t0)/1000:.0f}")
    stack = []
    shown = 0
    for e in mine:
        if e["ts"] < top["ts"] or e["ts"] > end or e is top: continue
        while stack and e["ts"] >= stack[-1]: stack.pop()
        depth = len(stack)
        d = e.get("dur", 0) / 1000
        if e.get("ph") == "X":
            stack.append(e["ts"] + e.get("dur", 0))
        if e.get("ph") == "X" and d >= 1 and depth <= 8 and shown < 70:
            a = (e.get("args") or {}).get("data") or e.get("args") or {}
            info = {k: a[k] for k in ("functionName", "url", "lineNumber", "type", "elementCount", "dirtyObjects", "message") if k in a}
            if "url" in info: info["url"] = str(info["url"]).split("/")[-1][:40]
            print(f"{'  ' * depth}{d:7.1f} {e['name']} {json.dumps(info)[:150] if info else ''}")
            shown += 1
