<!-- ================================================================
     UNIVERSAL SECTION — auto-synced from contextual-snapshot-export-action
     Do not edit this section manually. Changes will be overwritten on
     the next sync run. To propose a change, open a PR against:
     https://github.com/JamesStolp/contextual-snapshot-export-action
     ================================================================ -->

# Tenant Snapshot Repo — Standing Rules

## Project Structure

This repo has two content layers:

- `tenant-snapshot/`  — machine-generated, auto-synced by CI every 30 minutes.
                        Read-only. Never edit manually. Changes are overwritten on
                        the next sync.
- `team-context/`    — human-authored. Edited via PRs. This is the interpretive
                        layer: decisions, runbooks, analysis, external source map.

Human-authored files at the repo root (`.rules`, `CLAUDE.md`, `NOTES.md`) are also
managed via PRs — except the universal sections of `.rules` and `CLAUDE.md`, which
are overwritten on every sync run.

---

## ⚠ PREREQUISITE — Before Reasoning About Any Component

Do not answer questions about a specific flow, connection, agent, or object record
without first verifying it is current:

1. Read `tenant-snapshot/manifest.json` — find the record's `hash` and `syncedAt`.
2. If `syncedAt` matches this session's sync (i.e. you ran `git pull` at session
   start), proceed.
3. If there is any doubt (Flow Editor work may have occurred, or the user mentions
   recent changes), say so before proceeding. The snapshot may be stale.

**The snapshot is read-only.** Changes go through the Flow Editor or CLI, then the
next CI sync or a manual `git pull` after triggering a sync.

---

## ⚠ PREREQUISITE — Before Working on a Function Node

Do not reason about, modify, or evaluate a function node without first understanding
its full message context:

- What properties does `msg` carry **on arrival** (set by upstream nodes)?
- What do **downstream nodes** expect from this node's output?
- Which **output port** maps to which downstream node?

The extracted `.js` file alone is not sufficient. Use grep across the flow's tab
directory to trace `msg` assignments before and after the node:

```bash
grep -rn "msg\." tenant-snapshot/components/flows/<flow-id>/<Tab Name>/
```

Read `tenant-snapshot/components/flows/<flow-id>/summary.md` to understand the full
wiring of the tab before editing any function node in it.

---

## Snapshot Structure

```
tenant-snapshot/
  manifest.json                    ← inventory: id, type, hash, version, syncedAt per record
  registry-api.openapi.json        ← OpenAPI spec from the native-object-registry API
  components/
    flows/
      schema.json                  ← flow type definition from registry API
      <id>/
        flow.json                  ← source-of-truth Node-RED JSON (round-trippable to platform)
        summary.md                 ← tab/node/wiring overview — always read this before the JSON
        <Tab Name>/
          <Node Name>.js           ← extracted function node code
          <Node Name>.html         ← extracted template node code
    connections/                   ← type: api-configuration (secrets redacted as <REDACTED>)
      schema.json
    agents/
      schema.json
    ai-routes/
      schema.json
    authorization-code-apps/
      schema.json
    jwks-configurations/
      schema.json
    object-types/                  ← custom Object Types
      <type-id>/
        schema.json                ← full type definition from registry API
        examples/                  ← gitignored; download via GitHub Actions artifact
```

Secret fields are replaced with `<REDACTED>`. Never attempt to reconstruct or infer them.

---

## Order of Operations for Component Questions

Work cheapest-to-deepest. Stop as soon as you have enough to answer:

1. `manifest.json` — full inventory in one read (names, types, versions, paths, syncedAt)
2. `summary.md` — flow structure, tabs, node graph, wiring; read before any JSON or JS
3. Connection / agent `.json` files — small, read directly as needed
4. Extracted `.js` / `.html` files — use `grep` across the tab directory first, then read specific files
5. Raw `flow.json` — last resort only, for structural detail not in the summary
   (e.g. port-level wiring, config node references, node IDs)

**Never load all flow JSON files into context at once.**
**Whole-codebase scope is the default** — when a task is ambiguous about scope, assume
it applies across all flows, not just the one mentioned.

---

## Working With team-context/

