# Terminal cloud admission survives passive chat mirrors

Symptom: background chat reconciliation repeatedly opened cloud admission after
a terminal refusal. An optional identity clear could double the attempts.

Cause: the per-workspace bridge coalesced only pending opens. Once a refused
open settled, each passive consumer created a fresh admission request even
though its account, workspace and generation had not changed.

Rule: retain typed terminal admission failures at the shared connection boundary,
bounded and scoped to the exact owner identity. Passive publications do not
authorize a retry. An explicit reopen or fresh identity can acquire authority;
neither action replays a submitted write. Preserve transient retry behavior,
pending local edits and Local Personal/organization-local independence.

Encoded in `cloud-chat-mirror-admission.test.ts`, the corresponding seeded eval,
and the bug-fix playbook. Controls include optional identity-clear dispatch,
generation replacement, late failures, account A → B → A, and owner removal.
