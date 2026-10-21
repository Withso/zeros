# Dependency maintenance must cover every installed graph

- **Symptom:** Renovate's marketing Vite upgrade changed only its manifest, so
  frozen workspace installs failed before tests ran. The separate Hono upgrade
  left the distributed license inventory stale.
- **Cause:** Marketing participates in the root workspace and also has a
  standalone Cloudflare lockfile. The control plane has its own dependency graph,
  and the license bundle inventories the exact versions from every deployed
  graph. A standalone command can also select the host's default pnpm instead
  of the repository's pinned version when it ignores the workspace.
- **Rule:** Refresh both marketing lockfiles after changing its manifest. Run
  `pnpm install --lockfile-only` at the root, then
  `pnpm exec pnpm --dir apps/marketing install --ignore-workspace --lockfile-only`
  so the standalone operation uses the repository's pnpm. Hydrate the locked
  graphs, regenerate licenses when their production inventory changes, and
  verify frozen installs and the standalone web build before merging.
- **Enforcement:** Keep the existing frozen-install checks,
  `scripts/prepare-third-party-license-graphs.mjs`, `pnpm check:licenses`, and
  `npm --prefix apps/web run build:standalone`. The deployment boundary is
  documented in `pnpm-workspace.yaml` and both web/marketing READMEs; no weaker
  install mode or duplicate regression test is needed.
