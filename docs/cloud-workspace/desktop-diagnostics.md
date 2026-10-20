# Cloud events in desktop diagnostic exports

The desktop records cloud connection events as `[Zeros cloud bridge]` and
selected VM events as `[Zeros cloud runtime]`. Both enter the existing
renderer capture → `log_submit` → `app.jsonl` path. Feedback's View file,
opt-in log attachment and internal Copy logs action read the same scrubbed
recent tail. The outer record keeps `origin: "frontend"`: it is a desktop
observation of a VM event, with the desktop receipt timestamp.

The VM projection includes engine readiness and protocol versions, a closed
engine error class, session creation/load/close, turn state and completion,
classified agent failures, steering acknowledgements, process exits and
permission/question waits. It selects fields independently of the permissive
bridge envelope. Credentials, tokens, URLs, native paths, prompts, outputs,
tool payloads, snapshots, stderr, free-form error text and stacks never enter
this projection. Identifiers must be UUIDs; unknown identifiers become null
and unknown classifications become `other`. Missing legacy fields do not
invent a newer acknowledgement or failure classification.

Organization, workspace, generation, authority epoch, engine and connection
sequence come from the current validated connection target. Replaced and
disposed socket callbacks are fenced before observation, and engine boot
identity checks run before readiness is logged. A logger failure cannot
interrupt message delivery or resolve a request differently.

Each runtime client emits at most 64 VM records per minute, with at most eight
per event/turn-state class and 1,536 UTF-8 bytes per record. The next retained
record reports the client's suppressed count. Windows advance on traffic;
there is no diagnostic polling. Existing renderer queue limits, duplicate-line
coalescing, two 8 MiB log generations and the 500,000-character whole-line
export cap still apply.

Collection observes the existing authorized stream and works with older
engines without a new RPC or runtime upgrade. It covers events received while
attached; it does not fetch past VM log files or reconstruct events missed
while disconnected. Exporting does not connect to or wake a cloud workspace.
Local Personal and organization-local logging and transport stay unchanged.
