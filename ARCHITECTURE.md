# Snapshot Export — Architecture Reference

This document reflects the current implemented state of the snapshot export system. It covers structural decisions, auth mechanics, examples handling, and operational details discovered during implementation.

---

## Status

The system is live. The following repos exist and are operational:

| Repo | Purpose | Silo |
|---|---|---|
| `JamesStolp/contextual-snapshot-export-action` | Action repo — tool source of truth | — |
| `JamesStolp/snapshot-speedrun--prod` | Tenant snapshot repo | prod |
| `JamesStolp/snapshot-alba-netchb--dev` | Tenant snapshot repo | dev |

Both snapshot repos run on a 30-minute schedule. The action repo is **public** (required — see Decisions).

---

## Two-Repo Model

### 1. Action Repo — `contextual-snapshot-export-action`

The single source of truth for the export tool. Owned and maintained by the platform team. Contains no per-tenant configuration.

```
contextual-snapshot-export-action/
  export.py
  action.yml
  rules.base.md         ← universal section for .rules, synced to all tenant repos
  CLAUDE.base.md        ← universal section for CLAUDE.md, synced to all tenant repos
  sync_context_files.py ← merges universal base + tenant section for .rules and CLAUDE.md
  tenant-sync.yml       ← reusable workflow called by tenant repos
  CHANGELOG.md
  README.md
```

### 2. Per-Tenant Snapshot Repo — e.g. `snapshot-speedrun--prod`

One repo per tenant. Thin by design — no tool logic, just configuration and outputs.

```
snapshot-speedrun--prod/
  .github/
    workflows/
      sync.yml                ← ~40 lines, calls the action
  tenant-snapshot/            ← written by CI only, never manually edited
    manifest.json
    registry-api.openapi.json
    components/
      flows/
      connections/
      agents/
      ...
      object-types/           ← schemas only; examples/ is gitignored
  .rules                      ← two-section: universal (CI-synced) + tenant-specific (PR-managed)
  CLAUDE.md                   ← two-section: universal (CI-synced) + tenant-specific (PR-managed)
  NOTES.md                    ← shared knowledge base
  team-context/
    sources.md
    reference/
    decisions/
    runbooks/
    analysis/
    prompts/
  .gitignore
```

---

## Authentication

The Contextual platform issues API keys as OAuth 2.0 client credentials — a **Client ID** and **Client Secret** pair, not a static bearer token. The token exchange happens on every process start (with in-process caching).

### Token exchange flow

```
1. POST https://auth.<tenant>.my[.<silo>].contextual.io/oauth/token
   Content-Type: application/json
   Body: {
     "grant_type":    "client_credentials",
     "client_id":     "<CTXL_CLIENT_ID>",
     "client_secret": "<CTXL_CLIENT_SECRET>",
     "audience":      "<derived — see below>"
   }

2. Response: { "access_token": "...", "expires_in": 86400, ... }

3. All subsequent API calls:
   Authorization: Bearer <access_token>
   x-org-id: <tenant_id>
```

### Audience derivation

The audience is derived from the silo — it is not fetched from the platform:

| Silo | Audience |
|---|---|
| `prod` | `https://contextual/no-api` |
| `dev` | `https://contextual-dev/no-api` |
| `qa` | `https://contextual-qa/no-api` |
| other | `https://contextual-<silo>/no-api` |

### Token caching

Tokens are cached in-process with a 60-second expiry buffer. For a single sync run this means one token exchange per process. The token is never written to disk.

### What was tried and did not work

- **Using Auth0 directly** (`contextual.us.auth0.com`) — resolved from `/.well-known/cli-configuration` but returned `access_denied`. The platform proxies auth through its own endpoint.
- **`application/x-www-form-urlencoded` body** — the platform expects JSON, not form-encoded, despite that being the OAuth2 spec default.

---

## Examples Handling

Object type exemplar records (up to 10 most-recent per type) are **not committed to git**. They are gitignored and instead uploaded as a GitHub Actions artifact on every sync run.

### Why

Example records are transactional — they change whenever any record in the type is created or updated. Committing them would generate a snapshot commit on every sync run even when nothing meaningful changed on the platform, making the git history noisy and uninformative.

### How it works

1. CI fetches examples as part of every sync run (written to disk on the runner)
2. Examples are uploaded as a `object-type-examples` artifact (7-day retention)
3. `tenant-snapshot/components/object-types/*/examples/` is gitignored — never committed
4. Schemas (`schema.json`) for each type **are** committed — they change rarely and meaningfully

### Accessing examples locally

No local script needed. Download the latest artifact via the `gh` CLI:

```bash
gh run download <run-id> \
  --repo JamesStolp/snapshot-speedrun--prod \
  -n object-type-examples \
  --dir tenant-snapshot/components/object-types
```

Or browse and download directly from the GitHub Actions UI: **Actions → latest run → Artifacts → object-type-examples**.

The artifact is refreshed on every sync run and expires automatically after 7 days.

### `--skip-examples` flag

