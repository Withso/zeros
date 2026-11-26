# Internal development access

For infrastructure diagnostics, connect your development agent to the Zeros-Internal MCP endpoint supplied by the platform owner. Register the HTTPS endpoint and your own revocable identity in the client's protected settings. New worktrees can reuse that connection.

The private Zeros-Internal repository owns the service, provider adapters and deployment. Keep provider keys in its service secret store.
