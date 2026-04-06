# Snapshot Export — Decision Log

This document records key decisions made during the design and implementation of the snapshot export system, along with the context and reasoning behind each. Ordered roughly chronologically.

---

## 1. Two-repo model: action repo + per-tenant snapshot repo

**Decision:** Extract `export.py` into a dedicated public GitHub Action repo (`contextual-snapshot-export-action`). Each tenant gets a separate snapshot repo that consumes the action via a `uses:` reference.

**Rationale:** Separates tool logic (owned by the platform team, changes infrequently) from tenant configuration (owned per-tenant, varies across repos). A change to `export.py` propagates to all tenant repos automatically via the floating tag — no copy-and-paste maintenance. The snapshot repo stays thin: a workflow file, a `.gitignore`, and the generated snapshot content.

**Alternative considered:** Git submodule pointing to the action repo from within each snapshot repo. Rejected because submodules add friction for developers unfamiliar with git submodule workflows, and the GitHub Action pattern is more idiomatic and better supported.

---

## 2. Floating major tag (`@v1`) over pinned versions

**Decision:** Tenant repos reference `@v1`, a mutable tag that always points to the latest `v1.x.y` release. No Renovate/Dependabot version-bump PRs.

**Rationale:** The team is small, internal, and early in iteration. Bugs and improvements need to reach all tenants quickly without requiring per-repo PRs. The noise risk of automatic updates is acceptable at this stage.

**Trade-off acknowledged:** With a floating tag, a bad release reaches all tenant repos immediately with no review gate. Mitigation is release discipline (see `CHANGELOG.md`) and the fact that a broken sync is recoverable — it produces no commit, it doesn't corrupt the snapshot.

**When to revisit:** When the number of tenant repos grows, or when the team has had a bad floating-tag rollout, switch to pinned versions with Renovate managing bumps.

---

## 3. Action repo must be public

**Decision:** `contextual-snapshot-export-action` is a public GitHub repository.

**Rationale:** Discovered during implementation — GitHub Actions cannot resolve a `uses:` reference to a private repo from another private repo in a personal account without a Personal Access Token. Making the action repo public is the standard pattern for shared GitHub Actions and carries no security risk: the repo contains only `export.py`, `action.yml`, and documentation. No secrets or tenant-specific data are present.

**Note for org migration:** When moving to a GitHub organisation, internal actions (visible only within the org) become an option. The repo could be made internal at that point if desired.

---

## 4. OAuth2 client credentials, not a static bearer token

**Decision:** Authentication uses OAuth2 client credentials flow. The platform issues a `Client ID` and `Client Secret`; the script exchanges these for a short-lived bearer token before making API calls.

**Rationale:** The Contextual platform's API key model issues a Client ID and Client Secret, not a static bearer token. Passing `client_id`/`client_secret` directly as a bearer value would fail. The token exchange adds one network round-trip but produces a standard JWT that all platform endpoints accept.

**Advantage over the CLI-based approach:** The CLI used OAuth device-code flow, which requires a browser and a human to complete. Client credentials is fully headless and suitable for CI. Tokens are cached in-process for their lifetime (typically 1 hour) and refreshed automatically.

---

## 5. Platform auth endpoint, not the Auth0 domain directly

**Decision:** The token exchange URL is derived as `https://auth.<tenant>.my[.<silo>].contextual.io/oauth/token`, not the Auth0 domain returned by `/.well-known/cli-configuration`.

**Rationale:** Initial implementation fetched `domain` from `/.well-known/cli-configuration` and posted to `https://<domain>/oauth/token`. This resolved to `contextual.us.auth0.com/oauth/token` and returned `HTTP 401 access_denied`. The platform proxies token exchange through its own auth endpoint — confirmed via platform API documentation showing `https://auth.<tenant>.my.<silo>.contextual.io/oauth/token` as the correct target.

**Consequence:** The `_fetch_cli_config()` function that fetched `.well-known` was removed entirely. The auth endpoint and audience are both derivable from `tenant_id` and `silo` alone, making the script simpler and removing a dependency on an unauthenticated preflight request.

---

## 6. JSON body for token exchange, not form-encoded

**Decision:** The token exchange POST sends `Content-Type: application/json` with a JSON body.