`export.py` accepts `--skip-examples` to skip both fetching and writing examples entirely. Useful for fast local syncs when only schemas and flow code are needed. The action's `skip_examples` input (default `false`) wires this through.

---

## Action Repo — Key Files

### `action.yml`

```yaml
name: "Contextual Snapshot Export"
description: "Export a Contextual platform snapshot using OAuth2 client credentials."

inputs:
  client_id:
    description: "Client ID from the Contextual platform API key settings"
    required: true
  client_secret:
    description: "Client Secret from the Contextual platform API key settings"
    required: true
  tenant_id:
    description: "Tenant ID (e.g. acme)"
    required: true
  silo:
    description: "Platform silo: dev or prod"
    required: false
    default: "dev"
  out:
    description: "Output directory (relative to the workspace root)"
    required: false
    default: "tenant-snapshot"
  skip_examples:
    description: "Skip fetching exemplar records. Set true for faster syncs when examples are not needed."
    required: false
    default: "false"

runs:
  using: "composite"
  steps:
    - uses: actions/setup-python@v5
      with:
        python-version: "3.11"
    - name: Run snapshot export
      env:
        FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
        CTXL_CLIENT_ID: ${{ inputs.client_id }}
        CTXL_CLIENT_SECRET: ${{ inputs.client_secret }}
        CTXL_TENANT_ID: ${{ inputs.tenant_id }}
        CTXL_SILO: ${{ inputs.silo }}
      run: |
        python3 "${{ github.action_path }}/export.py" \
          --out "${{ inputs.out }}" \
          --yes \
          ${{ inputs.skip_examples == 'true' && '--skip-examples' || '' }}
      shell: bash
```

---

## Per-Tenant Repo — Key Files

### `.github/workflows/sync.yml`

```yaml
name: Sync Contextual Snapshot

on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:

jobs:
  sync:
    name: Export & commit snapshot
    runs-on: ubuntu-latest
    permissions:
      contents: write

    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true

    steps:
      - uses: actions/checkout@v4

      - name: Sync shared context files (.rules + CLAUDE.md universal sections)
        run: |
          curl -fsSL \
            https://raw.githubusercontent.com/JamesStolp/contextual-snapshot-export-action/main/sync_context_files.py \
            -o /tmp/sync_context_files.py
          python3 /tmp/sync_context_files.py

      - uses: JamesStolp/contextual-snapshot-export-action@v1
        with:
          client_id:     ${{ secrets.CTXL_CLIENT_ID }}
          client_secret: ${{ secrets.CTXL_CLIENT_SECRET }}
          tenant_id:     ${{ vars.CTXL_TENANT_ID }}
          silo:          ${{ vars.CTXL_SILO }}

      - name: Upload object type examples as artifact
        uses: actions/upload-artifact@v4
        with:
          name: object-type-examples
          path: tenant-snapshot/components/object-types/
          retention-days: 7
          if-no-files-found: ignore

      - name: Commit snapshot if changed
        run: |
          git config user.name  "snapshot-bot[bot]"
          git config user.email "snapshot-bot[bot]@users.noreply.github.com"
          git add tenant-snapshot/ .rules CLAUDE.md
          if git diff --cached --quiet; then
            echo "No snapshot changes detected — nothing to commit."
          else
            git commit -m "chore(snapshot): sync $(date -u +%Y-%m-%dT%H:%M:%SZ)"
            git push
          fi
```

`CTXL_CLIENT_ID` and `CTXL_CLIENT_SECRET` are GitHub Actions secrets. `tenant_id` and `silo` are sourced from GitHub repository variables (`vars.CTXL_TENANT_ID` and `vars.CTXL_SILO`), set via Settings → Variables → Actions.

### `.gitignore`

```
# Local credentials — never commit
.env

# Exemplar records fetched on demand via artifact download, not tracked in git
tenant-snapshot/components/object-types/*/examples/
```

---

## Configuration Ownership

| Item | Location | Who manages it |
|---|---|---|
| `export.py` | Action repo | Platform team |
| `action.yml` | Action repo | Platform team |
| Sync schedule (cron) | Tenant repo `sync.yml` | Tenant team |
| `tenant_id` | Tenant repo `sync.yml` (via `vars.CTXL_TENANT_ID`) | Tenant admin |
| `silo` | Tenant repo `sync.yml` (via `vars.CTXL_SILO`) | Tenant admin |
| `CTXL_CLIENT_ID` | GitHub Actions secret | Tenant admin |
| `CTXL_CLIENT_SECRET` | GitHub Actions secret | Tenant admin |
| `CTXL_TENANT_ID` | GitHub repository variable (Settings → Variables) | Tenant admin |
| `CTXL_SILO` | GitHub repository variable (Settings → Variables) | Tenant admin |
| `.rules` universal section | Action repo (`rules.base.md`) | CI — overwritten on every sync run |
| `.rules` tenant section | Tenant repo (below marker in `.rules`) | Tenant team via PRs |
| `CLAUDE.md` universal section | Action repo (`CLAUDE.base.md`) | CI — overwritten on every sync run |
| `CLAUDE.md` tenant section | Tenant repo (below marker in `CLAUDE.md`) | Tenant team via PRs |
| `team-context/` | Tenant repo | Tenant team via PRs |
| `tenant-snapshot/` | Tenant repo, CI-written | CI job only |
| `object-type-examples` artifact | GitHub Actions artifacts | CI job only |

