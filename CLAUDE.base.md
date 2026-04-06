<!-- ================================================================
     UNIVERSAL SECTION — auto-synced from contextual-snapshot-export-action
     Do not edit this section manually. Changes will be overwritten on
     the next sync run. To propose a change, open a PR against:
     https://github.com/JamesStolp/contextual-snapshot-export-action
     ================================================================ -->

## Project Structure

This is a Contextual platform tenant snapshot repository. It has two content layers:

**`tenant-snapshot/`** — machine-generated, auto-synced by CI every 30 minutes. Read-only. Never edit manually. Files are overwritten on every sync run.

**`team-context/`** — human-authored. Edited via PRs. The interpretive layer on top of the snapshot: decisions, runbooks, analysis, and a map of external sources.

Human-authored files at the repo root (`NOTES.md`, etc.) are managed via PRs. The exception is `.rules` and `CLAUDE.md` — both have a universal section that is auto-synced by CI on every run (everything above the `<!-- TENANT SECTION` marker), and a tenant section below the marker that is preserved through syncs and managed via PRs.

---

## Critical Rules

- **Never edit files under `tenant-snapshot/`** — they are overwritten on the next sync.
- **Never commit secrets, credentials, or API keys.**
- **`team-context/` changes go via PRs**, not direct commits to `main`.
- **When in doubt about platform behaviour**, check `tenant-snapshot/manifest.json` and the relevant component file before reasoning from memory.
- **Example records for object types are not committed** — they are available as a GitHub Actions artifact. Download with `gh run download` when needed for a session (see README Quick Start).

---

## Working With tenant-snapshot/

Work cheapest-to-deepest. Stop as soon as you have enough to answer:

1. `tenant-snapshot/manifest.json` — full inventory in one read (names, types, versions, hashes, paths, syncedAt)
2. `tenant-snapshot/components/flows/<id>/summary.md` — flow structure, tabs, node graph, wiring; read before any JSON or JS
3. Extracted `.js` / `.html` files under each flow directory — use `grep` across the tab directory first, then read specific files
4. `tenant-snapshot/components/flows/<id>/flow.json` — last resort only, for structural detail not in the summary (e.g. port-level wiring, node IDs)

Never load all flow JSON files into context at once.

---

## Working With team-context/

- **`team-context/sources.md`** — read at the start of a session to know what external context sources (Slack, Drive, Notion, etc.) are available for this tenant.
- **`team-context/decisions/`** — architectural and operational decision records.
- **`team-context/runbooks/`** — step-by-step operational procedures.
- **`team-context/analysis/`** — durable findings and insights from past sessions.
- **`team-context/reference/`** — specs, docs, and external links.
- **`team-context/prompts/`** — reusable AI prompts. Load with `/file` or `#file`.

To add or update `team-context/` files during a session, create a branch and open a PR. Do not commit directly to `main`.

---

## Session Wrap-Up

When the user says "wrap up", "end session", or loads the wrap-up prompt:

```
/file team-context/prompts/session-wrap-up.md
```

The short version:
1. Run `git status --short` and `git diff` to see exactly what changed this session.
2. Identify what is worth preserving in `team-context/` — non-obvious findings, decisions, runbooks, external sources discovered.
3. Draft content and confirm with the user before writing any files.
4. Suggest the git commands to branch, commit, and push. Do not run them without explicit user instruction.
