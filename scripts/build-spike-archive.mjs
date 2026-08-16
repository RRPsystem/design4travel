#!/usr/bin/env node
/**
 * build-spike-archive.mjs
 *
 * Bouwt een tar.gz-archive van packages/spike-sandbox-target/ dat door de
 * E2B-sandbox extract + gebouwd wordt. Copieert eerst de canonical safari-
 * fixture over de placeholder heen, zodat de sandbox de echte fixture-data
 * bindt aan SafariHeroSection.
 *
 * Exclude-lijst (verplicht): node_modules, dist, .git.
 * Geen secrets in de archive — het target-package heeft er geen.
 *
 * Output: `.spike-build/spike-sandbox-target-<timestamp>.tar.gz` +
 *         `.spike-build/spike-sandbox-target-<timestamp>.meta.json`
 *
 * Requirement: tar CLI (Windows 10+ built-in, macOS/Linux standard).
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const TARGET_DIR = join(REPO_ROOT, 'packages', 'spike-sandbox-target');
const FIXTURE_SRC = join(
  REPO_ROOT,
  'packages',
  'content-fixtures',
  'travel',
  'fixture-safari-zuid-afrika-mauritius-001.json',
);
const FIXTURE_DST = join(TARGET_DIR, 'src', 'fixtures', 'travel.json');
const OUT_DIR = join(REPO_ROOT, '.spike-build');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_TAR = join(OUT_DIR, `spike-sandbox-target-${STAMP}.tar.gz`);
const OUT_META = join(OUT_DIR, `spike-sandbox-target-${STAMP}.meta.json`);

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// 1. Sanity checks
if (!existsSync(TARGET_DIR)) fail(`Target dir ontbreekt: ${TARGET_DIR}`);
if (!existsSync(FIXTURE_SRC)) fail(`Canonical fixture ontbreekt: ${FIXTURE_SRC}`);

mkdirSync(OUT_DIR, { recursive: true });

// 2. Kopieer canonical fixture over placeholder
copyFileSync(FIXTURE_SRC, FIXTURE_DST);
console.log(`✓ Fixture gekopieerd: ${FIXTURE_DST}`);

// 3. Tar de target-directory
try {
  execSync(
    `tar -czf "${OUT_TAR}" --exclude=node_modules --exclude=dist --exclude=.git -C "${TARGET_DIR}" .`,
    { stdio: 'inherit' },
  );
} catch (err) {
  fail(`tar-commando faalde. Op Windows: tar CLI is standaard in Win10+. Fout: ${err.message}`);
}

// 4. Checksum + size + meta
const buf = readFileSync(OUT_TAR);
const sha = createHash('sha256').update(buf).digest('hex');
const size = statSync(OUT_TAR).size;

const fixtureContent = JSON.parse(readFileSync(FIXTURE_DST, 'utf8'));

const meta = {
  archive_path: OUT_TAR,
  archive_sha256: sha,
  archive_size_bytes: size,
  archive_size_kb: Number((size / 1024).toFixed(2)),
  built_at: new Date().toISOString(),
  source: {
    target_dir: TARGET_DIR,
    fixture_source: FIXTURE_SRC,
    fixture_id: fixtureContent.travel_compositor_id,
    fixture_title: fixtureContent.title,
  },
  excluded: ['node_modules', 'dist', '.git'],
  contains_secrets: false,
  notes:
    'Spike-target archive. Alleen React+Vite+TS+Tailwind + één SafariHeroSection + fixture-data. Geen TravelBridgeAI-broncode.',
};

writeFileSync(OUT_META, JSON.stringify(meta, null, 2));

console.log('\n=== Spike archive ready ===');
console.log('Archive :', OUT_TAR);
console.log('Meta    :', OUT_META);
console.log('SHA256  :', sha);
console.log('Size    :', `${meta.archive_size_kb} KB`);
console.log('\nGebruik: upload dit .tar.gz naar `sandbox-archives` bucket (via `run-spike.mjs` of handmatig).');
