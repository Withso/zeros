Computer success did not prove the saved runtime contained a published fix.
The build summary omitted the immutable runtime/base and qualification state.
Require a separate authorized, consistent read of the saved tuple and current
qualified selection; admission still owns locks and authority. This is encoded
in the Computer read route, shared contract parity, the harness's exact tuple
check, and the real PostgreSQL observation/revocation regression.
