# Preserve synchronous Stop admission across optional owners

CI caught launch admission remaining open after Stop and legacy teardown
moving by an extra microtask. An unconditional `await coordinator?.stop()`
yielded even without a coordinator, and a present coordinator could hold the
workload fence behind native retirement. Fence launches before the first
retirement await; skip the optional await when its owner is absent. The
existing `engine-stop` and `engine-cloud-workloads` assertions and new held
coordinator success/failure probes encode both schedules.

The startup suite's old registration double also omitted the newly required
offer method. Keep doubles explicit about legacy negotiation and assert the
injected failure's cause and reached call, not only a shared wrapper error;
`engine-startup` now checks both so an unrelated fixture error cannot pass the
durable-registration failure test.
