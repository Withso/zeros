Native thumb cancellation kept dragging and left body selection disabled.
Radix retired only on pointerup, remembered no pointer/capture identity and
restored the current viewport instead of the one it had acquired. Pointer
retirement must clear identity before releasing capture, reset the thumb offset
and restore the acquired styles even when an end handler prevents default.
Retire when only the captured thumb is replaced as well: its capture can be
released after removal without an event reaching the surviving scrollbar.
Callback-ref null is not proof of removal: React reassigns composed refs during
ordinary parent renders and caller-ref changes with the same connected DOM.
Retain the last actual thumb through that cycle. Replace it immediately for a
different node; confirm a null-only removal after the commit, fencing the check
to both that ref notification and the acquired drag so it cannot end a successor.
Style restoration includes CSS priority and must preserve later external edits;
overlapping drags retain shared styles until their final owner retires.
The retained scroll-area-drag browser scenario exercises both axes, cancellation,
capture loss, replacement, null-only removal, healthy rerenders, forwarded-ref
reassignment, remount and foreign/late events; package verification runs the same
scenario against both ESM and CJS distributions.
