#!/usr/bin/env node
/**
 * sync_context_files.ts — Sync universal context files to tenant repos.
 *
 * Downloads rules.base.md and CLAUDE.base.md from the action repo and merges
 * them with the preserved tenant sections in .rules and CLAUDE.md respectively.
 *
 * Strategy per file (two-section merge):
 *   1. Fetch the universal base from the action repo
 *   2. Read the existing file on disk (if present)
 *   3. Extract the tenant section (everything from the TENANT SECTION marker onward)
 *   4. Write: universal base + preserved tenant section (or template if absent)
 *
 * The universal section is always overwritten.
 * The tenant section is always preserved.
 *
 * Note: .github/workflows/sync.yml is intentionally NOT managed by this script.
 * Tenant sync.yml files are stable reusable-workflow callers that almost never
 * change. GITHUB_TOKEN cannot push workflow file changes anyway.
 *
 * Usage:
 *   node sync_context_files.js
 *
 * Set SYNC_ACTION_REF env var to pin to a specific ref (default: "main").
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ACTION_REPO_RAW =
  "https://raw.githubusercontent.com/ContextualScratchpad/contextual-tenant-sync";

const ACTION_REF = (process.env["SYNC_ACTION_REF"] ?? "main").trim() || "main";

const TENANT_MARKER = "<!-- TENANT SECTION";

// ---------------------------------------------------------------------------
// Tenant section templates
// ---------------------------------------------------------------------------

const RULES_TENANT_TEMPLATE = `<!-- TENANT SECTION — edit this section for tenant-specific context.
     This section is preserved through all auto-syncs. To propose changes
     to the universal section above, open a PR against the action repo.
     ================================================================ -->

## Tenant Context

<!-- Fill in the sections below. These are loaded into the AI assistant's context
     at the start of every Zed session for this project. Be concise — this is
     always-on context, not a document. -->

### What this tenant does
<!-- 2–3 sentences on the business domain. What is this tenant building?
     Who are their users? What problem does the platform solve for them?
     Example: "This tenant is a logistics company. Their platform automates
     inbound shipment notifications and customer support ticket routing." -->

### Key domain concepts
<!-- Concepts the AI must understand to reason correctly about this tenant's
     flows, object types, and data. One bullet per concept.
     Example:
     - A "support-request" object is the core unit of work — it maps to an
       inbound customer ticket
     - The Stripe connection is the primary revenue data source — treat flows
       that touch it with extra care
     - "vendors" are third-party fulfilment partners, not internal staff -->

### Critical session constraints
<!-- Anything the AI must know before touching anything in this repo.
     Example:
     - Never modify the billing-export flow without checking with ops first —
       it runs nightly and has no staging equivalent
     - The prod silo has stricter rate limits than dev — avoid bulk operations
       in production flows -->
`;

const CLAUDE_TENANT_TEMPLATE = `<!-- TENANT SECTION — edit this section for tenant-specific context.
     This section is preserved through all auto-syncs. To propose changes
     to the universal section above, open a PR against the action repo.
     ================================================================ -->

## Tenant: <!-- tenant-id --> (<!-- silo: dev / prod -->)

<!-- Fill in the sections below. These are loaded into the AI assistant's context
     at the start of every Claude Code session for this project. Be concise —
     this is always-on context, not a document. -->

### What this tenant does
<!-- 2–3 sentences on the business domain. What is this tenant building?
     Who are their users? What problem does the platform solve for them? -->

### Key domain concepts
<!-- Concepts the AI must understand to reason correctly about this tenant's
     flows, object types, and data. One bullet per concept.
     Example:
     - A "support-request" object is the core unit of work — it maps to an
       inbound customer ticket
     - The Stripe connection is the primary revenue data source -->

### Critical session constraints
<!-- Anything the AI must know before touching anything in this repo.
     Example:
     - Never modify the billing-export flow without checking with ops first -->
`;

// ---------------------------------------------------------------------------
// File definitions
// ---------------------------------------------------------------------------

interface FileConfig {
  target: string;
  baseUrl: string;
  tenantTemplate: string;
}

const FILES: FileConfig[] = [
  {
    target: ".rules",
    baseUrl: `${ACTION_REPO_RAW}/${ACTION_REF}/rules.base.md`,
    tenantTemplate: RULES_TENANT_TEMPLATE,
  },
  {
    target: "CLAUDE.md",
    baseUrl: `${ACTION_REPO_RAW}/${ACTION_REF}/CLAUDE.base.md`,
    tenantTemplate: CLAUDE_TENANT_TEMPLATE,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchUrl(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${url}`);
  }
  return resp.text();
}

function extractTenantSection(content: string, marker: string): string | null {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(marker)) {
      return lines.slice(i).join("\n");
    }
  }
  return null;
}

function merge(universal: string, tenantSection: string): string {
  return universal.trimEnd() + "\n\n" + tenantSection.trimStart();
}

async function syncFile(cfg: FileConfig): Promise<void> {
  process.stdout.write(`  ${cfg.target}… `);

  // Ensure parent directory exists
  const parentDir = path.dirname(cfg.target);
  if (parentDir !== ".") {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Fetch universal base
  let universal: string;
  try {
    universal = await fetchUrl(cfg.baseUrl);
  } catch (err) {
    process.stderr.write(`FAILED (could not fetch)\n    ${String(err)}\n`);
    return;
  }

  // Read existing file and extract tenant section
  let tenantSection: string;
  let status: string;

  if (fs.existsSync(cfg.target)) {
    const existing = fs.readFileSync(cfg.target, "utf-8");
    const found = extractTenantSection(existing, TENANT_MARKER);
    if (found) {
      tenantSection = found;
      status = "preserved tenant section";
    } else {
      // File exists but has no marker — append template so owner can fill it in
      tenantSection = cfg.tenantTemplate;
      status = "no tenant section found — appended template";
    }
  } else {
    tenantSection = cfg.tenantTemplate;
    status = "new file — appended template";
  }

  const merged = merge(universal, tenantSection);
  fs.writeFileSync(cfg.target, merged, "utf-8");
  console.log(`OK (${status})`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Syncing context files from action repo ref: ${ACTION_REF}`);
  for (const cfg of FILES) {
    await syncFile(cfg);
  }
  console.log("Done.");
}

main().catch((err) => {
  process.stderr.write(
    `\nError: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
