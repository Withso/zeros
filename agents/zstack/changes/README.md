# Pack change fragments

One file per lesson that changes guidance, `<id>.md`, written as symptom → cause
→ rule → where it is encoded, naming its target (a principle number, skill,
playbook or `gotchas.md`) and kept under 2,000 characters. A lesson fully held
by a test or eval case needs no fragment.

The pack owner folds every waiting fragment into its target at each pack
version, deletes it, and summarizes the version in `../CHANGELOG.md`.
`scripts/__tests__/zstack-pack.test.ts` fails when more than 40 fragments wait.
Fragments folded in 0.2.0 remain readable with
`git show 7b6eb9e6:agents/zstack/changes/<id>.md`.
