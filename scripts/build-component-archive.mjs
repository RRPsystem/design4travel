#!/usr/bin/env node
/**
 * build-component-archive.mjs
 *
 * Bouwt een tar.gz-archive voor de sandbox-pipeline, gebaseerd op:
 *   - packages/preview-shell/       — Vite+React+TS+Tailwind template
 *   - een Studio4-component-pakket  — manifest.json + <ComponentName>.tsx (+ optionele fixtures/css)
 *   - een canonical travel-fixture  — packages/content-fixtures/travel/*.json
 *
 * Werkwijze:
 *   1. Kopieer preview-shell naar tijdelijke build-directory.
 *   2. Kopieer Component.tsx uit pakket naar
 *      <tmp>/src/components/<ComponentName>.tsx (naast bestaande types.ts).
 *   3. Verwijder placeholder GeneratedComponent.tsx.
 *   4. Overschrijf App.tsx zodat het de juiste component importeert en
 *      de transparentNav-hint uit manifest.pageLevel meeneemt.
 *   5. Kopieer canonical travel-fixture over placeholder in src/fixtures.
 *   6. Tar.gz de <tmp> naar .spike-build/component-<manifest.id>-<stamp>.tar.gz.
 *   7. Schrijf .meta.json met component-id, sha256, size, source-refs.
 *
 * Gebruik:
 *   node scripts/build-component-archive.mjs \
 *     --package packages/studio4-sdk/tests/fixtures/safari-hero-v1 \
 *     --fixture packages/content-fixtures/travel/fixture-safari-zuid-afrika-mauritius-001.json
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// -----------------------------------------------------------------------------
// CLI-args
// -----------------------------------------------------------------------------

function arg(name, fallback) {
  const idx = process.argv.indexOf('--' + name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const PACKAGE_DIR = resolve(
  REPO_ROOT,
  arg('package', 'packages/studio4-sdk/tests/fixtures/safari-hero-v1'),
);
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  arg('fixture', 'packages/content-fixtures/travel/fixture-safari-zuid-afrika-mauritius-001.json'),
);

const SHELL_DIR = join(REPO_ROOT, 'packages', 'preview-shell');
const OUT_DIR = join(REPO_ROOT, '.spike-build');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

function fail(msg) {
  console.error('ERROR:', msg);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Sanity checks
// -----------------------------------------------------------------------------

if (!existsSync(PACKAGE_DIR)) fail(`Pakket-directory ontbreekt: ${PACKAGE_DIR}`);
if (!existsSync(FIXTURE_PATH)) fail(`Fixture ontbreekt: ${FIXTURE_PATH}`);
if (!existsSync(SHELL_DIR)) fail(`preview-shell ontbreekt: ${SHELL_DIR}`);

const manifestPath = join(PACKAGE_DIR, 'manifest.json');
if (!existsSync(manifestPath)) fail(`manifest.json ontbreekt in pakket: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.sdkVersion !== '1.0') fail(`sdkVersion moet '1.0' zijn, was: ${manifest.sdkVersion}`);
if (!manifest.componentName || !manifest.fileName) fail('manifest.componentName / fileName ontbreekt');

const componentSrc = join(PACKAGE_DIR, manifest.fileName);
if (!existsSync(componentSrc)) fail(`Component-bestand ontbreekt: ${componentSrc}`);

const transparentNav = Boolean(manifest.pageLevel?.requiresTransparentNav);

// -----------------------------------------------------------------------------
// Bouw tijdelijke werk-directory
// -----------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
const workDir = join(OUT_DIR, `component-${manifest.id}-${STAMP}`);
rmSync(workDir, { recursive: true, force: true });

// Kopieer alles behalve node_modules / dist / .git uit shell
cpSync(SHELL_DIR, workDir, {
  recursive: true,
  filter: (src) => {
    const skip = ['node_modules', 'dist', '.git', '.spike-build'];
    return !skip.some((s) => src.endsWith(s) || src.includes(`${s}/`) || src.includes(`${s}\\`));
  },
});
console.log(`[1/5] preview-shell gekopieerd naar ${workDir}`);

// Verwijder placeholder GeneratedComponent.tsx en schrijf echte component
const placeholderPath = join(workDir, 'src', 'components', 'GeneratedComponent.tsx');
if (existsSync(placeholderPath)) rmSync(placeholderPath);

const componentDst = join(workDir, 'src', 'components', manifest.fileName);
cpSync(componentSrc, componentDst);
console.log(`[2/5] Component gekopieerd → src/components/${manifest.fileName}`);

// -----------------------------------------------------------------------------
// Schrijf nieuwe App.tsx
// -----------------------------------------------------------------------------

const componentName = manifest.componentName;
const appTsx = `import { Studio4SiteLayout } from './layout/Studio4SiteLayout';
import { ${componentName} } from './components/${componentName}';
import { MOCK_BRAND } from './mocks/brand';
import { MOCK_PAGE_CONTENT } from './mocks/pageContent';

/**
 * Auto-gegenereerd door scripts/build-component-archive.mjs.
 * Bron-pakket: ${manifest.id} (sdkVersion ${manifest.sdkVersion})
 * transparentNav (uit manifest.pageLevel.requiresTransparentNav): ${transparentNav}
 */
