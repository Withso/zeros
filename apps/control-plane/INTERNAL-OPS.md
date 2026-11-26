# Internal Ops MCP

Internal development uses one Streamable HTTP connection named `zeros-ops`. Platform owners run the gateway as a separate service. An agent receives its own Ops identity and the gateway URL. The five provider credentials belong to that service. The existing customer Cloud MCP has its own deployment entry point and authentication.

## Connect an agent

In Devin's MCP integration, Conductor's underlying agent configuration or Zeros Settings → MCP, register a remote HTTP server with the HTTPS URL ending in `/mcp` supplied by the internal Ops owner. Register it once at the trusted platform or user level so new worktrees inherit the connection. Keep values in the platform's secret store.

Use a separate Cloudflare Access service identity per unattended client. Attach a Service Auth policy for its exact token to the Access application. Access forwards a signed assertion to the origin, which verifies the issuer, audience, expiry and maximum age of one hour on each request.

* In a client with two protected headers, configure `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
* For Devin or another single-header client, set the application's `read_service_tokens_from_header` to `Authorization`. Register one raw Authorization header whose protected value is a JSON object with the string keys `cf-access-client-id` and `cf-access-client-secret`. Choose raw header formatting. Store the entire object as a client secret.

See [Cloudflare's service-token configuration](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/#authenticate-with-a-single-header).

Use MCP initialization and tool discovery to check the connection. Calling any listed tool takes an empty object. `check_boat` verifies the wallet and start allowance. `check_cloudflare` reads zone status. `check_workos` verifies organization identity. `check_railway` reads the latest deployment status of a service. `check_planetscale` reads database state. Clients get projected fields. Operations, tools and provider target identifiers are controlled centrally.

## Run the service

Build the control-plane package and run `pnpm ops:mcp` from that package, or start `node dist/internal-ops/start.js` in its built runtime image. It binds to loopback on port 8789 by default. Set `PORT` and `OPS_LISTEN_HOST` to match the private ingress. Route the dedicated development hostname through an Access self-hosted application. Use a distinct audience for each environment and organization. Keep the origin private. A deployment represents one Zeros organization and one environment.

Supply `OPS_ACCESS_POLICY` as JSON in the gateway service configuration. Replace the example identifiers with the actual audience, Zeros organization and allowed service token client ID.

```json
{
  "environment": "alpha",
  "origin": "https://ops-mcp.example.com",
  "organizationId": "11111111-1111-4111-8111-111111111111",
  "issuer": "https://example.cloudflareaccess.com",
  "audience": "0000000000000000000000000000000000000000000000000000000000000000",
  "principals": [{
    "subject": "service:00000000000000000000000000000000.access",
    "tools": ["boat", "cloudflare", "workos", "railway", "planetscale"]
  }]
}
```

For staff identities use `user:<Access sub>`. Issue a distinct identity for each client or team member so access can be withdrawn independently. Removing a principal from the policy and restarting the service invalidates its access on the next request.

| Tool | Server-side target | Service-only credential |
| --- | --- | --- |
| Boat | `BOAT_BILLING_ORG`, exact team ID | `BOAT_API_KEY`, scoped to read that wallet |
| Cloudflare | `CLOUDFLARE_ZONE_ID` | `CLOUDFLARE_API_TOKEN`, Zone Read for that zone |
| WorkOS | `WORKOS_ORGANIZATION_ID` | `WORKOS_API_KEY`, organization read in the selected WorkOS environment |
| Railway | `OPS_RAILWAY_SERVICE_ID`, `OPS_RAILWAY_ENVIRONMENT_ID` | `RAILWAY_PROJECT_TOKEN`, scoped to that project environment |
| PlanetScale | `PLANETSCALE_ORG`, `OPS_PLANETSCALE_DATABASE` | `PLANETSCALE_SERVICE_TOKEN_ID`, `PLANETSCALE_SERVICE_TOKEN`, with database read access |

Run one replica for the initial deployment. The process limits each authenticated principal to 60 requests per minute, rejects batches, and applies an eight-second provider deadline. Retain the service's structured output in restricted operator logs. Tool execution records include the principal, organization, environment, provider and outcome. The tools perform diagnostics in all environments. Team role administration and Production mutation grants are separate rollout work.

After a successful call through each authorized client, remove its previous direct provider integrations and revoke obsolete provider credentials at their issuers. Check shared installations for other consumers before revocation.
