# Summarise a Chrome trace's renderer main thread over the Design open: top-level
# work by event name, style recalcs and layouts with their sizes, and what
# scheduled them (invalidation tracking), from the first design request on.
import json, sys, collections
def load(path):
    data = json.load(open(path))
    return data["traceEvents"] if isinstance(data, dict) else data
def main_thread(events):
    names = {(e["pid"], e["tid"]): e["args"]["name"] for e in events if e.get("ph") == "M" and e.get("name") == "thread_name"}
    counts = collections.Counter((e["pid"], e["tid"]) for e in events if e.get("ph") == "X" and e.get("name") == "UpdateLayoutTree")
    cands = [k for k, v in names.items() if v == "CrRendererMain"]
    return max(cands, key=lambda k: counts.get(k, 0))
def summarise(path, window_ms):
    events = load(path)
    key = main_thread(events)
    mine = [e for e in events if (e.get("pid"), e.get("tid")) == key]
    # Open = the bench's first design request mark isn't in the trace; use the
    # first long burst after the idle gap: the last 'window_ms' before the end.
    t0 = min(e["ts"] for e in mine if e.get("ph") == "X")
    frm, to = window_ms
    win = [e for e in mine if frm * 1000 <= e["ts"] - t0 <= to * 1000]
    # Busy per 250 ms over the whole trace: top-level tasks only.
    busy = collections.Counter()
    for e in mine:
        if e.get("ph") == "X" and e["name"] in ("RunTask", "ThreadControllerImpl::RunTask"):
            busy[int((e["ts"] - t0) / 250000)] += e.get("dur", 0) / 1000
    print(path.split("/")[-2][:30], "busy per 250 ms (from trace start):", " ".join(f"{k*250}:{v:.0f}" for k, v in sorted(busy.items()) if v > 25))
    by = collections.Counter(); n = collections.Counter()
    for e in win:
        if e.get("ph") == "X": by[e["name"]] += e.get("dur", 0) / 1000; n[e["name"]] += 1
    style = [e for e in win if e.get("ph") == "X" and e["name"] == "UpdateLayoutTree"]
    layout = [e for e in win if e.get("ph") == "X" and e["name"] == "Layout"]
    elems = sum((e.get("args", {}).get("elementCount") or 0) for e in style)
    dirty = sum(((e.get("args", {}).get("beginData") or {}).get("dirtyObjects") or 0) for e in layout)
    reasons = collections.Counter(); nodes = collections.Counter(); stacks = collections.Counter()
    for e in win:
        if e["name"] in ("StyleRecalcInvalidationTracking", "StyleInvalidatorInvalidationTracking", "LayoutInvalidationTracking", "ScheduleStyleInvalidationTracking"):
            d = e.get("args", {}).get("data", {})
            r = d.get("reason") or d.get("changedAttribute") or d.get("changedClass") or d.get("changedId") or d.get("changedPseudo") or "?"
            reasons[(e["name"].replace("InvalidationTracking", ""), str(r)[:60])] += 1
            nodes[(e["name"].replace("InvalidationTracking", ""), str(d.get("nodeName", "?"))[:70])] += 1
            st = d.get("stackTrace") or []
            if st: stacks[(e["name"].replace("InvalidationTracking", ""), " < ".join(f"{f.get('functionName') or '(anon)'}@{f.get('url','').split('/')[-1][:28]}:{f.get('lineNumber')}" for f in st[:4]))] += 1
    return by, n, len(style), elems, len(layout), dirty, reasons, nodes, stacks
A = summarise(sys.argv[1], (float(sys.argv[3]), float(sys.argv[4]))); B = summarise(sys.argv[2], (float(sys.argv[5]), float(sys.argv[6])))
print(f"style recalcs A {A[2]} ({A[3]} elements)  B {B[2]} ({B[3]} elements); layouts A {A[4]} ({A[5]} dirty)  B {B[4]} ({B[5]} dirty)")
print("--- event ms (count): A | B, sorted by A-B")
for k in sorted(set(A[0]) | set(B[0]), key=lambda k: -(A[0].get(k, 0) - B[0].get(k, 0)))[:26]:
    print(f"{A[0].get(k,0)-B[0].get(k,0):8.1f}  {A[0].get(k,0):8.1f} ({A[1].get(k,0):5d}) | {B[0].get(k,0):8.1f} ({B[1].get(k,0):5d})  {k}")
for title, i in (("reasons", 6), ("nodes", 7), ("stacks", 8)):
    print(f"--- invalidation {title}: A | B")
    for k in sorted(set(A[i]) | set(B[i]), key=lambda k: -(A[i].get(k, 0) - B[i].get(k, 0)))[:18]:
        print(f"{A[i].get(k,0):6d} | {B[i].get(k,0):6d}  {k[0]}: {k[1]}")
