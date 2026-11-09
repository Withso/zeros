# The longest WebSocketClient receipts on the renderer main thread: duration,
# their direct children by name, and self time (what no child event covers).
import json, sys, collections
def load(path):
    data = json.load(open(path))
    return data["traceEvents"] if isinstance(data, dict) else data
events = load(sys.argv[1]); frm, to = float(sys.argv[2]), float(sys.argv[3])
names = {(e["pid"], e["tid"]): e["args"]["name"] for e in events if e.get("ph") == "M" and e.get("name") == "thread_name"}
counts = collections.Counter((e["pid"], e["tid"]) for e in events if e.get("ph") == "X" and e.get("name") == "UpdateLayoutTree")
key = max([k for k, v in names.items() if v == "CrRendererMain"], key=lambda k: counts.get(k, 0))
mine = sorted([e for e in events if (e.get("pid"), e.get("tid")) == key and e.get("ph") == "X"], key=lambda e: (e["ts"], -e.get("dur", 0)))
t0 = mine[0]["ts"]
win = [e for e in mine if frm * 1000 <= e["ts"] - t0 <= to * 1000]
def ws(e):
    return e["name"] == "SimpleWatcher::OnHandleReady" and (sys.argv[4] if len(sys.argv) > 4 else "WebSocketClient") in json.dumps(e.get("args") or {})
rows = []
total_self = 0; total = 0; kids_total = collections.Counter()
for i, e in enumerate(win):
    if not ws(e): continue
    end = e["ts"] + e["dur"]; kids = collections.Counter(); covered = 0; cursor = e["ts"]
    for f in win[i + 1:]:
        if f["ts"] >= end: break
        if f["ts"] >= cursor:  # a direct child: starts after the previous child ended
            kids[f["name"]] += f["dur"] / 1000; covered += f["dur"]; cursor = f["ts"] + f["dur"]
    self_ms = (e["dur"] - covered) / 1000
    total += e["dur"] / 1000; total_self += self_ms
    for k, v in kids.items(): kids_total[k] += v
    rows.append((e["dur"] / 1000, (e["ts"] - t0) / 1000, self_ms, kids))
print(f"{sys.argv[1].split('/')[-2][:24]}: {len(rows)} receipts, {total:.0f} ms, self {total_self:.0f} ms; children:", ", ".join(f"{k} {v:.0f}" for k, v in kids_total.most_common(6)))
for dur, at, self_ms, kids in sorted(rows, reverse=True)[:12]:
    print(f"  {dur:6.1f} ms at {at:7.0f}  self {self_ms:6.1f}  ", ", ".join(f"{k} {v:.1f}" for k, v in kids.most_common(4)))
