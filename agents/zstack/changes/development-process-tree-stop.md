# A wrapper exit is not desktop shutdown

The local cloud launcher stopped its direct child and released its ownership
lock while Vite, watch processes and Electron descendants could keep running.
Keep each launched process group until its live members have exited, including
when the wrapper exits first. Concurrent Stop callers must join the same proof.
Give graceful cleanup time, bound escalation, and retain the receipt on failure.
An abandoned lock alone never permits replacing an unconfirmed prior launch.

The shutdown regression runs real descendant processes and a separate sibling
instance, holds a graceful flush, and refuses reset after an unconfirmed stop.
Keep the desktop's ordinary Local engine and provider lifecycle unchanged;
macOS Electron still needs its own platform verification.
