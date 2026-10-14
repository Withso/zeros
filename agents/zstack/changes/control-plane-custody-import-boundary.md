The resume fix value-imported checkpoint restoration through credential-control
schemas shared with the control plane. Runtime tests passed, but the CP import
closure check correctly rejected the undeclared implementation dependency.

Engine boot now supplies the genuine WeakMap-backed custody verifier. The shared
fences import only its receipt type and reject missing or null verification in
the existing transaction. Retained reds cover both rejection cases with a real
restored receipt, and the existing CP scope test verifies the import boundary.
The CI-red playbook now includes that check when shared runtime imports change;
the CP input list and CI definitions are unchanged.

Eval: `control-plane-custody-import-boundary`.
