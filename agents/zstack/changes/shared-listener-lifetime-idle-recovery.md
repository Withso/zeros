The shared PostgreSQL listener disconnected every consumer at ten-minute
intervals. Its own retirement timer reused the query-pool lifetime, while
missing recovery logs made the event resemble a persistent server idle outage.
Inspect client timers before inferring server limits. A held LISTEN session
needs its own bounded lifetime, transport keepalive and an acknowledged
recovery signal; queue hints still replay durable state and security gaps stay
fail closed. The bug-fix playbook and the shared-listener eval encode this.
Regression tests cover the old ten-minute boundary, retirement before 24 hours,
real PostgreSQL idle-session closure, all consumer replays, delayed LISTEN
acknowledgements and bounded reconnect backoff with no late-socket storm.
