# Summary toolbar and compact Git rows

- Summary's docked presentation hid its toolbar trigger and exposed a second
  collapse control inside the card. Keep the toolbar trigger available across
  presentations and let it hide the complete island. The browser regression
  exercises keyboard input, unchanged composer identity/drafts, Local and
  organization ownership, placement changes, and closed menus/readers on hide.
- Split controls inherited standard padding, while status labels wrapped beside
  fixed-width actions. Check actual browser geometry: the compact split shell
  is 24px, each status occupies one 28px row, and its fg1 label ellipsizes.
  Preserve full labels in tooltips and allow Chromium's subpixel line-box
  rounding instead of requiring integer text heights.
- A row and its child action need separate surface hovers. The Summary smoke
  checks the existing bg2-hover and bg2-highlight fills in both themes, along
  with the primary split control's focus and menu behavior. Programmatic hide
  tests address the toolbar by DOM selector while a modal menu temporarily
  excludes it from the accessibility tree.
- Removing Context from Summary also removes its warm-on-intent call, active
  subscriptions, and the cache whose only consumer was that section. Keep an
  absence regression that exercises pointer/focus warming, graph-change events,
  island/popover presentations, and Local/organization/cloud placement while
  requiring zero context-graph reads.
