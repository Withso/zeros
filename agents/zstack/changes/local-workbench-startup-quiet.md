# Quiet Local workbench startup

Symptom: normal app restart displayed a yellow “Connecting…” strip above a
Local file editor while the on-device engine was starting.

Cause: the workbench applied the cloud transport's 10-second pending threshold
to both placements; the reported engine took about 15 seconds to become ready.

Rule: Local startup and reconnect have no pending connection banner. Retain
confirmed content, keep actionable failures, and preserve cloud availability
states. Avoid scheduling a Local pending-state timer that cannot change the UI.

Encoded in `tab-status-calm.test.ts`, `workbench-availability.test.ts` and
`ui-smoke-workbench-status.mjs`: both Local owners, cold boot, reconnect,
retained content, shared clocks, cloud switching, and Dark/Light file viewers.
The smoke fixture switches appearance through the theme store so editor syntax
and CSS surfaces use the same theme.
