Two new canvas gestures ran beside the lifecycles they belonged to. Several
selected frames nudged on their own 300 ms timer. Escape, leaving the window
and a page change never cancelled it, and presses during a save were dropped.
The flow-drag detach also resolved its destination from frames captured at
pointerdown, so a frame that moved meanwhile could still receive the layer.
And the nest-target outline was React state set on pointermove, which made
every frame crossed during a drag live (an iframe boot each). Multi-frame
nudges are now a mode of the one nudge lifecycle (commit on key-up, cancel on
Escape, blur or owner change, queue during a save). Both detach paths share
`transferDesignLayerAtRelease`, which reads the confirmed frames at release.
The outline is painted imperatively, and the destination goes live only after
a 300 ms dwell or at release (`ui-smoke-design-nesting.mjs`,
`design-layout-transfer.test.ts`).

Rule: a new variant of a gesture joins the existing lifecycle and release
helper instead of growing its own. Pointer-rate feedback never sets React
state or demands documents; read world state at release, not at pointerdown.
