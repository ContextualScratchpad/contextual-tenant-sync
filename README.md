# contextual-tenant-sync

A GitHub Action and reusable workflow for syncing Contextual platform tenant state into a shared, versioned git repository — giving every team member consistent, always-current platform context for AI-assisted sessions.

Every 30 minutes the action fetches all platform components (flows, connections, agents, object types), extracts node code into individual files (`.js` for function nodes, `.py` for python-function nodes, `.mustache` / `.txt` for template nodes), renders flow summaries as Markdown, and commits the result. A commit only appears when something actually changed.

---

## Creating a new tenant repo

### Prerequisites

- [`gh` CLI](https://cli.github.com/) installed and authenticated
- A Contextual platform API key (Client ID + Client Secret) for the tenant

### Steps

```bash
# 1. Create the repo from the template
#    Replace <your-org> with your GitHub org or personal account name
gh repo create <your-org>/snapshot-<tenant-id>--<silo> \
  --private \
  --template JamesStolp/tenant-snapshot-template \
  --description "Contextual platform snapshot — tenant: <tenant-id> (<silo>)"

# 2. Set non-sensitive config as repository variables
gh variable set CTXL_TENANT_ID --body "<tenant-id>" \
  --repo <your-org>/snapshot-<tenant-id>--<silo>
gh variable set CTXL_SILO      --body "<silo>" \
  --repo <your-org>/snapshot-<tenant-id>--<silo>

# 3. Set credentials as repository secrets
#    (each command prompts for the value interactively)
gh secret set CTXL_CLIENT_ID     --repo <your-org>/snapshot-<tenant-id>--<silo>
gh secret set CTXL_CLIENT_SECRET --repo <your-org>/snapshot-<tenant-id>--<silo>

# 4. Trigger the first sync
gh workflow run sync.yml --repo <your-org>/snapshot-<tenant-id>--<silo>

# 5. Clone locally once the run completes (~30 seconds)
git clone https://github.com/<your-org>/snapshot-<tenant-id>--<silo>.git .
git pull
```

### After first sync

Fill in the tenant sections of `.rules` and `CLAUDE.md` — these are auto-loaded into every AI session and are the most important step for grounding the assistant in your tenant's domain:

```bash
git checkout -b setup/tenant-context
# Edit .rules  — fill in: what this tenant does, domain concepts, constraints
# Edit CLAUDE.md — same content, read by Claude Code
git add .rules CLAUDE.md
git commit -m "context: add tenant context for <tenant-id>"
git push origin setup/tenant-context
# Open PR on GitHub → merge
```

Replace the template README with a tenant-specific one. See the [speedrun-snapshot README](https://github.com/JamesStolp/snapshot-speedrun--prod/blob/main/README.md) as a reference example.

**Repo naming convention:** `snapshot-<tenant-id>--<silo>` — the double-dash separates the tenant ID from the silo unambiguously, even when tenant IDs contain words like `dev` or `prod`.

---

## What a sync run does

Each run (scheduled every 30 min, or triggered manually) executes four steps:

1. **Syncs context files** — runs [`context-sync`](context-sync/action.yml) which fetches the universal sections of `.rules` and `CLAUDE.md` from this repo and merges them with the tenant-specific sections already in the tenant repo. Tenant sections are always preserved.

2. **Exports the snapshot** — runs [`export.ts`](export.ts) which authenticates via OAuth2 client credentials, fetches all platform records via the REST API, extracts flow function/template node code into individual files, and writes everything to `tenant-snapshot/`.

3. **Uploads examples** — object type exemplar records are uploaded as a GitHub Actions artifact (`object-type-examples`, 7-day retention) rather than committed, to avoid noisy commits from transactional record churn. Download on demand: `gh run download <run-id> --repo <repo> -n object-type-examples --dir tenant-snapshot/components/object-types`.

4. **Commits if changed** — stages `tenant-snapshot/`, `.rules`, and `CLAUDE.md`, and commits only when something actually changed. Unchanged runs produce no commit.

---

## Action inputs

The composite action ([`action.yml`](action.yml)) can be used standalone for the export step only:

```yaml
- uses: ContextualScratchpad/contextual-tenant-sync@v1
  with:
    client_id:     ${{ secrets.CTXL_CLIENT_ID }}
    client_secret: ${{ secrets.CTXL_CLIENT_SECRET }}
    tenant_id:     acme
    silo:          prod
```

| Input | Required | Default | Description |
|---|---|---|---|
| `client_id` | Yes | — | Client ID from Contextual platform API key settings |
| `client_secret` | Yes | — | Client Secret from Contextual platform API key settings |
| `tenant_id` | Yes | — | Tenant ID (e.g. `acme`) |
| `silo` | No | `dev` | Platform silo: `dev`, `prod`, or `qa` |
| `out` | No | `tenant-snapshot` | Output directory relative to workspace root |
| `skip_examples` | No | `false` | Skip fetching exemplar records for object types |

For the full sync pipeline, use the reusable workflow:

```yaml
# .github/workflows/sync.yml in each tenant repo
name: Sync Contextual Snapshot
on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:
permissions:
  contents: write
jobs:
  sync:
    uses: ContextualScratchpad/contextual-tenant-sync/.github/workflows/reusable-sync.yml@v1
    with:
      tenant_id: ${{ vars.CTXL_TENANT_ID }}
      silo:      ${{ vars.CTXL_SILO }}
    secrets: inherit
```

---

## Authentication

The platform issues API keys as OAuth2 client credentials (Client ID + Client Secret). The action exchanges these for a bearer token before making API calls:

```
POST https://auth.<tenant>.my[.<silo>].contextual.io/oauth/token
Content-Type: application/json
Body: { grant_type, client_id, client_secret, audience }
```

Audience is derived from the silo: `https://contextual/no-api` (prod) or `https://contextual-<silo>/no-api` (non-prod). Tokens are cached in-process and never written to disk.

---

## Snapshot output structure

```
tenant-snapshot/
  manifest.json                    ← inventory: every record, hash, version, syncedAt
  registry-api.openapi.json        ← live OpenAPI spec
  components/
    flows/
      <id>/
        flow.json                  ← source-of-truth Node-RED JSON
        summary.md                 ← tab/node/wiring overview — read before flow.json
        <Tab Name>/
          <Node Name>.js           ← extracted function node code
          <Node Name>.py           ← extracted python-function node code
          <Node Name>.mustache     ← extracted template node (mustache syntax)
          <Node Name>.txt          ← extracted template node (plain syntax)
    connections/
    agents/
    ai-routes/
    authorization-code-apps/
    jwks-configurations/
    object-types/
      <type-id>/
        schema.json                ← type definition
        examples/                  ← gitignored; available as artifact
```

Secret fields are replaced with `<REDACTED>`.

---

## Repo structure

```
contextual-tenant-sync/
  ── TypeScript action ──────────────────────────────────────────
  export.ts / export.js           ← snapshot exporter (source + compiled)
  sync_context_files.ts / .js     ← context file syncer (source + compiled)
  action.yml                      ← composite action: export step only
  context-sync/
    action.yml                    ← composite action: context file sync step
  .github/workflows/
    reusable-sync.yml             ← reusable workflow: full pipeline
  rules.base.md / CLAUDE.base.md  ← universal AI context files, auto-synced to tenant repos
  ── Build ──────────────────────────────────────────────────────
  tsconfig.json / package.json    ← TypeScript config, devDeps only
  .env.example                    ← for local testing
  ── Templates ──────────────────────────────────────────────────
  templates/
    sync.yml                      ← tenant repo workflow (calls reusable-sync.yml)
    .gitignore                    ← tenant repo gitignore
    snapshot-repo-README.md       ← tenant repo README starting point
  ── Documentation ──────────────────────────────────────────────
  README.md                       ← this file
  ARCHITECTURE.md                 ← full architectural reference
  DECISIONS.md                    ← decision log with rationale
  DIAGRAM.md                      ← architecture diagram (Mermaid)
  CHANGELOG.md                    ← version history
```

---

## Building locally

```bash
npm install        # installs devDependencies: typescript + @types/node only
npm run build      # compiles export.ts and sync_context_files.ts → .js
npm run build:check  # type-check without emitting
```

The compiled `.js` files are committed alongside the TypeScript source so the action can run with bare `node` — no npm install step needed at runtime.

### Testing a change locally

If you need to verify a code change against a real tenant before pushing, run `export.js` directly with credentials exported in your shell:

```bash
export CTXL_CLIENT_ID=<your-client-id>
export CTXL_CLIENT_SECRET=<your-client-secret>
export CTXL_TENANT_ID=<tenant-id>
export CTXL_SILO=prod

node export.js --out ./test-snapshot
```

This is only relevant when developing the action itself. For tenant snapshot repos, credentials live in GitHub Actions secrets and variables — never in a local file.

---

## Versioning

This repo uses semantic versioning with a floating major tag. Tenant repos reference `@v1` and pick up all patch and minor updates automatically.

| Type | Example | Effect |
|---|---|---|
| Patch | `v1.0.1` | Bug fix — auto-applied |
| Minor | `v1.1.0` | New optional input — backward compatible, auto-applied |
| Major | `v2.0.0` | Breaking change — tenants stay on `@v1` until they migrate |

To release:

```bash
git tag v1.x.y
git tag -f v1
git push origin v1.x.y
git push origin v1 --force
```

See [CHANGELOG.md](CHANGELOG.md) for full version history.

---

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — two-repo model, auth mechanics, examples handling, sync workflow design, adding new tenants
- [DECISIONS.md](DECISIONS.md) — every significant decision with context and rationale
- [DIAGRAM.md](DIAGRAM.md) — Mermaid architecture diagram