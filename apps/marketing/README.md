# Marketing site

React/Vite source for the public Zeros website. The app participates in the
root pnpm workspace for development, but Cloudflare production installs its
independent lockfile before `apps/web` assembles the Pages artifact. The license
inventory validates both graphs so differing exact transitive versions cannot
escape review.

```bash
pnpm --dir apps/marketing dev
pnpm --dir apps/marketing typecheck
pnpm --dir apps/marketing build
```

`public/schemas/` contains the published settings schemas. Changelog entries
live in `src/content/changelog/`. After dependency changes, refresh the
standalone lockfile consumed by the Cloudflare build:

```bash
cd apps/marketing
pnpm install --ignore-workspace --lockfile-only
```

Deployment routing, domains, and environment configuration are documented in
[apps/web/README.md](../web/README.md).
