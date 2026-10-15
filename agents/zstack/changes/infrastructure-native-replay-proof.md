The public shared PTY returns a serialized grid and bounded live bytes; it has
no public event sequence cursor. Treating that replay as an agent transcript
would overstate infrastructure coverage. A retained race test also found that
output arriving during the final file read needed another validation pass.

The infrastructure helper now persists exact intent before any allocation,
refuses uncertain restarts, joins the real terminal replay with buffered live
output, and compares every numbered row with the exclusive fsynced output file
and fixed program hash. Exact boot, writer and funding scope remain required
for both proof and cleanup. Native output remains a separate coverage kind.
The focused suite and scenario eval exercise the real Python program, the real
terminal serializer, lost acknowledgements, late duplicates and owner changes.