**Rationale:** The OAuth2 spec (RFC 6749) specifies `application/x-www-form-urlencoded` for token requests, and the initial implementation used that. The Contextual platform auth endpoint requires `application/json`. Confirmed via platform API documentation. Using the wrong content type produces a silent failure or a non-descriptive error.

---

## 7. Derived audience, not fetched

**Decision:** The OAuth audience is derived from the silo: `https://contextual/no-api` for prod, `https://contextual-<silo>/no-api` for all other silos (e.g. `https://contextual-dev/no-api`, `https://contextual-qa/no-api`).

**Rationale:** Confirmed via platform API documentation. Deriving from the silo is simpler and more reliable than fetching it — it removes the `.well-known` preflight request and makes the audience predictable and testable without a live platform connection.

---

## 8. Gitignore examples; upload as GitHub Actions artifact

**Decision:** Exemplar records for object types are excluded from git via `.gitignore`. CI fetches them as usual and uploads `tenant-snapshot/components/object-types/` as a GitHub Actions artifact (`object-type-examples`) with a 7-day retention period. Team members download via `gh run download` when needed for a session.

**Rationale:** Object type exemplar records are the 10 most recent records per type, ordered by `updatedAt`. For transactional or high-activity types, this set shifts on every sync, producing a git commit every 30 minutes that carries no meaningful signal about platform state. Gitignoring examples eliminates this noise while keeping the data available — CI always fetches them (credentials are available there), and the artifact is refreshed on every sync run.

**On `git pull`:** A developer pulling the snapshot gets schemas, flow code, connections, agents, and the manifest — everything stable. Examples are absent from the working directory until explicitly downloaded.

**Download command:**
```bash
gh run download <run-id> \
  --repo JamesStolp/<tenant>-snapshot \
  -n object-type-examples \
  --dir tenant-snapshot/components/object-types
```

**Alternative considered:** A separate git branch (`examples`) maintained by CI with examples force-committed. Rejected because it adds branch management complexity and the branch history would still be noisy.

**Alternative considered:** Keeping examples in git. Rejected due to the commit churn problem described above.

---

## 9. `--skip-examples` flag on `export.py`

**Decision:** A `--skip-examples` CLI flag was added to `export.py`. When set, the script writes only `schema.json` for each object type and skips the exemplar record fetch entirely. The action exposes this as a `skip_examples` input defaulting to `false`.

**Rationale:** Provides flexibility for use cases where examples are not needed and the reduced API call count and faster runtime are preferable (e.g. a quick local schema-only sync, or a future CI context where artifacts are intentionally disabled). The default of `false` means examples are always fetched in CI so the artifact is always fresh.

---

## 10. Node.js 24 opt-in via environment variable

