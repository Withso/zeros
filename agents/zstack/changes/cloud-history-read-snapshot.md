Cloud sends waited for transcript residency while history reads repeatedly
returned command_conflict. The engine captured a global SQLite revision at
request admission, then compared it after asynchronous dispatch. An unrelated
chat upsert could invalidate all four history operations.

Capture NORMAL rows and FULL restore metadata in the same synchronous producer
boundary, after dispatch waits. Preserve that paired result through delivery;
later data cannot relabel it with a newer restore head. Original boot, queue and
actor authority still fence every await. Optional legacy image work must check
the original read before committing rewritten rows, then re-read with at most
three attempts. A cleared message cannot reappear after attachment I/O.

The real engine/WorkspaceService/SQLite regression holds requests before and
after the read, exercises both window forms, search and the catalog, and retains
Local, writer replacement, actor loss, real attachment staging and bounded
conflict controls. cloud-history-read-snapshot is the retained replay case.
The existing mocked history fixture now invokes the actual service callback;
its torn-read controls inject changes inside the snapshot, rather than treating
an already-consistent result as invalid after any unrelated outer await.
