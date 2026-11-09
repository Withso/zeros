# Group the renderer main thread's Mojo receipts over a window by what the
# trace says they carry: event args, or the deepest named child event.
import json, sys, collections
def load(path):
    data = json.load(open(path))
    return data["traceEvents"] if isinstance(data, dict) else data
def main_thread(events):
    names = {(e["pid"], e["tid"]): e["args"]["name"] for e in events if e.get("ph") == "M" and e.get("name") == "thread_name"}
    counts = collections.Counter((e["pid"], e["tid"]) for e in events if e.get("ph") == "X" and e.get("name") == "UpdateLayoutTree")
    return max([k for k, v in names.items() if v == "CrRendererMain"], key=lambda k: counts.get(k, 0))
def describe(e):
    a = e.get("args") or {}
    flat = json.dumps(a, sort_keys=True)
    return flat[:160]
def run(path, frm, to):
    events = load(path)
    key = main_thread(events)
    mine = sorted([e for e in events if (e.get("pid"), e.get("tid")) == key and e.get("ph") == "X"], key=lambda e: (e["ts"], -e.get("dur", 0)))
    t0 = mine[0]["ts"]
    win = [e for e in mine if frm * 1000 <= e["ts"] - t0 <= to * 1000]
    out = collections.Counter(); n = collections.Counter(); child = collections.Counter(); childn = collections.Counter()
    wall = collections.Counter(); cpu = collections.Counter()
    for e in win:
        if "tdur" in e and e["name"] in ("SimpleWatcher::OnHandleReady", "Receive mojo message", "FunctionCall", "RunMicrotasks", "UpdateLayoutTree", "Layout", "RunTask", "ThreadControllerImpl::RunTask"):
            tag = ((e.get("args") or {}).get("chrome_mojo_event_info") or {}).get("watcher_notify_interface_tag", "")
            k = e["name"] + (f" [{tag}]" if tag else "")
            wall[k] += e["dur"] / 1000; cpu[k] += e["tdur"] / 1000
    print(path.split("/")[-2][:24], "wall vs thread ms:", "; ".join(f"{k} {wall[k]:.0f}/{cpu[k]:.0f}" for k in sorted(wall)))
    for i, e in enumerate(win):
        if e["name"] not in ("SimpleWatcher::OnHandleReady", "Receive mojo message"): continue
        k = (e["name"], describe(e))
        out[k] += e.get("dur", 0) / 1000; n[k] += 1
        if e["name"] == "SimpleWatcher::OnHandleReady":
            end = e["ts"] + e.get("dur", 0)
            kids = collections.Counter()
            for f in win[i + 1:i + 400]:
                if f["ts"] >= end: break
                if f["name"] not in ("SimpleWatcher::OnHandleReady",): kids[f["name"]] += f.get("dur", 0) / 1000
            top = ", ".join(f"{name}" for name, _ in kids.most_common(3))
            child[top] += e.get("dur", 0) / 1000; childn[top] += 1
    return out, n, child, childn
A = run(sys.argv[1], float(sys.argv[3]), float(sys.argv[4])); B = run(sys.argv[2], float(sys.argv[5]), float(sys.argv[6]))
print("--- by args: A ms (n) | B ms (n)")
for k in sorted(set(A[0]) | set(B[0]), key=lambda k: -(A[0].get(k, 0) - B[0].get(k, 0)))[:16]:
    print(f"{A[0].get(k,0)-B[0].get(k,0):7.1f} {A[0].get(k,0):7.1f} ({A[1].get(k,0):4d}) | {B[0].get(k,0):7.1f} ({B[1].get(k,0):4d})  {k[0][:14]} {k[1]}")
print("--- OnHandleReady by its biggest children: A ms (n) | B ms (n)")
for k in sorted(set(A[2]) | set(B[2]), key=lambda k: -(A[2].get(k, 0) - B[2].get(k, 0)))[:14]:
    print(f"{A[2].get(k,0)-B[2].get(k,0):7.1f} {A[2].get(k,0):7.1f} ({A[3].get(k,0):4d}) | {B[2].get(k,0):7.1f} ({B[3].get(k,0):4d})  {k[:170]}")
