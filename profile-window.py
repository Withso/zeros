import json, re, sys, collections
def load(path):
    p = json.load(open(path))
    nodes = {n["id"]: n for n in p["nodes"]}
    t, out = p["startTime"], []
    for s, dt in zip(p["samples"], p["timeDeltas"]):
        t += dt
        out.append((t, s))
    return p, nodes, out
norm = lambda url: re.sub(r"-[A-Za-z0-9_-]{8}\.js$", ".js", url.split("/")[-1].split("?")[0])
def key(n):
    cf = n["callFrame"]
    return cf.get("functionName") or "(anon)", norm(cf.get("url", "")), cf.get("lineNumber", -1) + 1
SPECIAL = ("(idle)", "(program)", "(garbage collector)", "(root)")
def analyse(path, frm, to):
    p, nodes, samples = load(path)
    t0 = p["startTime"]
    buckets = collections.defaultdict(lambda: [0.0, 0.0])
    chunk, fn = collections.Counter(), collections.Counter()
    special = collections.Counter()
    prev = t0
    for t, s in samples:
        dt = (t - prev) / 1000; prev = t
        rel = (t - t0) / 1000
        n = nodes.get(s)
        if not n: continue
        name, url, line = key(n)
        b = buckets[int(rel // 250)]
        if name in SPECIAL:
            if name == "(program)": b[1] += dt
            if frm <= rel <= to: special[name] += dt
            continue
        b[0] += dt
        if frm <= rel <= to:
            chunk[url] += dt; fn[(name, url)] += dt
    return buckets, chunk, fn, special, (samples[-1][0] - t0) / 1000
a, b = sys.argv[1], sys.argv[2]
fa, ta, fb, tb = (float(x) for x in sys.argv[3:7])
A = analyse(a, fa, ta); B = analyse(b, fb, tb)
print(f"span A {A[4]:.0f} ms, B {B[4]:.0f} ms; window A {fa:.0f}-{ta:.0f}, B {fb:.0f}-{tb:.0f}")
print("special A", {k: round(v) for k, v in A[3].items()}, "B", {k: round(v) for k, v in B[3].items()})
print("JS in window A", round(sum(A[1].values())), "B", round(sum(B[1].values())))
print("--- per 250 ms: JS/program A | B")
for i in range(int(min(A[4], B[4]) // 250) + 1):
    x, y = A[0].get(i, [0, 0]), B[0].get(i, [0, 0])
    if x[0] + y[0] + x[1] + y[1] > 30: print(f"{i*250:6d} {x[0]:6.0f}/{x[1]:4.0f} | {y[0]:6.0f}/{y[1]:4.0f}")
print("--- per chunk in window: A vs B (diff)")
for k in sorted(set(A[1]) | set(B[1]), key=lambda k: -(A[1].get(k, 0) - B[1].get(k, 0)))[:14]:
    print(f"{A[1].get(k,0)-B[1].get(k,0):7.1f}  {A[1].get(k,0):7.1f} vs {B[1].get(k,0):7.1f}  {k or '(native)'}")
print("--- functions in window, largest A-B")
for k in sorted(set(A[2]) | set(B[2]), key=lambda k: -(A[2].get(k, 0) - B[2].get(k, 0)))[:25]:
    print(f"{A[2].get(k,0)-B[2].get(k,0):7.1f}  {A[2].get(k,0):7.1f} vs {B[2].get(k,0):7.1f}  {k[0]} {k[1]}")
