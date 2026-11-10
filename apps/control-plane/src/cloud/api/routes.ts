import { createCloudApiBoundary, cloudApiCreateLimit, type CloudApiDependencies } from "./boundary.js";
export type { CloudApiDependencies } from "./boundary.js";

export function createCloudApiRoutes({ credentials, service }: CloudApiDependencies) {
  const app = createCloudApiBoundary(credentials);
  app.get("/me", c => c.json(service.me(c.get("cloudApiCredential"))));
  app.get("/models", c => c.json(service.models()));
  app.get("/repositories", async c => c.json(await service.repositories(c.get("cloudApiCredential"), c.req.query())));
  app.get("/workspaces", async c => c.json(await service.workspaces(c.get("cloudApiCredential"), c.req.query())));
  app.post("/workspaces", cloudApiCreateLimit(),
    async c => c.json(await service.createWorkspace(c.get("cloudApiCredential"), await c.req.json().catch(() => null), c.req.header("idempotency-key")), 201));
  app.get("/workspaces/:id", async c => c.json(await service.workspace(c.get("cloudApiCredential"), c.req.param("id"))));
  app.get("/workspaces/:id/status", async c => c.json(await service.workspaceStatus(c.get("cloudApiCredential"), c.req.param("id"))));
  app.post("/workspaces/:id/rename", async c => c.json(await service.renameWorkspace(c.get("cloudApiCredential"), c.req.param("id"), await c.req.json().catch(() => null))));
  for (const action of ["archive", "unarchive", "sleep", "wake"] as const)
    app.post(`/workspaces/:id/${action}`, async c => c.json(await service.lifecycle(c.get("cloudApiCredential"), c.req.param("id"), action)));
  app.get("/workspaces/:id/sessions", async c => c.json(await service.sessions(c.get("cloudApiCredential"), c.req.param("id"), c.req.query())));
  app.post("/sessions", async c => c.json(await service.createSession(c.get("cloudApiCredential"), await c.req.json().catch(() => null)), 201));
  app.get("/sessions/:id", async c => c.json(await service.getSession(c.get("cloudApiCredential"), c.req.param("id"))));
  app.get("/sessions/:id/status", async c => c.json(await service.sessionStatus(c.get("cloudApiCredential"), c.req.param("id"))));
  app.post("/sessions/:id/cancel", async c => c.json(await service.cancelSession(c.get("cloudApiCredential"), c.req.param("id"))));
  app.post("/sessions/:id/rename", async c => c.json(await service.renameSession(c.get("cloudApiCredential"), c.req.param("id"), await c.req.json().catch(() => null))));
  for (const action of ["archive", "unarchive"] as const)
    app.post(`/sessions/:id/${action}`, async c => c.json(await service.archiveSession(c.get("cloudApiCredential"), c.req.param("id"), action === "archive")));
  app.get("/sessions/:id/messages", async c => c.json(await service.messages(c.get("cloudApiCredential"), c.req.param("id"), c.req.query())));
  app.get("/sessions/:id/messages/:messageId", async c => c.json(await service.message(c.get("cloudApiCredential"), c.req.param("id"), c.req.param("messageId"))));
  app.post("/sessions/:id/messages", async c => {
    const result = await service.sendMessage(c.get("cloudApiCredential"), c.req.param("id"), await c.req.json().catch(() => null));
    return c.json({ message: result.message }, result.replay ? 200 : 201);
  });
  app.all("*", c => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  return app;
}
