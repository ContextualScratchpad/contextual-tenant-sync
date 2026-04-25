#!/usr/bin/env node
/**
 * export.ts — CLI-free snapshot exporter for the Contextual platform.
 * TypeScript rewrite of export.py — functional equivalent, zero runtime dependencies.
 *
 * Authenticates via OAuth 2.0 client credentials — no interactive login, no CLI.
 * Configuration is read from environment variables (or a .env file alongside this script):
 *
 *   CTXL_CLIENT_ID      — Client ID from the Contextual platform API key settings   [required]
 *   CTXL_CLIENT_SECRET  — Client Secret from the Contextual platform API key settings [required]
 *   CTXL_TENANT_ID      — Tenant ID (e.g. "alba-netchb")                             [required]
 *   CTXL_SILO           — Platform silo: "dev" (default) or "prod"                   [optional]
 *
 * Usage:
 *   node export.js [--out <output-dir>] [--yes] [--skip-examples]
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readlinePromises from 'node:readline/promises';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = __dirname;
const REDACTED = '<REDACTED>';
const TOKEN_EXPIRY_BUFFER_SECS = 60;

const COMPONENT_TYPES: [string, string][] = [
  ['flow', 'flows'],
  ['api-configuration', 'connections'],
  ['agent', 'agents'],
  ['ai-route', 'ai-routes'],
  ['authorization-code-app', 'authorization-code-apps'],
  ['jwks-configuration', 'jwks-configurations'],
];

const SECRET_NAME_RE =
  /token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|bearer|auth[_-]?header|access[_-]?key|client[_-]?secret/i;

type ExtResolver = string | ((node: Rec) => string);

function templateExt(node: Rec): string {
  return node['syntax'] === 'plain' ? '.txt' : '.mustache';
}

const CODE_NODE_FIELDS: Record<string, [string, ExtResolver]> = {
  'function':        ['func',     '.js'],
  'python-function': ['code',     '.py'],
  'template':        ['template', templateExt],
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

interface ManifestEntry {
  name: string;
  type: string;
  hash: string;
  version: number | null;
  updatedAt: string;
  path: string;
}

interface ObjectTypeManifestEntry extends ManifestEntry {
  recordCount: number | null;
  exemplarCount: number;
}

interface Manifest {
  syncedAt: string;
  records: Record<string, ManifestEntry | ObjectTypeManifestEntry>;
}

interface CodeFile {
  tab: string;
  node: string;
  relPath: string;
}

interface RunOptions {
  autoConfirm: boolean;
  skipExamples: boolean;
}

interface PageResponse {
  items: Rec[];
  nextPageToken?: string;
  totalCount?: number;
}

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

function loadDotenv(envPath?: string): void {
  const filePath = envPath ?? path.join(SCRIPT_DIR, '.env');
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eqIdx = line.indexOf('=');
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      val.length >= 2 &&
      val[0] === val[val.length - 1] &&
      (val[0] === '"' || val[0] === "'")
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Config: tenant identity (non-secret)
// ---------------------------------------------------------------------------

let _config: { tenantId: string; silo: string } | null = null;

function getConfig(): { tenantId: string; silo: string } {
  if (_config) return _config;
  const tenantId = (process.env['CTXL_TENANT_ID'] ?? '').trim();
  const silo = (process.env['CTXL_SILO'] ?? 'dev').trim() || 'dev';
  if (!tenantId) {
    throw new Error(
      'Missing required environment variable: CTXL_TENANT_ID\n\n' +
      'Set it in a .env file alongside this script, or export it in your shell.',
    );
  }
  _config = { tenantId, silo };
  return _config;
}

// ---------------------------------------------------------------------------
// Config: credentials (secret)
// ---------------------------------------------------------------------------

let _credentials: { clientId: string; clientSecret: string } | null = null;

function getCredentials(): { clientId: string; clientSecret: string } {
  if (_credentials) return _credentials;
  const clientId = (process.env['CTXL_CLIENT_ID'] ?? '').trim();
  const clientSecret = (process.env['CTXL_CLIENT_SECRET'] ?? '').trim();
  const errors: string[] = [];
  if (!clientId) errors.push('CTXL_CLIENT_ID is not set');
  if (!clientSecret) errors.push('CTXL_CLIENT_SECRET is not set');
  if (errors.length > 0) {
    throw new Error(
      'Missing required environment variables:\n' +
      errors.map(e => `  • ${e}`).join('\n') +
      '\n\nSet them in a .env file alongside this script, or export them in your shell.',
    );
  }
  _credentials = { clientId, clientSecret };
  return _credentials;
}

// ---------------------------------------------------------------------------
// Base URLs
// ---------------------------------------------------------------------------

function siloSeg(): string {
  const { silo } = getConfig();
  return silo === 'prod' ? '' : `.${silo}`;
}

function nativeObjectBaseUrl(): string {
  const { tenantId } = getConfig();
  return `https://native-object.${tenantId}.my${siloSeg()}.contextual.io`;
}

function registryBaseUrl(): string {
  const { tenantId } = getConfig();
  return `https://native-object-registry.${tenantId}.my${siloSeg()}.contextual.io`;
}

// ---------------------------------------------------------------------------
// OAuth 2.0 client credentials token exchange
// ---------------------------------------------------------------------------

let _tokenCache: { token: string; expiresAt: number } | null = null;

async function fetchBearerToken(): Promise<string> {
  const now = Date.now() / 1000; // unix seconds (monotonic approximation)
  if (_tokenCache && _tokenCache.expiresAt > now + TOKEN_EXPIRY_BUFFER_SECS) {
    return _tokenCache.token;
  }

  const { tenantId, silo } = getConfig();
  const { clientId, clientSecret } = getCredentials();
  const audience =
    silo === 'prod'
      ? 'https://contextual/no-api'
      : `https://contextual-${silo}/no-api`;
  const tokenUrl = `https://auth.${tenantId}.my${siloSeg()}.contextual.io/oauth/token`;

  const body = JSON.stringify({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    audience,
  });

  let resp: Response;
  try {
    resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    throw new Error(
      `Token exchange failed — network error\n  URL: ${tokenUrl}\n  ${String(err)}`,
    );
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `Token exchange failed — HTTP ${resp.status}: ${text}\n` +
      `  URL: ${tokenUrl}\n` +
      `  Audience: ${audience}\n` +
      `  Check CTXL_CLIENT_ID and CTXL_CLIENT_SECRET.`,
    );
  }

  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  const token = (data.access_token ?? '').trim();
  if (!token) {
    throw new Error(
      `Token exchange response did not contain an access_token.\n  Response: ${JSON.stringify(data)}`,
    );
  }

  const expiresIn = data.expires_in ?? 3600;
  _tokenCache = { token, expiresAt: now + expiresIn };
  return token;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { tenantId } = getConfig();
  const token = await fetchBearerToken();
  return {
    Authorization: `Bearer ${token}`,
    'x-org-id': tenantId,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiGet(url: string): Promise<unknown> {
  const headers = await authHeaders();
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'GET', headers });
  } catch (err) {
    throw new Error(`GET ${url} → network error: ${String(err)}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GET ${url} → HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function apiPost(url: string, body: Rec): Promise<unknown> {
  const headers = { ...(await authHeaders()), 'Content-Type': 'application/json' };
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`POST ${url} → network error: ${String(err)}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`POST ${url} → HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// Platform data fetchers
// ---------------------------------------------------------------------------

async function fetchAllRecords(typeId: string, pageSize = 250): Promise<Rec[]> {
  const url = `${nativeObjectBaseUrl()}/api/v1/$page/${typeId}`;
  const records: Rec[] = [];
  let params: Rec = { pageSize, includeTotal: true };

  while (true) {
    const data = (await apiPost(url, params)) as PageResponse;
    records.push(...(data.items ?? []));
    if (!data.nextPageToken) break;
    params = { ...params, pageToken: data.nextPageToken };
  }

  return records;
}

async function fetchRecordsPage(
  typeId: string,
  opts: { orderBy?: string; pageSize?: number; includeTotal?: boolean } = {},
): Promise<[Rec[], number | null]> {
  const url = `${nativeObjectBaseUrl()}/api/v1/$page/${typeId}`;
  const params: Rec = { pageSize: opts.pageSize ?? 10 };
  if (opts.includeTotal !== false) params['includeTotal'] = true;
  if (opts.orderBy) params['orderBy'] = [opts.orderBy];

  const data = (await apiPost(url, params)) as PageResponse;
  return [data.items ?? [], data.totalCount ?? null];
}

async function fetchTypeSchema(typeId: string): Promise<Rec | null> {
  const url = `${registryBaseUrl()}/api/v1/types/${typeId}`;
  try {
    return (await apiGet(url)) as Rec;
  } catch {
    return null;
  }
}

async function fetchCustomTypes(pageSize = 250): Promise<Rec[]> {
  const url = `${registryBaseUrl()}/api/v1/$page/types`;
  const types: Rec[] = [];
  let params: Rec = { pageSize, includeTotal: true };

  while (true) {
    const data = (await apiPost(url, params)) as PageResponse;
    types.push(...(data.items ?? []));
    if (!data.nextPageToken) break;
    params = { ...params, pageToken: data.nextPageToken };
  }

  return types;
}

async function fetchOpenApiSpec(): Promise<Rec | null> {
  const { tenantId } = getConfig();
  const url = `https://native-object-registry.${tenantId}.my${siloSeg()}.contextual.io/api-docs/openapi.json`;
  try {
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) return null;
    return (await resp.json()) as Rec;
  } catch (err) {
    process.stderr.write(`  [warn] Could not fetch OpenAPI spec from ${url}: ${String(err)}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Secret obfuscation helpers
// ---------------------------------------------------------------------------

function setAtDotpath(obj: unknown, dotpath: string, value: unknown): void {
  const parts = dotpath.split('.');
  let current: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current === null || typeof current !== 'object') return;
    const key = parts[i];
    current = Array.isArray(current)
      ? (current as unknown[])[parseInt(key, 10)]
      : (current as Rec)[key];
  }
  const last = parts[parts.length - 1];
  if (current !== null && typeof current === 'object') {
    if (Array.isArray(current)) {
      (current as unknown[])[parseInt(last, 10)] = value;
    } else {
      (current as Rec)[last] = value;
    }
  }
}

function redactByName(obj: unknown, depth = 0): void {
  if (depth > 20 || obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) redactByName(item, depth + 1);
  } else {
    const record = obj as Rec;
    for (const [key, val] of Object.entries(record)) {
      if (typeof val === 'string' && val && SECRET_NAME_RE.test(key)) {
        record[key] = REDACTED;
      } else {
        redactByName(val, depth + 1);
      }
    }
  }
}

function redactSecrets(record: Rec): Rec {
  const copy = JSON.parse(JSON.stringify(record)) as Rec;
  const meta = copy['_metaData'] as Rec | undefined;
  const secrets = meta?.['secrets'];
  if (Array.isArray(secrets)) {
    for (const dotpath of secrets as string[]) {
      setAtDotpath(copy, dotpath, REDACTED);
    }
  }
  redactByName(copy);
  return copy;
}

// ---------------------------------------------------------------------------
// General write helpers
// ---------------------------------------------------------------------------

function getRecordId(record: Rec): string {
  const metaId = (record['_metaData'] as Rec | undefined)?.['id'];
  if (typeof metaId === 'string' && metaId) return metaId;
  for (const field of ['id', 'apiId', 'name']) {
    const val = record[field];
    if (typeof val === 'string' && val) return val;
  }
  throw new Error(`Cannot determine ID for record with keys: ${Object.keys(record).join(', ')}`);
}

function safeFilename(name: string): string {
  return name.replace(/[^\w\-.]/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function uniqueFilename(dir: string, stem: string, ext: string): string {
  let candidate = path.join(dir, `${stem}${ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  let counter = 2;
  while (true) {
    candidate = path.join(dir, `${stem}_${counter}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    counter++;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Flow post-processing: code extraction + summary
// ---------------------------------------------------------------------------

function buildNodeMap(flowsList: Rec[]): Map<string, Rec> {
  const m = new Map<string, Rec>();
  for (const n of flowsList) {
    const id = n['id'];
    if (typeof id === 'string') m.set(id, n);
  }
  return m;
}

function displayName(node: Rec): string {
  const name = (node['name'] as string | undefined)?.trim();
  return name || `(${node['type'] ?? '?'})`;
}

async function extractFlowCode(record: Rec, flowDir: string): Promise<CodeFile[]> {
  const nodeRedData = record['node_red_data'] as Rec | undefined;
  const flowsList = (nodeRedData?.['flows'] as Rec[] | undefined) ?? [];

  const tabs = new Map<string, Rec>();
  for (const n of flowsList) {
    if (n['type'] === 'tab') {
      const id = n['id'];
      if (typeof id === 'string') tabs.set(id, n);
    }
  }

  const nodesByTab = new Map<string, Rec[]>();
  for (const node of flowsList) {
    if (node['type'] === 'tab') continue;
    const z = node['z'];
    if (typeof z === 'string' && tabs.has(z)) {
      const list = nodesByTab.get(z) ?? [];
      list.push(node);
      nodesByTab.set(z, list);
    }
  }

  const extracted: CodeFile[] = [];

  for (const [tabId, tabNode] of tabs) {
    const tabLabel = safeFilename((tabNode['label'] as string | undefined) ?? tabId);
    const tabDir = path.join(flowDir, tabLabel);
    const writtenInTab = new Set<string>();
    const stemCounts = new Map<string, number>();

    for (const node of nodesByTab.get(tabId) ?? []) {
      const nodeType = (node['type'] as string | undefined) ?? '';
      const fieldDef = CODE_NODE_FIELDS[nodeType];
      if (!fieldDef) continue;

      const [fieldName, extOrFn] = fieldDef;
      const ext = typeof extOrFn === 'function' ? extOrFn(node) : extOrFn;
      const code = ((node[fieldName] as string | undefined) ?? '').trim();
      if (!code) continue;

      const baseStem = safeFilename(displayName(node)) || 'unnamed';
      const count = stemCounts.get(baseStem) ?? 0;
      stemCounts.set(baseStem, count + 1);
      const stem = count === 0 ? baseStem : `${baseStem}_${count + 1}`;

      await fsp.mkdir(tabDir, { recursive: true });
      const outPath = path.join(tabDir, `${stem}${ext}`);
      await fsp.writeFile(outPath, code, 'utf-8');
      writtenInTab.add(outPath);

      const rel = path.relative(flowDir, outPath);
      extracted.push({
        tab: (tabNode['label'] as string | undefined) ?? tabId,
        node: displayName(node),
        relPath: rel,
      });
    }

    // Remove files from previous syncs that are no longer current.
    if (fs.existsSync(tabDir)) {
      const existing = await fsp.readdir(tabDir);
      for (const file of existing) {
        const fp = path.join(tabDir, file);
        if (!writtenInTab.has(fp) && fs.statSync(fp).isFile()) {
          await fsp.unlink(fp);
        }
      }
    }
  }

  return extracted;
}

async function generateFlowSummary(
  record: Rec,
  summaryPath: string,
  extracted: CodeFile[],
): Promise<void> {
  const meta = (record['_metaData'] as Rec | undefined) ?? {};
  const nodeRedData = record['node_red_data'] as Rec | undefined;
  const flowsList = (nodeRedData?.['flows'] as Rec[] | undefined) ?? [];
  const nodeMap = buildNodeMap(flowsList);

  const tabs = new Map<string, Rec>();
  for (const n of flowsList) {
    if (n['type'] === 'tab') {
      const id = n['id'];
      if (typeof id === 'string') tabs.set(id, n);
    }
  }

  const nodesByTab = new Map<string, Rec[]>();
  for (const node of flowsList) {
    if (node['type'] === 'tab') continue;
    const z = node['z'];
    if (typeof z === 'string' && tabs.has(z)) {
      const list = nodesByTab.get(z) ?? [];
      list.push(node);
      nodesByTab.set(z, list);
    }
  }

  const lines: string[] = [];
  const flowName = (record['name'] as string | undefined) || (meta['id'] as string | undefined) || 'Unknown';

  lines.push(`# ${flowName}`, '');
  lines.push(`**ID:** \`${meta['id'] ?? ''}\`  `);
  lines.push(`**Version:** ${meta['version'] ?? ''}  `);
  lines.push(`**Updated:** ${meta['updatedAt'] ?? ''}  `);

  const desc = record['description'] as string | undefined;
  if (desc) lines.push('', desc);

  lines.push('', '---', '', '## Tabs', '');

  for (const [tabId, tabNode] of tabs) {
    const tabNodes = nodesByTab.get(tabId) ?? [];
    const tabNodeMap = buildNodeMap(tabNodes);
    const tabLabel = (tabNode['label'] as string | undefined) ?? tabId;
    const disabled = tabNode['disabled'] ? ' *(disabled)*' : '';
    lines.push(`### ${tabLabel}${disabled} — ${tabNodes.length} nodes`, '');

    const sorted = [...tabNodes].sort((a, b) => {
      const ay = (a['y'] as number | undefined) ?? 0;
      const by_ = (b['y'] as number | undefined) ?? 0;
      if (ay !== by_) return ay - by_;
      return ((a['x'] as number | undefined) ?? 0) - ((b['x'] as number | undefined) ?? 0);
    });

    lines.push('| Node | Type | Wires to |');
    lines.push('|------|------|----------|');

    for (const node of sorted) {
      const name = displayName(node).replace(/\|/g, '\\|');
      const ntype = ((node['type'] as string | undefined) ?? '?').replace(/\|/g, '\\|');

      const wireNames: string[] = [];
      const wires = (node['wires'] as unknown[][] | undefined) ?? [];
      for (const port of wires) {
        for (const tid of port as string[]) {
          const target = tabNodeMap.get(tid) ?? nodeMap.get(tid);
          if (target) wireNames.push(displayName(target));
        }
      }
      const wiresStr = wireNames.length > 0 ? wireNames.join(', ').replace(/\|/g, '\\|') : '—';
      lines.push(`| ${name} | \`${ntype}\` | ${wiresStr} |`);
    }
    lines.push('');
  }

  if (extracted.length > 0) {
    lines.push('---', '', '## Extracted Code Files', '');
    const byTab = new Map<string, CodeFile[]>();
    for (const e of extracted) {
      const list = byTab.get(e.tab) ?? [];
      list.push(e);
      byTab.set(e.tab, list);
    }
    for (const [tabLabel, items] of byTab) {
      lines.push(`**${tabLabel}**`);
      for (const e of items) {
        lines.push(`- \`${e.relPath}\` — ${e.node}`);
      }
    }
    lines.push('');
  }

  await fsp.mkdir(path.dirname(summaryPath), { recursive: true });
  await fsp.writeFile(summaryPath, lines.join('\n'), 'utf-8');
}

async function postProcessFlow(record: Rec, flowsFolder: string): Promise<void> {
  const fid = safeFilename(getRecordId(record));
  const flowDir = path.join(flowsFolder, fid);

  const extracted = await extractFlowCode(record, flowDir);
  await generateFlowSummary(record, path.join(flowDir, 'summary.md'), extracted);

  if (extracted.length > 0) {
    console.log(`      → extracted ${extracted.length} code file(s) + summary.md`);
  } else {
    console.log('      → summary.md (no code nodes found)');
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function buildManifestEntry(record: Rec, typeId: string, relPath: string): ManifestEntry {
  const meta = (record['_metaData'] as Rec | undefined) ?? {};
  const name =
    (record['name'] as string | undefined) ||
    (record['displayName'] as string | undefined) ||
    (record['apiId'] as string | undefined) ||
    (meta['id'] as string | undefined) ||
    '';
  return {
    name,
    type: typeId,
    hash: (meta['hash'] as string | undefined) ?? '',
    version: (meta['version'] as number | undefined) ?? null,
    updatedAt: (meta['updatedAt'] as string | undefined) ?? '',
    path: relPath,
  };
}

// ---------------------------------------------------------------------------
// Object type export
// ---------------------------------------------------------------------------

async function exportObjectType(
  typeDef: Rec,
  outDir: string,
  manifestEntries: Record<string, ManifestEntry | ObjectTypeManifestEntry>,
  skipExamples: boolean,
  exemplarCount = 10,
): Promise<void> {
  const typeId = (typeDef['id'] as string | undefined) ?? '';
  const displayNameStr = (typeDef['name'] as string | undefined) ?? typeId;
  const folder = path.join(outDir, 'components', 'object-types', safeFilename(typeId));

  process.stdout.write(`  ${displayNameStr} (${typeId})… `);

  await fsp.mkdir(folder, { recursive: true });
  await writeJson(path.join(folder, 'schema.json'), typeDef);

  let written = 0;
  let totalCount: number | null = null;

  if (skipExamples) {
    console.log(`schema only (examples skipped) → ${folder}`);
  } else {
    try {
      const [records, total] = await fetchRecordsPage(typeId, {
        orderBy: 'updatedAt:desc',
        pageSize: exemplarCount,
      });
      totalCount = total;

      const examplesFolder = path.join(folder, 'examples');
      if (records.length > 0) {
        await fsp.mkdir(examplesFolder, { recursive: true });
        for (const rec of records) {
          const redacted = redactSecrets(rec);
          const rid = safeFilename(getRecordId(redacted));
          await writeJson(path.join(examplesFolder, `${rid}.json`), redacted);
          written++;
        }
      }
      const totalStr = totalCount !== null ? `/${totalCount}` : '';
      console.log(`schema + ${written}${totalStr} example(s) → ${folder}`);
    } catch (err) {
      console.error(`FAILED\n    ${String(err)}`);
      return;
    }
  }

  const meta = (typeDef['_metaData'] as Rec | undefined) ?? {};
  const entry: ObjectTypeManifestEntry = {
    name: displayNameStr,
    type: typeId,
    hash: (meta['hash'] as string | undefined) ?? '',
    version: (meta['version'] as number | undefined) ?? null,
    updatedAt: (meta['updatedAt'] as string | undefined) ?? '',
    path: path.relative(outDir, path.join(folder, 'schema.json')),
    recordCount: totalCount,
    exemplarCount: written,
  };
  manifestEntries[`${typeId}/__schema__`] = entry;
}

// ---------------------------------------------------------------------------
// Stale file cleanup
// ---------------------------------------------------------------------------

async function cleanupStaleFiles(
  outDir: string,
  manifestEntries: Record<string, ManifestEntry | ObjectTypeManifestEntry>,
  autoConfirm: boolean,
): Promise<void> {
  const stale: string[] = [];

  const componentExpected = new Map<string, Set<string>>();
  for (const [, folderName] of COMPONENT_TYPES) {
    componentExpected.set(folderName, new Set());
  }

  for (const entry of Object.values(manifestEntries)) {
    const parts = entry.path.split(path.sep).join('/').split('/');
    if (parts.length >= 3 && parts[0] === 'components') {
      const folderName = parts[1];
      const set = componentExpected.get(folderName);
      if (set) set.add(parts[2]);
    }
  }

  for (const [, folderName] of COMPONENT_TYPES) {
    const folder = path.join(outDir, 'components', folderName);
    if (!fs.existsSync(folder)) continue;
    const isFlow = folderName === 'flows';
    const expected = componentExpected.get(folderName) ?? new Set();

    const items = await fsp.readdir(folder);
    for (const itemName of items.sort()) {
      if (itemName === 'schema.json') continue;
      const itemPath = path.join(folder, itemName);
      const stat = fs.statSync(itemPath);
      if (isFlow) {
        if (stat.isDirectory() && !expected.has(itemName)) stale.push(itemPath);
      } else {
        if (stat.isFile() && !expected.has(itemName)) stale.push(itemPath);
      }
    }
  }

  const objTypesDir = path.join(outDir, 'components', 'object-types');
  if (fs.existsSync(objTypesDir)) {
    const expectedTypeDirs = new Set<string>();
    for (const key of Object.keys(manifestEntries)) {
      if (key.endsWith('/__schema__')) {
        const typeId = key.slice(0, -'/__schema__'.length);
        expectedTypeDirs.add(safeFilename(typeId));
      }
    }
    const items = await fsp.readdir(objTypesDir);
    for (const itemName of items.sort()) {
      const itemPath = path.join(objTypesDir, itemName);
      if (fs.statSync(itemPath).isDirectory() && !expectedTypeDirs.has(itemName)) {
        stale.push(itemPath);
      }
    }
  }

  if (stale.length === 0) return;

  console.log('\n── Stale Snapshot Files ────────────────────────────────────────');
  console.log(`  ${stale.length} item(s) on disk no longer exist on the platform:`);
  for (const p of stale) {
    const rel = path.relative(outDir, p);
    const suffix = fs.statSync(p).isDirectory() ? '/' : '';
    console.log(`    ${rel}${suffix}`);
  }

  let confirm: string;
  if (autoConfirm) {
    confirm = 'y';
  } else {
    console.log();
    const rl = readlinePromises.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      confirm = (await rl.question('  Delete these? [y/N] ')).trim().toLowerCase();
    } catch {
      confirm = 'n';
      console.log();
    } finally {
      rl.close();
    }
  }

  if (confirm === 'y') {
    for (const p of stale) {
      if (fs.statSync(p).isDirectory()) {
        await fsp.rm(p, { recursive: true, force: true });
      } else {
        await fsp.unlink(p);
      }
    }
    console.log(`  Deleted ${stale.length} item(s).`);
  } else {
    console.log('  Skipped — no files deleted.');
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

async function writeManifest(
  entries: Record<string, ManifestEntry | ObjectTypeManifestEntry>,
  syncedAt: string,
  outDir: string,
): Promise<void> {
  const manifest: Manifest = { syncedAt, records: entries };
  await writeJson(path.join(outDir, 'manifest.json'), manifest);
  console.log(`\n  manifest.json written (${Object.keys(entries).length} record(s))`);
}

// ---------------------------------------------------------------------------
// Main export logic
// ---------------------------------------------------------------------------

async function exportType(
  typeId: string,
  folder: string,
  outDir: string,
  manifestEntries: Record<string, ManifestEntry | ObjectTypeManifestEntry>,
  opts: {
    postProcess?: (rec: Rec) => Promise<void>;
    jsonInSubdir?: boolean;
  } = {},
): Promise<[number, number]> {
  const display = typeId;
  process.stdout.write(`  ${display}… `);

  let records: Rec[];
  try {
    records = await fetchAllRecords(typeId);
  } catch (err) {
    console.error(`FAILED\n    ${String(err)}`);
    return [0, 0];
  }

  if (records.length === 0) {
    console.log('0 records, skipping.');
    return [0, 0];
  }

  await fsp.mkdir(folder, { recursive: true });
  let written = 0;

  for (const rec of records) {
    const redacted = redactSecrets(rec);
    const rid = safeFilename(getRecordId(redacted));

    let outPath: string;
    if (opts.jsonInSubdir) {
      outPath = path.join(folder, rid, 'flow.json');
    } else {
      outPath = path.join(folder, `${rid}.json`);
    }

    await writeJson(outPath, redacted);

    const relPath = path.relative(outDir, outPath);
    const manifestKey = `${typeId}/${rid}`;
    manifestEntries[manifestKey] = buildManifestEntry(redacted, typeId, relPath);

    if (opts.postProcess) {
      await opts.postProcess(redacted);
    }

    written++;
  }

  console.log(`${written} record(s) → ${folder}`);
  return [records.length, written];
}

function loadPreviousManifest(outDir: string): Record<string, ManifestEntry> {
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<Manifest>;
    return (data.records ?? {}) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}

function printChangeSummary(
  oldRecords: Record<string, ManifestEntry>,
  newRecords: Record<string, ManifestEntry | ObjectTypeManifestEntry>,
): void {
  const oldKeys = new Set(Object.keys(oldRecords));
  const newKeys = new Set(Object.keys(newRecords));

  const added = [...newKeys].filter(k => !oldKeys.has(k)).sort();
  const removed = [...oldKeys].filter(k => !newKeys.has(k)).sort();
  const common = [...oldKeys].filter(k => newKeys.has(k));

  const updated: string[] = [];
  for (const key of common.sort()) {
    const oldHash = oldRecords[key]?.hash ?? '';
    const newHash = newRecords[key]?.hash ?? '';
    if (oldHash !== newHash) {
      const oldVer = oldRecords[key]?.version ?? '?';
      const newVer = newRecords[key]?.version ?? '?';
      updated.push(`${key} (v${oldVer} → v${newVer})`);
    }
  }

  const unchanged = common.length - updated.length;

  console.log('── Change Summary ──────────────────────────────────────────────');
  if (added.length === 0 && removed.length === 0 && updated.length === 0) {
    console.log(`  No changes detected (${unchanged} record(s) unchanged)`);
  } else {
    if (added.length > 0) {
      console.log(`  Added (${added.length}):`);
      for (const key of added) {
        const name = newRecords[key]?.name ?? '';
        console.log(`    + ${key}  ${name}`);
      }
    }
    if (updated.length > 0) {
      console.log(`  Updated (${updated.length}):`);
      for (const desc of updated) console.log(`    ~ ${desc}`);
    }
    if (removed.length > 0) {
      console.log(`  Removed (${removed.length}):`);
      for (const key of removed) {
        const name = oldRecords[key]?.name ?? '';
        console.log(`    - ${key}  ${name}`);
      }
    }
    if (unchanged > 0) console.log(`  Unchanged: ${unchanged} record(s)`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run(outDir: string, opts: RunOptions): Promise<void> {
  const syncedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '.000+00:00');
  const manifestEntries: Record<string, ManifestEntry | ObjectTypeManifestEntry> = {};
  const oldRecords = loadPreviousManifest(outDir);

  const { tenantId, silo } = getConfig();
  console.log(`Snapshotting Contextual platform → ${outDir}`);
  console.log(`Tenant: ${tenantId}  Silo: ${silo}`);
  console.log(`Sync time: ${syncedAt}\n`);

  // Eager auth check
  console.log('── Auth ────────────────────────────────────────────────────────');
  process.stdout.write('  Exchanging client credentials… ');
  await fetchBearerToken();
  console.log('OK\n');

  // 1. Component types
  console.log('── Components ──────────────────────────────────────────────────');
  for (const [typeId, folderName] of COMPONENT_TYPES) {
    const folder = path.join(outDir, 'components', folderName);

    let postProcess: ((rec: Rec) => Promise<void>) | undefined;
    if (typeId === 'flow') {
      postProcess = (rec: Rec) => postProcessFlow(rec, folder);
    }

    await exportType(typeId, folder, outDir, manifestEntries, {
      postProcess,
      jsonInSubdir: typeId === 'flow',
    });

    const schema = await fetchTypeSchema(typeId);
    if (schema) {
      await fsp.mkdir(folder, { recursive: true });
      await writeJson(path.join(folder, 'schema.json'), schema);
    }
  }

  // 2. Custom object types
  console.log('\n── Object Types ────────────────────────────────────────────────');
  let customTypes: Rec[] = [];
  try {
    customTypes = await fetchCustomTypes();
  } catch (err) {
    process.stderr.write(`  [error] Could not fetch types list: ${String(err)}\n`);
  }

  if (customTypes.length === 0) {
    console.log('  No custom object types found.');
  } else {
    for (const t of customTypes) {
      if (!t['id']) continue;
      await exportObjectType(t, outDir, manifestEntries, opts.skipExamples);
    }
  }

  // 3. Registry OpenAPI spec
  console.log('\n── Registry API ────────────────────────────────────────────────');
  process.stdout.write('  OpenAPI spec… ');
  const openapi = await fetchOpenApiSpec();
  if (openapi) {
    const specPath = path.join(outDir, 'registry-api.openapi.json');
    await writeJson(specPath, openapi);
    const version = (openapi['info'] as Rec | undefined)?.['version'] ?? '?';
    console.log(`v${version} → ${specPath}`);
  } else {
    console.log('SKIPPED (could not fetch)');
  }

  // 4. Write manifest
  await writeManifest(manifestEntries, syncedAt, outDir);

  console.log();
  printChangeSummary(oldRecords, manifestEntries);
  await cleanupStaleFiles(outDir, manifestEntries, opts.autoConfirm);
  console.log('\nDone.');
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { out: string; yes: boolean; skipExamples: boolean } {
  const args = process.argv.slice(2);
  let out = 'tenant-snapshot';
  let yes = false;
  let skipExamples = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--out' || arg === '-o') && args[i + 1]) {
      out = args[++i];
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--skip-examples') {
      skipExamples = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node export.js [--out <dir>] [--yes] [--skip-examples]

Required env vars (set in .env or shell):
  CTXL_CLIENT_ID      — Client ID from the Contextual platform API key
  CTXL_CLIENT_SECRET  — Client Secret from the Contextual platform API key
  CTXL_TENANT_ID      — Tenant ID (e.g. alba-netchb)
  CTXL_SILO           — dev (default) or prod
      `.trim());
      process.exit(0);
    }
  }

  return { out, yes, skipExamples };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadDotenv();
  const args = parseArgs();
  const outDir = path.resolve(process.cwd(), args.out);

  try {
    await run(outDir, { autoConfirm: args.yes, skipExamples: args.skipExamples });
  } catch (err) {
    process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
