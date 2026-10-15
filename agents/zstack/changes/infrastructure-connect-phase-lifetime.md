The infrastructure runner passed its 30-second connect-phase signal into a
runtime that retained it for disposal and refresh. A successful admission could
therefore be killed during a separately bounded file or native-task phase.
Mocked runtimes and pending-connect cancellation tests missed the lifetime edge.

For connection deadlines, test both pending cancellation and successful
admission followed by expiry of the completed phase. Use the actual retained
client with a deterministic signal seam. Forward the phase cancellation only
while admission is pending; keep the original overall signal as the admitted
runtime's lifetime, and retire any late connection. Do not add a new budget.

The retained loopback regression reproduces runtime_unavailable before the fix
and successful terminal work after it. The existing timeout-before-connect and
late-result cleanup regression remains required. This lesson is a fragment for
the next pack fold; it does not change safety rules or CI definitions.