**Decision:** All workflows and the composite action set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true`.

**Rationale:** `actions/checkout@v4`, `actions/setup-python@v5`, and `actions/upload-artifact@v4` currently target Node.js 20, which is deprecated on GitHub Actions runners. Setting this environment variable forces them to run on Node.js 24 immediately, eliminating the deprecation warning and future-proofing against the forced cutover (June 2026). The actions function correctly on Node.js 24.

**When to remove:** Once the upstream action maintainers publish versions that natively target Node.js 24, pin to those versions and remove the env var.

---

## 11. Per-tenant snapshot repo per tenant

**Decision:** Each tenant gets its own snapshot repo (e.g. `speedrun-snapshot`, `alba-netchb-snapshot`), not a single multi-tenant repo.

**Rationale:** Keeps secrets isolated per tenant (each repo has its own `CTXL_CLIENT_ID` and `CTXL_CLIENT_SECRET`). Keeps git history clean per tenant — changes to one tenant's platform state don't appear in another tenant's commit log. Access control is per-repo. The action repo absorbs all the shared logic, so per-tenant repos are thin enough that the duplication cost is negligible.

---

## 12. Directory naming — `tenant-snapshot/` and `team-context/`

**Decision:** The two top-level content directories were named to make their origin and maintenance model immediately clear:

- `tenant-snapshot/` — replaces the earlier name `contextual-snapshot/`. "Tenant" is more generic and portable across different platform contexts; "snapshot" accurately describes the point-in-time capture nature of the content.

- `team-context/` — replaces the earlier candidate names `reference-material/` and `shared-context/`. "Shared-context" was rejected because the snapshot itself is also shared context, making the name ambiguous. "Team-context" distinguishes the human-authored interpretive layer (owned by the team, updated via PRs) from the machine-generated platform state (owned by CI). The contrast between "tenant" (the thing) and "team" (the people) makes the two directories immediately distinguishable in a directory listing.

`team-context/` contains: `sources.md` (external context map), `reference/`, `decisions/`, `runbooks/`, `analysis/`.

`sources.md` is a structured Markdown file that maps external context sources (Slack channels, Google Drive documents, Notion pages, etc.) relevant to AI-assisted sessions on the tenant. Today it is read passively by AI assistants. As MCP integrations for these services become available, it becomes an active routing directive telling the assistant which external resources to query for a given session.

---

## 13. Two-section `.rules` and `CLAUDE.md` — universal synced, tenant preserved

**Decision:** Both `.rules` (read by Zed) and `CLAUDE.md` (read by Claude Code) follow a two-section structure within a single file. The universal section is overwritten on every sync run by downloading from the action repo. The tenant section (below a `<!-- TENANT SECTION` marker) is never touched by CI and is maintained by the team via PRs.

**Rationale:** Both files are auto-loaded into the AI assistant's context at session start — unlike `team-context/` files which require explicit retrieval. This makes them the right place for critical always-on context. But their content naturally splits into two categories: universal behavioral rules (same for every tenant, should propagate automatically) and tenant-specific critical context (varies per tenant, must be human-maintained). The two-section approach handles both in one file without any complexity on the consumer side. A clear HTML comment marker makes the boundary explicit.

The sync mechanism: each workflow run downloads `sync_context_files.py` from the action repo, which fetches `rules.base.md` and `CLAUDE.base.md`, detects the marker in any existing file, and writes: universal section + preserved tenant section. New repos without an existing tenant section get a template placeholder appended automatically.

**Alternative considered:** Separate files — a synced `rules.universal.md` and a manual `rules.tenant.md`. Rejected because AI tools read specific filenames (`.rules`, `CLAUDE.md`) and adding a second file would require explicit loading, defeating the auto-loaded benefit.

**Alternative considered:** Keeping `.rules` fully synced (no tenant section). Rejected because it eliminates the ability to add tenant-specific always-on context — forcing everything tenant-specific into `team-context/` where it requires retrieval rather than being automatically in context.

---

## 14. All universal platform knowledge in `rules.base.md` — not split with `team-context/reference/`

**Decision:** The full body of universal platform knowledge (prerequisites, order of operations, snapshot structure, grep patterns, HTTP URL patterns, error handling, debugging, creating agents, creating object types, incremental delivery methodology) lives in `rules.base.md` and is therefore always in context at session start.

**Rationale:** The original project `.rules` contained this knowledge and it proved its value — the AI assistant performed better with it always present than without it. The alternative was to split it: keep short behavioral rules in `rules.base.md` and move detailed reference (object type schema, relations syntax, etc.) to `team-context/reference/` for retrieval. This was explicitly rejected in favour of putting everything in `rules.base.md` for now.

**Trade-off acknowledged:** A comprehensive `rules.base.md` consumes more context window at session start than a minimal one. This is acceptable at the current team size and session complexity. If context window pressure becomes a problem (e.g. very large `team-context/` files loaded alongside long conversations), the detailed reference sections can be moved to `team-context/reference/platform-notes.md` and retrieved on demand. The decision is intentionally reversible.

**When to revisit:** If context window limits become a practical constraint in sessions, or if the rules file grows to the point where it noticeably crowds out conversation history.

---

## 15. Repo naming convention — `<tenant-id>-<silo>-snapshot`

**Decision:** Tenant snapshot repos are named `<tenant-id>-<silo>-snapshot` (e.g. `speedrun-snapshot`, `alba-netchb-snapshot`).

**Rationale:** The silo (prod/dev/qa) is operationally significant and must be immediately visible without opening the repo. Placing it between the tenant name and the `-snapshot` suffix means repos sort alphabetically by tenant first — so `speedrun-dev-snapshot` and `speedrun-snapshot` appear together in a list — while the silo is still prominent and unambiguous. The `-snapshot` suffix is kept at the end for consistency and to distinguish these repos from other tenant-related repos in the same account.

**Alternative considered:** Silo as prefix (`prod-speedrun-snapshot`). Rejected because it groups by silo rather than by tenant, and the primary navigation question is "show me all repos for this tenant", not "show me all prod repos".

**Superseded by Decision 17.** The silo was later dropped from the repo name entirely.

---

## 16. `CTXL_TENANT_ID` and `CTXL_SILO` as GitHub repository variables, not hardcoded in sync.yml

**Decision:** `tenant_id` and `silo` are stored as GitHub repository variables (`vars.CTXL_TENANT_ID`, `vars.CTXL_SILO`) rather than hardcoded values in `sync.yml`. `sync.yml` uses `${{ vars.CTXL_TENANT_ID }}` and `${{ vars.CTXL_SILO }}` in the action `with:` block.

**Rationale:** This makes `sync.yml` fully universal — zero tenant-specific content. The file can therefore be synced from the action repo on every run (via `sync_context_files.py`), ensuring all tenant repos always run the latest workflow without any manual file editing. Repository variables are the GitHub-native mechanism for non-sensitive per-repo configuration, distinct from secrets (which are for sensitive values). `tenant_id` and `silo` are not sensitive — they're visible in platform URLs and are the right fit for variables rather than secrets.

**Consequence:** Adding a new tenant repo requires setting four values in GitHub settings: two secrets (`CTXL_CLIENT_ID`, `CTXL_CLIENT_SECRET`) and two variables (`CTXL_TENANT_ID`, `CTXL_SILO`). No file editing is required. The `sync.yml` from the template is already the final correct file.

---

## 17. Repo naming convention revised — `<tenant-id>-snapshot` (silo dropped from name)

**Decision:** Tenant snapshot repos are named `<tenant-id>-snapshot` (e.g. `speedrun-snapshot`, `alba-netchb-snapshot`). The Contextual platform silo is NOT included in the repo name. **Supersedes Decision 15.**

**Rationale:** Decision 15 introduced `<tenant-id>-<silo>-snapshot`. This broke down when tenant IDs themselves contain environment-like words. A customer may have both `alba` (their production tenant) and `alba-dev` (their development tenant), both running in the Contextual `prod` silo. Under the old convention, `alba-dev-prod-snapshot` reads as "dev-prod" which looks contradictory and is genuinely confusing to scan. Any hyphen-based silo encoding will have this collision risk as tenant naming gets complex.

The silo is not lost — it is stored in the `CTXL_SILO` GitHub repository variable (visible at Settings → Variables) and stated in the repo description. The repo name encodes only the canonical tenant identifier, which is stable and unambiguous. Anyone who needs the silo can find it with one click.

**Examples:**
- Tenant `speedrun` on prod silo → `speedrun-snapshot` (description: "tenant: speedrun (prod)")
- Tenant `alba` on prod silo → `alba-snapshot`
- Tenant `alba-dev` on prod silo → `alba-dev-snapshot`
- Tenant `alba` on dev silo → `alba-snapshot` on a different GitHub account/org, or distinguished by description

**Note on existing repos:** `speedrun-snapshot` and `alba-netchb-snapshot` were briefly named `speedrun-prod-snapshot` and `alba-netchb-dev-snapshot` under Decision 15 before this convention was adopted. They were renamed back to the silo-free form.

**Superseded by Decision 19.** Dropping the silo entirely fails when the same tenant ID exists in multiple silos, requiring a naming collision.

## 18. Template repo for new tenant bootstrapping — `tenant-snapshot-template`

**Decision:** New tenant snapshot repos are created from a GitHub template repo (`JamesStolp/tenant-snapshot-template`) using `gh repo create --template`. After creation, four values are set in GitHub settings (two secrets, two variables), the first workflow is triggered manually, and the tenant sections of `.rules` and `CLAUDE.md` are filled in via a PR. No files need to be edited locally and no scripts need to be run.

**Rationale:** Two approaches were evaluated:

- **Workflow dispatch in the action repo** — a `create-tenant.yml` workflow triggered via `gh workflow run` that creates the snapshot repo programmatically. Rejected because it requires a PAT with repo-creation permissions stored as a secret in the action repo, and adds a complex workflow that is hard to debug if it fails.

- **Template repo** — GitHub's native template repository feature. `gh repo create --template` copies all files in one command. Chosen because it requires no PAT, no extra workflow, no additional tooling. The post-creation steps (setting four GitHub values and triggering one workflow run) are the minimum possible overhead given that credentials must always be supplied by a human.

**What the template contains:**
- `.github/workflows/sync.yml` — the canonical universal workflow (will be overwritten on the first sync run by `sync_context_files.py` anyway, but must exist for the first run to execute)
- `team-context/` structure — `README.md`, `sources.md` stub, `prompts/session-wrap-up.md`, and `.gitkeep` files for subdirectories
- `.gitignore` — excludes `.env` and `tenant-snapshot/components/object-types/*/examples/`
- `README.md` — setup instructions for the person creating the new tenant repo (not a tenant-specific README — that gets written after setup)
- `NOTES.md` — stub

**What the template intentionally omits:**
- `.rules` and `CLAUDE.md` — these are generated from scratch by `sync_context_files.py` on the first sync run. Including stubs in the template would immediately be overwritten and adds no value.
- Any tenant-specific content — the template is deliberately generic. Tenant identity lives in GitHub repository variables and the tenant sections of `.rules`/`CLAUDE.md`.

**Full new-tenant command sequence:**
```bash
gh repo create JamesStolp/<tenant-id>-snapshot \
  --private \
  --template JamesStolp/tenant-snapshot-template \
  --description "Contextual platform snapshot — tenant: <tenant-id> (<silo>)"

gh variable set CTXL_TENANT_ID --body "<tenant-id>" --repo JamesStolp/<tenant-id>-snapshot
gh variable set CTXL_SILO      --body "<silo>"      --repo JamesStolp/<tenant-id>-snapshot

gh secret set CTXL_CLIENT_ID     --repo JamesStolp/<tenant-id>-snapshot
gh secret set CTXL_CLIENT_SECRET --repo JamesStolp/<tenant-id>-snapshot

gh workflow run sync.yml --repo JamesStolp/<tenant-id>-snapshot
# then: git clone, git pull, fill in .rules and CLAUDE.md tenant sections via PR
```

## 19. Final repo naming convention — `snapshot-<tenant-id>--<silo>`

**Decision:** Tenant snapshot repos are named `snapshot-<tenant-id>--<silo>` (e.g. `snapshot-speedrun--prod`, `snapshot-alba-netchb--dev`). **Supersedes Decision 15 and Decision 17.**

**Rationale:** Three naming approaches were evaluated across decisions 15, 17, and 19:

- **Decision 15:** `<tenant-id>-<silo>-snapshot` — rejected because tenant IDs can contain silo-like words (e.g. `alba-dev`), making `alba-dev-prod-snapshot` visually contradictory.
- **Decision 17:** `<tenant-id>-snapshot` (silo dropped) — rejected because the same tenant ID can exist in multiple Contextual silos (e.g. `mytenant` in both dev and prod). Without the silo, two repos would have the same name — a hard GitHub constraint.
- **Decision 19:** `snapshot-<tenant-id>--<silo>` — chosen.

**Why this convention works:**
- `snapshot-` prefix: groups all snapshot repos alphabetically in a GitHub account; immediately identifies the repo type.
- `--` double-dash separator: visually unambiguous boundary between tenant ID and silo label, regardless of what the tenant ID contains. `snapshot-alba-dev--prod` clearly reads as "snapshot of `alba-dev` tenant, `prod` silo" — the `--prod` is visually distinct.
- Silo suffix: disambiguates repos when the same tenant ID spans multiple silos.

**Examples:**
- `snapshot-speedrun--prod` (tenant: speedrun, prod silo)
- `snapshot-alba-netchb--dev` (tenant: alba-netchb, dev silo)
- `snapshot-mytenant--dev` and `snapshot-mytenant--prod` (same tenant, two silos — no collision)
- `snapshot-alba-dev--prod` (tenant name contains "dev", silo is prod — unambiguous via `--`)

**Note on previous repos:** `speedrun-snapshot` and `alba-netchb-snapshot` were renamed twice during convention exploration before this final form was adopted.