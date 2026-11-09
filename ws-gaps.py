# Within the longest WebSocket receipts: the gaps no child event covers, with
# whatever instant or tiny events (any thread-local name) fall inside them.
import json, sys, collections
def load(path):
    data = json.load(open(path))
    return data["traceEvents"] if isinstance(data, dict) else data
events = load(sys.argv[1]); count = int(sys.argv[2])
names = {(e["pid"], e["tid"]): e["args"]["name"] for e in events if e.get("ph") == "M" and e.get("name") == "thread_name"}
counts = collections.Counter((e["pid"], e["tid"]) for e in events if e.get("ph") == "X" and e.get("name") == "UpdateLayoutTree")
key = max([k for k, v in names.items() if v == "CrRendererMain"], key=lambda k: counts.get(k, 0))
mine = sorted([e for e in events if (e.get("pid"), e.get("tid")) == key], key=lambda e: (e.get("ts", 0), -e.get("dur", 0)))
t0 = min(e["ts"] for e in mine if "ts" in e)
ws = [e for e in mine if e.get("ph") == "X" and e["name"] == "SimpleWatcher::OnHandleReady" and "WebSocketClient" in json.dumps(e.get("args") or {})]
for top in sorted(ws, key=lambda e: -e["dur"])[:count]:
    end = top["ts"] + top["dur"]
    rmm = [e for e in mine if e.get("ph") == "X" and e["name"] == "Receive mojo message" and top["ts"] <= e["ts"] < end]
    parent = rmm[0] if rmm else top
    kids = [e for e in mine if e.get("ph") == "X" and parent["ts"] <= e["ts"] < parent["ts"] + parent["dur"] and e is not parent and e is not top and e["name"] != "Receive mojo message"]
    # direct children only
    direct, cursor = [], parent["ts"]
    for e in kids:
        if e["ts"] >= cursor: direct.append(e); cursor = e["ts"] + e["dur"]
    gaps, cursor = [], parent["ts"]
    for e in direct + [{"ts": parent["ts"] + parent["dur"], "dur": 0, "name": "(end)"}]:
        if e["ts"] - cursor > 2000: gaps.append((cursor, e["ts"], e["name"]))
        cursor = max(cursor, e["ts"] + e.get("dur", 0))
    print(f"=== {top['dur']/1000:.1f} ms at {(top['ts']-t0)/1000:.0f}; direct children: " + ", ".join(f"{e['name']}@{(e['ts']-parent['ts'])/1000:.0f}+{e['dur']/1000:.1f}" for e in direct[:14]))
    for a, b, nxt in gaps:
        inside = collections.Counter(e["name"] for e in mine if a <= e.get("ts", 0) < b)
        print(f"   gap {(a-parent['ts'])/1000:6.1f}..{(b-parent['ts'])/1000:6.1f} ms (before {nxt}): " + ", ".join(f"{k} x{v}" for k, v in inside.most_common(10)))