- `sources.md` — maps external context sources (Slack, Drive, Notion, etc.).
  Read this at the start of a session to know what external context is available.
- `decisions/` — architectural and operational decision records.
- `runbooks/` — step-by-step operational procedures.
- `analysis/` — durable findings and insights from past sessions.
- `reference/` — specs, docs, and external links.
- `prompts/` — reusable AI prompts; load with `/file team-context/prompts/<name>.md`.

To add or update team-context files, create a branch and open a PR.
Do not commit directly to main.

---

## Grep Patterns

```bash
# All flows referencing a specific connection
grep -rl "<connection-name>" tenant-snapshot/components/flows/

# All msg property accesses across a tab
grep -rn "msg\." tenant-snapshot/components/flows/<flow-id>/<Tab Name>/

# Find where a specific msg property is set
grep -rn "msg\.<property>\s*=" tenant-snapshot/components/flows/<flow-id>/

# Search for a string across all flows
grep -rn "<search-term>" tenant-snapshot/components/flows/
```

---

## HTTP URL Patterns

Flows serving HTTP endpoints have different base URLs depending on runtime context:

**Flow Editor (development/testing):**
```
https://<flow-id>.flow.<tenant>.my.<silo>.contextual.io/<path>
```

**Agent deployment (production):**
```
https://<agent-name>.service.<tenant>.my.<silo>.contextual.io/<path>
```
The agent URL uses the agent record's `name` field, not the flow ID.

**Implications for flow design:**
- Use **relative paths** for internal links, form actions, and redirects wherever
  possible — these work in both contexts.
- When an **absolute URL** is unavoidable (e.g. OAuth callback URLs), derive it from
  request headers at runtime. The platform proxy sets:
  - `x-forwarded-host` → the external hostname (works in both contexts)
  - `x-forwarded-proto` → `https`
  - `msg.req.headers.host` → internal K8s hostname — not useful for external URLs

---

## Error Handling Patterns

**Flow type is determined by the entry node:**
- `contextual-start` / event-start → event flow → errors terminate at `contextual-error`
- `http in` → HTTP-serving flow → errors terminate at `http response` with a status code

**Outbound request nodes throw on failure:**
All outbound request nodes (`http-post`, `http-get`, `http-patch`, etc.) throw on
timeout or error responses — they do not pass failures through the output wire.
A tab-scoped `catch` (scope: null) covers them; a single success-only output wire
is correct and expected.

**Scoped catch strategies:**
A single tab-scoped catch is the baseline pattern. Multiple catch nodes scoped to
specific subsets of nodes is valid when different error paths warrant different
handling. Evaluate whether catch coverage is complete, not just whether a tab-scoped
catch exists.

---

## Debugging in the Flow Editor

- Use **log-tap nodes** set to log the complete `msg` object for debugging. Place them
  temporarily after an `http in` node to see all request headers, cookies, and payload.
- `node.warn()` / `logger.warn()` output appears in the debug drawer but is **not
  readable via the MCP `logger_messages` tool**. Use log-tap nodes instead for
  MCP-compatible debugging.

---

## Creating Agents

By default, agents **start immediately** on creation. To create a stopped agent,
include `"_metaData": { "doNotStart": true }` in the payload. This corresponds to
the "Start on creation" checkbox (unchecked) in the platform UI.

**Before creating an agent, ask the user whether it should start immediately or be
created stopped** — unless their intent was already clear from the request.

---

## Creating Object Types

**Use `types add`, not `records create`.**
Object types are managed through the `types` command group. The correct command is:

```bash
./bin/run.js types add --input-file <schema>.jsonl
```

**Input must be JSONL (one JSON object per line), not pretty-printed JSON.**
A multi-line pretty-printed JSON file will fail with a parse error. Always compact first:

```bash
python3 -c "import json; d=json.load(open('in.json')); print(json.dumps(d))" > out.jsonl
```

**Schema shape for object types:**

