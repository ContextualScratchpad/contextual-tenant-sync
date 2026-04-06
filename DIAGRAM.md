# Git-Backed Tenant Snapshot — Architecture

```mermaid
flowchart TD

    %% ── Styles ────────────────────────────────────────────────────────────
    classDef platform  fill:#0d2137,stroke:#4a90d9,color:#e8f4fd
    classDef central   fill:#0d2d0d,stroke:#4a9d4a,color:#e8f4e8
    classDef repo      fill:#2d0d2d,stroke:#a04aa0,color:#f4e8f4
    classDef developer fill:#2d1a00,stroke:#d4924a,color:#fdf0e0
    classDef scheduler fill:#1a1a2d,stroke:#7a7ad4,color:#e8e8fd
    classDef artifact  fill:#2d2200,stroke:#d4b84a,color:#fdf8e0

    %% ── Contextual Platform ───────────────────────────────────────────────
    subgraph PLAT["  ☁️  Contextual Platform  "]
        direction LR
        API["Flows · Connections · Agents\nObject Types · Schemas\nOpenAPI Spec"]
    end

    %% ── Centrally Managed ─────────────────────────────────────────────────
    subgraph CENTRAL["  📦  Centrally Managed  "]
        direction TB

        subgraph ACTREPO["  contextual-snapshot-export-action  (public)  "]
            direction LR
            EP["export.py\nCLI-free Python exporter\nOAuth2 client credentials\nstdlib only"]
            SC["sync_context_files.py\nMerges universal + tenant\nsections for .rules\nCLAUDE.md · sync.yml"]
            RB["rules.base.md\nCLAUDE.base.md\nUniversal AI context\n(platform-wide rules,\npatterns, gotchas)"]
            ST["tenant-sync.yml\nCanonical workflow\ntemplate — self-syncing\nto all tenant repos"]
        end

        subgraph TMPL["  tenant-snapshot-template  "]
            TPL["Scaffold for new repos\nteam-context/ stubs\nsync.yml stub\nSetup README"]
        end
    end

    %% ── GitHub Actions ────────────────────────────────────────────────────
    GHA(["  ⏱  GitHub Actions Runner\n  Every 30 min · or manual trigger  "])

    %% ── Tenant Snapshot Repo ──────────────────────────────────────────────
    subgraph REPO["  🗄️  snapshot-&lt;tenant&gt;--&lt;silo&gt;  (private, per tenant)  "]
        direction TB

        subgraph AUTO["  CI-owned · never edit manually  "]
            direction LR
            TS["tenant-snapshot/\nExtracted .js / .html files\nMarkdown flow summaries\nJSON records · manifest.json\nOpenAPI spec"]
            SY[".github/workflows/sync.yml\n(self-updates on every run)"]
        end

        subgraph TWOPART["  Two-section · auto-synced + PR-managed  "]
            direction LR
            RC[".rules  ·  CLAUDE.md\n━━━━━━━━━━━━━━━━━━━━━━━━\nUniversal section\n← CI overwrites every run\nplatform rules · patterns\n━━━━━━━━━━━━━━━━━━━━━━━━\nTenant section\n← PR-managed, never overwritten\nwhat this business does\ndomain concepts · constraints"]
        end

        subgraph HUMAN["  Human-driven · AI-assisted  "]
            direction LR
            TC["team-context/\nsources.md — external context map\ndecisions/ · runbooks/\nanalysis/ · reference/\nprompts/session-wrap-up.md"]
        end

        ART["📎  object-type-examples artifact\n7-day retention · gh run download\n(gitignored — avoids churn)"]
    end

    %% ── Developer ─────────────────────────────────────────────────────────
    subgraph DEV["  💻  Developer  "]
        direction TB
        GT["git pull\n(latest snapshot +\nany merged PRs)"]
        AI["AI Tool\nZed · Claude Code · Cursor\n─────────────────────────\nAuto-loaded at session start:\n.rules / CLAUDE.md\n─────────────────────────\nInstant local retrieval\n(no API call, no latency):\ntenant-snapshot/\nteam-context/"]
    end

    %% ── Flows ─────────────────────────────────────────────────────────────

    %% Bootstrap (one-time)
    TMPL -. "gh repo create --template\n(new tenant, one-time)" .-> REPO

    %% Scheduled sync trigger
    GHA --> |"downloads + runs"| SC
    GHA --> |"downloads + runs"| EP

    %% Platform → snapshot
    API --> |"OAuth2 client credentials\nREST API calls"| EP
    EP  --> |"writes extracted\nfiles + JSON"| TS
    EP  --> |"uploads"| ART

    %% Context file sync
    RB  --> |"fetched by"| SC
    SC  --> |"overwrites universal section\npreserves tenant section"| RC
    SC  --> |"self-updates"| SY

    %% Developer loop
    REPO --> |"git pull"| GT
    GT   --> AI

    %% Session wrap-up
    AI  --> |"session wrap-up\nbranch → PR → merge"| TC

    %% Apply styles
    class PLAT,API platform
    class ACTREPO,TMPL,EP,SC,RB,ST,TPL central
    class REPO,AUTO,TWOPART,HUMAN,TS,SY,RC,TC repo
    class DEV,GT,AI developer
    class GHA scheduler
    class ART artifact
```

---

## Key relationships

| Flow | Frequency | Mechanism |
|---|---|---|
| Platform → `tenant-snapshot/` | Every 30 min | GitHub Actions + `export.py` via REST API |
| Action repo → `.rules` / `CLAUDE.md` / `sync.yml` | Every 30 min | `sync_context_files.py` — universal section overwritten, tenant section preserved |
| Tenant repo → developer | On demand | `git pull` |
| Developer → `team-context/` | End of session | Branch → PR → merge |
| Template → new tenant repo | Once per tenant | `gh repo create --template` |

## Content zones in the tenant repo

| Zone | Written by | Updated via | Purpose |
|---|---|---|---|
| `tenant-snapshot/` | CI only | Scheduled sync | Live platform state — flows, code, schemas, records |
| `.rules` / `CLAUDE.md` universal | CI only | Scheduled sync | Platform-wide AI session rules, auto-propagated |
| `.rules` / `CLAUDE.md` tenant | Team | PRs | Business domain context, constraints, key concepts |
| `team-context/` | Team (AI-assisted) | PRs | Accumulated knowledge — decisions, runbooks, analysis |
| Examples artifact | CI only | Each sync run | Object type exemplar records, available on demand |