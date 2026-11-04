# A design round closes on the canvas and in the smokes

**Symptom.** After the Zeros Design shipped page by page, the full ui-smoke
registry run at handoff found nine smokes still pinning looks the branch had
replaced on purpose (the model menu's 230px width, 26px rows and 1px gaps,
display:none sidebar actions, the 4px organization pill, the Dashboard title's
40px offset, the hover card's surface, the 40px canvas tool rail, the 20px
Dialog close) and one exact float comparison (`scale === 16`) that a rounding
error broke. Each crash hid the rest of its shard. The canvas still showed every
board as a Current and a Proposed half, so it no longer described the product.

**Cause.** Page steps ran their own unit suites and a few smokes, but the
registry shards that mount the changed surfaces ran only at the end. Nothing
said what the canvas should show once a design round shipped.

**Rule.** Run the registry shards that mount a page step's surfaces before
committing the step, and compare computed geometry with a tolerance. When the
round ships, fold the canvas: one shipped UI per board, logged decisions
applied to the boards, and a Planned line naming the `plans.md` section on
boards whose approved design is scheduled.

**Encoded in.** `playbooks/ui-design.md` steps 6 and 8; eval case
`stale-smoke-pins-after-design-round`.
