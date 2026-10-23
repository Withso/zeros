# Sidebar workspace hover cards

- Symptom: a reused PR control in a background preview can refuse its action
  against another workspace's selected chat. Cause: the control's default sender
  captures the globally active chat. Rule: pin the preview's chat explicitly and
  retain the sender's workspace checks across asynchronous preparation. Encoded
  in `shell/pr/__tests__/pr-cloud-connection.test.ts` and the background-action
  browser case in `scripts/ui-smoke-workspace-hover-card.mjs`.
- Symptom: a detail preview needs tabbable actions and an independently portalled
  menu. Cause: Radix HoverCard intentionally removes descendants from the tab
  order, and pointer leave also fires when entering a child portal. Rule: use a
  non-modal Popover for an interactive preview, keep menu ownership through the
  hover grace, and dismiss on hidden/changed owners. Encoded in the keyboard,
  menu, hidden-sidebar and cloud owner-switch browser cases.
- Symptom: a browser action fixture reported a disconnected engine although its
  read requests succeeded. Cause: only the active-bridge singleton was seeded;
  action hooks read BridgeProvider's connection. Rule: mount the real provider
  with a synthetic transport when testing actions, as the PR harness does.
  Encoded in the sidebar harness's opt-in hover-card scenario.
- Symptom: the full draft-indicator smoke crashed when a workspace preview
  mounted. Cause: its sessions fixture was an empty type assertion. Rule: a
  shared row's new reads must also be provided by its existing harnesses.
  Encoded in the draft-indicator fixture's passive history method and its
  existing browser smoke.