export default function App() {
  return (
    <Studio4SiteLayout brand={MOCK_BRAND} transparentNav={${transparentNav}}>
      <${componentName}
        brand={MOCK_BRAND}
        primaryColor={MOCK_BRAND.primary_color}
        secondaryColor={MOCK_BRAND.secondary_color}
        basePath="/"
        pageContent={MOCK_PAGE_CONTENT}
      />
    </Studio4SiteLayout>
  );
}
`;
writeFileSync(join(workDir, 'src', 'App.tsx'), appTsx);
console.log(`[3/5] App.tsx herschreven voor <${componentName}> (transparentNav=${transparentNav})`);

// -----------------------------------------------------------------------------
// Overschrijf fixture
// -----------------------------------------------------------------------------

const fixtureDst = join(workDir, 'src', 'fixtures', 'travel.json');
cpSync(FIXTURE_PATH, fixtureDst);
console.log(`[4/5] Fixture gekopieerd → src/fixtures/travel.json`);

// -----------------------------------------------------------------------------
// Tar.gz
// -----------------------------------------------------------------------------

const outTar = join(OUT_DIR, `component-${manifest.id}-${STAMP}.tar.gz`);
try {
  // --force-local: op Windows tar interpreteert 'C:' anders als remote host.
  // Path-to-POSIX voor de -C zodat mingw/msys-tar het ook niet als remote leest.
  const posixOut = outTar.replace(/\\/g, '/');
  const posixWork = workDir.replace(/\\/g, '/');
  execSync(
    `tar --force-local -czf "${posixOut}" --exclude=node_modules --exclude=dist --exclude=.git -C "${posixWork}" .`,
    { stdio: 'inherit' },
  );
} catch (e) {
  fail(`tar-commando faalde: ${e.message}`);
}

// Meta
const buf = readFileSync(outTar);
const sha = createHash('sha256').update(buf).digest('hex');
const size = statSync(outTar).size;
const meta = {
  archive_path: outTar,
  archive_sha256: sha,
  archive_size_kb: Number((size / 1024).toFixed(2)),
  built_at: new Date().toISOString(),
  component: {
    id: manifest.id,
    name: componentName,
    filename: manifest.fileName,
    registry_key: manifest.registryKey,
    requires_transparent_nav: transparentNav,
    sdk_version: manifest.sdkVersion,
  },
  source: {
    package_dir: PACKAGE_DIR,
    fixture_path: FIXTURE_PATH,
    shell_dir: SHELL_DIR,
  },
  excluded: ['node_modules', 'dist', '.git'],
  contains_secrets: false,
};
writeFileSync(outTar.replace(/\.tar\.gz$/, '.meta.json'), JSON.stringify(meta, null, 2));

console.log('');
console.log('=== Component archive ready ===');
console.log('Component :', componentName, `(${manifest.id})`);
console.log('Archive   :', outTar);
console.log('SHA256    :', sha);
console.log('Size      :', `${meta.archive_size_kb} KB`);
console.log('');
console.log('Volgende stap:');
console.log('  1. Upload dit .tar.gz naar sandbox-archives bucket in Supabase Dashboard.');
console.log('  2. Run .\\scripts\\run-spike.ps1 -AnonKey ... -ArchivePath "' +
  outTar.split(/[\\/]/).pop() + '" -KeepAlive');
console.log('  3. Plak sandbox_id in previewdesign4.netlify.app (mode: remote) → Expose in iframe.');
