# speedrun — Contextual Platform Snapshot

Shared snapshot of the `speedrun` tenant on the Contextual platform (prod). Updated automatically every 30 minutes by GitHub Actions.

---

## Quick Start

### First-time setup

```bash
git clone https://github.com/JamesStolp/snapshot-speedrun--prod.git .
```

### Stay up to date

```bash
git pull
```

### Trigger an immediate sync (outside the 30-minute schedule)

```bash
gh workflow run sync.yml --repo JamesStolp/snapshot-speedrun--prod
# then git pull once the run completes (~15–20 seconds)
```

Or from the browser: **Actions → Sync Contextual Snapshot → Run workflow**.

### Get example records for object types

Examples are not committed to git — download them as a GitHub Actions artifact when needed for a session:

```bash
gh run list --repo JamesStolp/snapshot-speedrun--prod --workflow=sync.yml --limit 1
# note the run ID, then:
gh run download <run-id> \
  --repo JamesStolp/snapshot-speedrun--prod \
  -n object-type-examples \
  --dir tenant-snapshot/components/object-types
```

Or browse and download directly: **Actions → latest run → Artifacts → object-type-examples**.

### Session wrap-up

At the end of an AI session, load the wrap-up prompt to capture durable insights into `team-context/`:

```bash
/file team-context/prompts/session-wrap-up.md
```

The prompt runs `git status` and `git diff` to see what changed, identifies what's worth preserving, drafts content for review, and suggests the git commands to branch, commit, and push.

---

## What's in this repo

```
tenant-snapshot/              ← written by CI only, never edit manually
  manifest.json               ← inventory: every record, hash, version, syncedAt
  registry-api.openapi.json   ← live OpenAPI spec from the platform registry
  components/
    flows/                    ← flow JSON + per-tab extracted .js/.html + summary.md
    connections/              ← api-configuration records
    agents/
    ai-routes/
    authorization-code-apps/
    jwks-configurations/
    object-types/             ← schema.json per type (examples/ gitignored)
team-context/                 ← human-authored, team-maintained via PRs
  sources.md                  ← map of external context sources (Slack, Drive, etc.)
  prompts/                    ← reusable AI prompts; load with /file
  reference/                  ← specs, docs, external links
  decisions/                  ← architectural and operational decision records
  runbooks/                   ← step-by-step operational procedures
  analysis/                   ← durable AI-assisted findings worth preserving
.rules                        ← universal section CI-synced; tenant section PR-managed
CLAUDE.md                     ← universal section CI-synced; tenant section PR-managed
NOTES.md                      ← shared knowledge base (team-maintained)
```

---

## Rules

- **Never manually edit or commit files under `tenant-snapshot/`.** It is written exclusively by the CI job. Manual edits will be overwritten on the next sync.
- **`team-context/`** and other human-authored files are changed via PRs so the team can review and discuss.
- **The universal sections of `.rules` and `CLAUDE.md`** are overwritten by CI on every sync run. Edit only the tenant section below the `<!-- TENANT SECTION` marker.
- **Example records** are excluded from git to avoid commit noise from transactional churn. Download them as an artifact when needed (see Quick Start above).

---

## Sync details

Powered by [contextual-snapshot-export-action](https://github.com/JamesStolp/contextual-snapshot-export-action) — a CLI-free, OAuth2 client credentials exporter. The action runs on a 30-minute schedule and:

- Commits any changed snapshot files to `tenant-snapshot/`
- Uploads object type examples as an artifact with 7-day retention
- Re-syncs the universal sections of `.rules` and `CLAUDE.md` from the action repo
- Re-syncs `sync.yml` itself from the action repo (self-updating workflow)

A commit only appears when something actually changed — unchanged runs produce no commit. `tenant_id` and `silo` are stored as GitHub repository variables (`CTXL_TENANT_ID`, `CTXL_SILO`), not hardcoded in the workflow.