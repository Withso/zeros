# Ready opens must not create lifecycle writes

Every explicit preparation of a ready cloud workspace created a successful
no-op wake intent. Sharing one intent across readiness retries did not stop
new opens from issuing new writes. Ready admission now validates the live
connection and root without acquiring compute; passive transport stays inert.

Removing the write alone lost an idle-capture race for another sidebar row:
pointerdown intentionally disarmed the old selection, and the explicit new
destination was never armed. A second caller could also join an admission
already retiring under final capture. Arm the exact destination after atomic
selection, retain its existing bounded gesture until the flight settles, then
wake only after stop. Invalidate it on Stop, access loss, owner changes and
visibility/focus loss; restoring write access cannot revive old input.
On the first desktop cloud selection, native presence is still unknown. Keep
the same bounded intent during that read, but authorize no presence or wake
until availability is positively confirmed. A negative result clears it.

The lifecycle/open-intent regression drives the real bridge and wake path with
admission held through committed capture for sidebar and programmatic opens.
The wake, interaction and admission suites retain zero-write ready behavior,
fresh admission/root checks, idempotency and cancellation. This boundary is in
the bug-fix playbook and the ready-open-without-lifecycle-write eval.
