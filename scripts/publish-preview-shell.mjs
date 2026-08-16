#!/usr/bin/env node
/**
 * publish-preview-shell.mjs
 *
 * Bouwt packages/preview-shell als tar.gz en uploadt naar Supabase Storage
 * bucket `preview-shell-templates` als `preview-shell-vX.Y.Z.tar.gz`. De
 * sandbox-build-trigger `build_from_ai` phase downloadt deze template en
 * plakt de AI-gegenereerde Component + manifest erin.
 *
 * Runt éénmalig (of wanneer preview-shell wijzigt). Vereist:
 *   env SUPABASE_URL          - project URL
 *   env SUPABASE_SERVICE_ROLE_KEY - sb_secret_... (voor bucket upload)
 *
 * Zet die via .env.local of expliciet:
 *   $env:SUPABASE_URL = "https://ltzzxjrnhfcilfplpoep.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY = "sb_secret_..."
 *   node scripts/publish-preview-shell.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHELL_DIR = join(REPO_ROOT, 'packages', 'preview-shell');
const OUT_DIR = join(REPO_ROOT, '.spike-build');

function fail(msg) { console.error('ERROR:', msg); process.exit(1); }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL) fail('Zet SUPABASE_URL in env');
if (!SERVICE_KEY) fail('Zet SUPABASE_SERVICE_ROLE_KEY in env (sb_secret_...)');
if (!SERVICE_KEY.startsWith('sb_secret_') && !SERVICE_KEY.startsWith('eyJ')) {
  fail('SUPABASE_SERVICE_ROLE_KEY moet een service-role key zijn (sb_secret_... of legacy JWT). GEEN publishable/anon key.');
}

// Version uit package.json
const pkg = JSON.parse(readFileSync(join(SHELL_DIR, 'package.json'), 'utf8'));
const version = pkg.version || '0.0.0';
const objectPath = `preview-shell-v${version}.tar.gz`;

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outTar = join(OUT_DIR, `preview-shell-v${version}-${stamp}.tar.gz`);

// Tar met cross-tar fallback (zelfde patroon als build-component-archive)
{
  const posixOut = outTar.replace(/\\/g, '/');
  const posixShell = SHELL_DIR.replace(/\\/g, '/');
  const base = `-czf "${posixOut}" --exclude=node_modules --exclude=dist --exclude=.git -C "${posixShell}" .`;
  try {
    execSync(`tar ${base}`, { stdio: 'pipe' });
  } catch {
    try {
      execSync(`tar --force-local ${base}`, { stdio: 'pipe' });
    } catch (e) {
      fail(`tar faalde: ${e.message}`);
    }
  }
}

const size = statSync(outTar).size;
console.log(`[1/2] Preview-shell v${version} → ${outTar} (${(size / 1024).toFixed(1)} KB)`);

// Upload naar Storage via REST — service-role bypasseert RLS.
// Overwrite als bestaat (x-upsert: true).
const uploadUrl = `${SUPABASE_URL}/storage/v1/object/preview-shell-templates/${objectPath}`;
const buf = readFileSync(outTar);
const r = await fetch(uploadUrl, {
  method: 'POST',
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/gzip',
    'x-upsert': 'true',
  },
  body: buf,
});
if (!r.ok) {
  fail(`Upload faalde ${r.status}: ${await r.text()}`);
}

console.log(`[2/2] Uploaded: preview-shell-templates/${objectPath}`);
console.log('');
console.log('Sandbox-build-trigger `build_from_ai` phase zal deze template downloaden');
console.log('via een signed URL en de AI-Component + manifest erin patchen.');
console.log('');
console.log('Cleanup lokale tar: rm ".spike-build/preview-shell-v' + version + '-*.tar.gz"');