---

## Versioning Strategy

The action repo uses **semantic versioning** with a **floating major tag**.

- Each release is tagged `v1.x.y` (immutable)
- A `v1` tag is a mutable pointer to the latest `v1.x.y` release
- Tenant repos reference `@v1` — they pick up fixes and additions automatically with no workflow changes
- A breaking change increments the major version to `v2`; tenant repos stay on `@v1` until they explicitly migrate

### Semver interpretation

| Type | Example | Effect on tenants |
|---|---|---|
| Patch | `v1.0.1` | Bug fix — auto-applied, safe |
| Minor | `v1.1.0` | New optional input or output — backward compatible, auto-applied |
| Major | `v2.0.0` | Breaking change — tenants stay on `@v1` until they migrate |

### Release commands

```bash
git tag v1.2.3
git tag -f v1
git push origin v1.2.3
git push origin v1 --force
```

A `CHANGELOG.md` is mandatory with this strategy — it is how tenant teams know what changed under them.

### Node.js version

All workflows set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` at the job level. The referenced actions (`actions/checkout`, `actions/setup-python`, `actions/upload-artifact`) currently target Node 20 but are forced to Node 24. This resolves the deprecation warning and avoids future forced migration. Update to drop the env var once upstream actions natively target Node 24.

---

## What Happens to `git-backed-sync-script/`

This folder in the local project is a **reference and staging area**, not infrastructure. The action repo on GitHub is the source of truth for `export.py` and `action.yml`.

Files worth keeping here:
- `ARCHITECTURE.md` — this file
- `DECISIONS.md` — decision log
- `README.md` — how-to guide

Files that are stale copies (maintained here for reference only — edit in the action repo):
- `export.py`
- `action.yml`
- `CHANGELOG.md`
- `rules.base.md`
- `CLAUDE.base.md`
- `sync_context_files.py`

---

## Adding a New Tenant

Repos are named `snapshot-<tenant-id>--<silo>` (e.g. `snapshot-speedrun--prod`, `snapshot-alba-netchb--dev`). The `snapshot-` prefix groups all snapshot repos together. The `--` double-dash separator makes the silo unambiguously distinct from the tenant ID — even when tenant IDs contain words like `dev` or `prod`.

### Step 1 — Create from template

```bash
gh repo create JamesStolp/snapshot-<tenant-id>--<silo> \
  --private \
  --template JamesStolp/tenant-snapshot-template \
  --description "Contextual platform snapshot — tenant: <tenant-id> (<silo>)"
```

`tenant-snapshot-template` is a public GitHub template repo containing the workflow scaffold, `team-context/` structure, and setup README. See [github.com/JamesStolp/tenant-snapshot-template](https://github.com/JamesStolp/tenant-snapshot-template).

### Step 2 — Set config variables

```bash
gh variable set CTXL_TENANT_ID --body "<tenant-id>" --repo JamesStolp/<tenant-id>-snapshot
gh variable set CTXL_SILO      --body "<silo>"      --repo JamesStolp/<tenant-id>-snapshot
```

### Step 3 — Set credentials

Obtain Client ID and Client Secret from the Contextual platform UI (Settings → API Keys → Create Key):

```bash
gh secret set CTXL_CLIENT_ID     --repo JamesStolp/<tenant-id>-snapshot
gh secret set CTXL_CLIENT_SECRET --repo JamesStolp/<tenant-id>-snapshot
```

### Step 4 — Trigger first sync

```bash
gh workflow run sync.yml --repo JamesStolp/<tenant-id>-snapshot
```

The first run populates `tenant-snapshot/`, generates `.rules` and `CLAUDE.md` from the action repo, and commits the result. Takes 15–30 seconds.

### Step 5 — Clone locally

```bash
git clone https://github.com/JamesStolp/<tenant-id>-snapshot.git .
```

### Step 6 — Fill in tenant context

After the first sync, `.rules` and `CLAUDE.md` will have a `<!-- TENANT SECTION` marker. Open a branch, fill in "What this tenant does", "Key domain concepts", and "Critical session constraints" in both files, then open a PR.

```bash
git checkout -b setup/tenant-context
# edit .rules and CLAUDE.md — fill in the tenant sections below the marker
git add .rules CLAUDE.md
git commit -m "context: add tenant context for <tenant-id>"
git push origin setup/tenant-context
# open PR on GitHub
```

### Step 7 — Replace the README

The template README is setup instructions. Replace it with a tenant-specific README once setup is complete. Use the [snapshot-speedrun--prod README](https://github.com/JamesStolp/snapshot-speedrun--prod/blob/main/README.md) as a reference.