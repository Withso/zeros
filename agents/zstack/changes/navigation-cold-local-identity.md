# Restore identity before the authoritative Local list

An empty or partial boot metadata cache dropped the saved Local chat identity
and selected a sibling before SQLite could validate it. The resolver already
had a pending-Local contract, but the synchronous store initializer omitted it.

Pass the backend's confirmation state at every restore boundary. Retain a
missing Local identity only with its remembered Local owner; known archived
or moved rows and cloud IDs under Local owners are not cold-cache misses.
Keep selections synchronous and let the exact backend confirm absence later.

`state/__tests__/navigation-reopen.test.ts` imports the real store on fresh
boots, flushes the actual beforeunload persistence hook, and repeats A → B → A
for Personal Local, organization Local and cloud. Testing the pure resolver
alone would miss an omitted argument at its production call site.
