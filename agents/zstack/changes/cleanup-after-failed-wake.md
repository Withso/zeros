## Cleanup after a failed wake

An accepted wake can end in a system-stopped or failed workspace. Cleanup
previously waited for readiness that would never arrive, and the lifecycle
guard would also reject a delete behind that unconfirmed wake.

Record a closed observed settled outcome before explicit deletion, preserving
the distinction between an accepted intent and successful completion. Save the
delete key before sending it and replay that key after an unknown response.
Keep transient setup pending, default cleanup read-only, and require the signed
workspace identity plus its unchanged `zd-` name. The retained product and
signed-receipt regressions encode this rule; no live fixture IDs are needed.