```json
{
  "id": "<type-id>",
  "type": "custom",
  "name": "...",
  "pluralName": "...",
  "description": "...",
  "objectType": "internal",
  "display": "default",
  "defaultListStyle": "table",
  "schema": {
    "primaryKey": "id",
    "type": "object",
    "properties": {
      "id": { "type": "string", "generate": { "type": "uuid", "format": "short" } },
      "name": { "type": "string", "minLength": 1 },
      "description": { "type": "string" }
    },
    "required": ["name"]
  },
  "features": {
    "auditTrail": { "enabled": true },
    "version": { "enabled": true }
  }
}
```

Set `"objectType": "internal"` on creation — activates built-in storage and CRUD
rules in a single call. Enable features explicitly with `{ "enabled": true }` objects.

**Primary key options:**
- Auto-generated UUID (short): `{ "type": "string", "generate": { "type": "uuid", "format": "short" } }`
- Auto-generated UUID (v4): `{ "type": "string", "generate": { "type": "uuid", "format": "v4" } }`
- User-supplied: omit `generate` entirely

**Defining relationships — `relations` and `referencedBy`:**
Declared at the top level of the object type schema (alongside `schema`, `features`),
not inside property definitions.

`relations` — forward references from this type to another:
```json
"relations": {
  "customer": {
    "typeRef": "native-object:customer/id",
    "localField": "customerId",
    "displayField": "name"
  }
}
```

`referencedBy` — reverse references (back-links):
```json
"referencedBy": {
  "accounts": {
    "typeRef": "native-object:account/customerId",
    "localField": "customerId"
  }
}
```

Note: `typeRef` means different things in each. In `relations` it points to the PK
of the target; in `referencedBy` it points to the foreign key field on the referencing
type.

**`query-native-object` — always use `"{}"` for an empty query, never `""`:**
```
query: "{}"   ✓  valid — returns all records
query: ""     ✗  crashes with SyntaxError: Unexpected end of JSON input
```

**Wiring record creation — `create-native-object` node:**
Key properties:
- `typeId`: the object type ID string
- `typeIdType`: `"notype"` (literal string, not a msg/flow/global reference)
- `property` / `propertyType`: where to read the record payload from
- `nativeObjectConfig`: `"default-native-object-config"`

---

## Incremental Delivery — Breaking Down Big Tasks

When a request involves multiple distinct steps, **do not execute everything in one
pass**. Break the work into the smallest independently-verifiable increments and pause
for user confirmation between each.

**The rule:** complete one logical unit → verify it works → get the go-ahead → proceed.

**What counts as a checkpoint:**
- **Object types** — create one type, confirm CRUD works, then create the next.
- **Seed data** — propose the seed set, get approval, then run.
- **Flow routes** — build and deploy one route at a time. Test before wiring the next.
- **Templates and CSS** — stub with minimal HTML first, then layer in styling and data.
- **Sub-agents** — one verifiable unit of work per delegation, not an entire feature.

**When in doubt, do less and ask.** A working half-feature is more useful than a
broken full-feature that needs unpicking across 40+ nodes.

---

## Session Wrap-Up

At the end of a session, or when the user says "wrap up", "end session",
or loads `team-context/prompts/session-wrap-up.md`, follow the procedure
defined in that file.

The short version:
1. Run `git status --short` and `git diff` to see exactly what changed.
2. Identify what is worth preserving in `team-context/`.
3. Draft content and confirm with the user before writing any files.
4. Suggest the git commands to branch, commit, and push — do not run them
   without explicit user instruction.

---

## Key Rules

- Manifest before any component question.
- Understand `msg` context before any function node work.
- Summaries before JSON. Grep before reading individual files.
- Whole-codebase scope by default.
- Secrets stay `<REDACTED>` — never reconstruct them.
- Snapshot is read-only — changes go through Flow Editor or CLI, then re-sync.
- One verified step at a time — never batch across checkpoints.
- Never modify files under `tenant-snapshot/` — they are overwritten on the next CI sync.
- Never commit secrets, credentials, or API keys.
- `team-context/` changes go via PRs, not direct commits to main.
- The universal sections of `.rules` and `CLAUDE.md` are owned by CI — do not manually
  edit anything above the `TENANT SECTION` marker in either file.

<!-- END UNIVERSAL SECTION -->