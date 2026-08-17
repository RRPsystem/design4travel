// Regenereert supabase/functions/resolve-content-source/fixtures-embedded.ts
// vanuit packages/content-fixtures/travel/*.json. Nodig omdat Deno Edge
// Functions in Supabase geen runtime-fs-access hebben — content moet bij
// deploy in de bundle zitten als string-constante.
//
// Gebruik:  node scripts/embed-content-fixtures.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = 'packages/content-fixtures/travel';
const OUT_FILE = 'supabase/functions/resolve-content-source/fixtures-embedded.ts';

const files = readdirSync(SRC_DIR).filter((f) => f.startsWith('fixture-') && f.endsWith('.json'));

const entries = files.map((f) => {
  const slug = f.replace(/^fixture-/, '').replace(/\.json$/, '');
  const raw = readFileSync(join(SRC_DIR, f), 'utf8');
  // Voor een template-literal: escape backslash, backtick en ${.
  const escaped = raw
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  return { slug, escaped, src: f };
});

const out = [
  '// AUTO-GENERATED door scripts/embed-content-fixtures.mjs — do NOT edit by hand.',
  '// Bron: packages/content-fixtures/travel/*.json',
  '// Regenereer bij elke fixture-wijziging + supabase functions deploy resolve-content-source.',
  '',
  'export const EMBEDDED_FIXTURES: Record<string, string> = {',
  ...entries.map(({ slug, escaped }) => `  '${slug}': \`${escaped}\`,`),
  '};',
  '',
].join('\n');

writeFileSync(OUT_FILE, out, 'utf8');
console.log(`Wrote ${OUT_FILE} with ${entries.length} fixture(s): ${entries.map((e) => e.slug).join(', ')}`);
