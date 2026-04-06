# Changelog

All notable changes to contextual-tenant-sync are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses semantic versioning with a floating major tag. The `v1` tag always points to the latest `v1.x.y` release.

---

## [1.2.1] — 2026-04-06

### Changed
- Context file sync step replaced `curl | node` with a proper composite action (`context-sync/action.yml`), eliminating the security anti-pattern of downloading and executing code at runtime. The step is now version-pinned via `uses: .../context-sync@v1` and auditable in GitHub's action log.

---

## [1.2.0] — 2026-04-06

### Added
- `sync_context_files.ts` — TypeScript rewrite of the Python context sync script. Zero Python in the repo.
- `sync_context_files.js` — compiled output, runs with bare `node`.
- `tsconfig.json` updated to compile both `export.ts` and `sync_context_files.ts`.

### Removed
- `sync_context_files.py` — replaced by TypeScript equivalent.

### Changed
- Reusable workflow now runs `node sync_context_files.js` instead of `python3 sync_context_files.py`.

---

## [1.1.0] — 2026-04-06

### Added
- `.github/workflows/reusable-sync.yml` — full pipeline as a `workflow_call` reusable workflow. Tenant repos now contain a 17-line caller (`sync.yml`) instead of the full workflow logic. All pipeline changes propagate automatically via the floating `@v1` tag with no per-tenant changes required.
- `context-sync/action.yml` — composite action that runs `sync_context_files.js` via `github.action_path`. Called from the reusable workflow.
- `sync_context_files.py` — syncs universal sections of `.rules` and `CLAUDE.md` into tenant repos (superseded by TypeScript in v1.2.0).
- `rules.base.md` / `CLAUDE.base.md` — universal AI context files. Auto-synced to every tenant repo on every run. Two-section design: universal section overwritten by CI, tenant section preserved.

### Changed
- `.github/workflows/sync.yml` is intentionally absent from the auto-sync mechanism. Workflow files cannot be pushed by `GITHUB_TOKEN`. The tenant `sync.yml` is a stable 17-line reusable-workflow caller that rarely changes.
- `git add` in the commit step covers `tenant-snapshot/`, `.rules`, and `CLAUDE.md` only. No workflow files staged.

---

## [1.0.0] — 2026-04-06

### Added
- Initial TypeScript release. Functional equivalent of `contextual-snapshot-export-action` (Python), rewritten in TypeScript with zero runtime dependencies.
- `export.ts` — CLI-free snapshot exporter using Node 18+ built-in `fetch` and `node:fs/promises`. No npm packages at runtime.
- `export.js` — compiled CommonJS output. Committed alongside source so the action runs with bare `node` — no npm install at runtime.
- `action.yml` — composite action wiring `client_id`, `client_secret`, `tenant_id`, `silo`, `out`, and `skip_examples` inputs. Uses `actions/setup-node@v4`.
- OAuth2 client credentials token exchange: `POST https://auth.<tenant>.my[.<silo>].contextual.io/oauth/token` with JSON body. Audience derived from silo (`https://contextual/no-api` for prod, `https://contextual-<silo>/no-api` otherwise). Token cached in-process with 60-second expiry buffer.
- Full pagination for all record and type fetches.
- Flow post-processing: per-flow `summary.md` and extracted code files. Node types and extensions:
  - `function` → `.js`
  - `python-function` → `.py`
  - `template` with `syntax: "mustache"` → `.mustache`
  - `template` with `syntax: "plain"` → `.txt`
- Secret redaction via platform-declared dot-paths and heuristic key-name scan.
- `manifest.json` with per-record name, type, hash, version, updatedAt, and syncedAt.
- Change summary diff against previous manifest on every run.
- Stale file cleanup with interactive prompt (or `--yes` for CI).
- `--skip-examples` flag to skip exemplar record fetching for object types.
- Eager auth check at startup surfaces credential errors immediately.

---

## History note

This repo supersedes `JamesStolp/contextual-snapshot-export-action-ts`. The Python equivalent (`JamesStolp/contextual-snapshot-export-action`) remains available and is maintained separately. The architectural decisions, design rationale, and full version history for the Python implementation are documented in [DECISIONS.md](DECISIONS.md).