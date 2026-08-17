import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureContentSourceAdapter } from './fixture-adapter.js';
import { TravelContentSchema } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', 'content-fixtures', 'travel');

function fsLoader(slug: string): Promise<string | null> {
  try {
    // Alle fixture-bestanden hebben de vorm `fixture-<slug>.json`
    const p = join(FIXTURES_DIR, `${slug}.json`);
    return Promise.resolve(readFileSync(p, 'utf8'));
  } catch {
    return Promise.resolve(null);
  }
}

describe('FixtureContentSourceAdapter', () => {
  it('resolveert safari-fixture naar geldig TravelContent', async () => {
    const adapter = new FixtureContentSourceAdapter(fsLoader);
    const content = await adapter.resolve('fixture-safari-zuid-afrika-mauritius-001');
    const parsed = TravelContentSchema.safeParse(content);
    expect(parsed.success).toBe(true);
    expect(content.title).toContain('Safari');
    expect(content.days).toBe(14);
    expect(content.countries).toContain('Zuid-Afrika');
    expect(content.countries).toContain('Mauritius');
    expect(content.destinations.length).toBeGreaterThan(0);
    expect(content.hotels?.length).toBeGreaterThan(0);
    expect(content.meta.source_kind).toBe('fixture');
    expect(content.meta.source_id).toBe('fixture-safari-zuid-afrika-mauritius-001');
    expect(content.meta.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dedupliceert destinations op {name,country}', async () => {
    const adapter = new FixtureContentSourceAdapter(fsLoader);
    const content = await adapter.resolve('fixture-safari-zuid-afrika-mauritius-001');
    const johannesburgCount = content.destinations.filter((d) => d.name === 'Johannesburg').length;
    expect(johannesburgCount).toBe(1);
  });

  it('strippped HTML uit description-velden', async () => {
    const adapter = new FixtureContentSourceAdapter(fsLoader);
    const content = await adapter.resolve('fixture-safari-zuid-afrika-mauritius-001');
    for (const d of content.destinations) {
      if (d.description) {
        expect(d.description).not.toContain('<');
        expect(d.description).not.toContain('>');
      }
    }
  });

  it('extraheert hero_image_hint uit pexels://-URL', async () => {
    const adapter = new FixtureContentSourceAdapter(fsLoader);
    const content = await adapter.resolve('fixture-safari-zuid-afrika-mauritius-001');
    // hero_image is 'pexels://safari-elephant-sunset-hero'
    expect(content.hero_image_hint).toBe('safari elephant sunset');
  });

  it('produceert dezelfde hash bij herhaalde resolve (deterministic)', async () => {
    const adapter = new FixtureContentSourceAdapter(fsLoader);
    const a = await adapter.resolve('fixture-safari-zuid-afrika-mauritius-001');
    const b = await adapter.resolve('fixture-safari-zuid-afrika-mauritius-001');
    expect(a.meta.hash).toBe(b.meta.hash);
  });

  it('throws bij onbekende slug', async () => {
    const adapter = new FixtureContentSourceAdapter(fsLoader);
    await expect(adapter.resolve('does-not-exist')).rejects.toThrow(/not found/i);
  });

  it('throws bij lege sourceId', async () => {
    const adapter = new FixtureContentSourceAdapter(fsLoader);
    await expect(adapter.resolve(undefined)).rejects.toThrow(/requires sourceId/);
  });

  it('bevat geen TravelCompositor-veldnamen in de content (sanitisation)', async () => {
    const adapter = new FixtureContentSourceAdapter(fsLoader);
    const content = await adapter.resolve('fixture-safari-zuid-afrika-mauritius-001');
    const json = JSON.stringify(content);
    // Bewust géén: geolocation (raw coords), facilities (TC-icoon-IDs),
    // travel_compositor_id, itinerary-HTML.
    expect(json).not.toContain('geolocation');
    expect(json).not.toContain('facilities');
    expect(json).not.toContain('travel_compositor_id');
    expect(json).not.toContain('otherFacilities');
  });
});
