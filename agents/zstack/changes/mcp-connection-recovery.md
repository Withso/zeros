# MCP connection recovery follows the saved owner and attempt

Symptom: servers could report that they needed sign-in without offering Connect,
save an empty API key, retain an authentication-required result after sign-in,
or become stuck after cancellation. Delayed cloud auth replies could survive
an account A → B → A replacement.

Cause: connection status and recovery actions were derived separately in each
surface, save and authorization shared a lifetime, and asynchronous account
checks happened only before requests.

Rule: derive status and the next action together. Keep rejected API keys out of
OAuth. Save before authorizing a changed draft and use the returned definition
revision; a failed save must never open the browser. Retire a canceled attempt
and release its UI controls before awaiting remote cleanup. Recheck ownership
after each account-bound await, and let fresh authorization observations replace
stale checks without dropping the exact configuration's tool inventory.
An unavailable gateway overrides cached successful backend checks in the list;
its Retry must reconnect the service before advertising a usable connection.

Encoded in the MCP form-save, connection-view, connection-status and cloud-API
regressions, plus the production Local and organization browser smoke. The
browser cases hold old replies through cancellation/retry, failed writes,
browserless authorization and owner replacement. Reuse Settings primitives for
section surfaces and typography; keep diagnostic stages and advanced OAuth
configuration behind disclosure rather than repeating connection actions.

Browser fixture lesson: a retained Connected label does not prove the list's
background refresh has settled. Before arming a held response and triggering
focus, wait for that exact cache key to finish refreshing; otherwise focus
correctly deduplicates against the earlier read and never reaches the new hold.
The organization smoke retains its delayed owner-switch assertion and now
observes this boundary instead of relying on runner speed.
