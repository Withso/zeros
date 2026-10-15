# Accepted sends need visible bubbles before transport acknowledgement

A cloud prompt entered FIFO/readiness bookkeeping before native admission, but
its queued flag hid the user bubble. Every follow-up also showed Waiting for
agent even when the workspace and session were already ready. Steering waited
for native consumption before becoming visible, then moved past newer output.

Delivery bookkeeping and presentation are separate facts. Present the accepted
head immediately, show first-session/setup readiness only when it applies, and
retain the explicit Queue preference for deliberately deferred follow-ups.
Steering has a provisional provider-turn owner while consumption is pending;
confirm its row in place on acknowledgement. Keep uncertain delivery identities
and Stop/admission/checkpoint guards independent of the visible Waiting label.
An immutable lost-receipt retry must keep its original turn and row position
through delivery, interruption or rejection. Only a new attempt may adopt the
current provider turn; replaying an older request never promotes its bubble.

The production callback regressions in cloud-composer-wake and queue-workflow
execute AgentChat's real projection too. The browser smoke renders the real
AgentChat for Personal Local, organization-local and cloud, checks immediate
bubbles and verifies that acknowledgement retains the DOM node. A queue length
assertion alone could pass while the user's message was invisible.
