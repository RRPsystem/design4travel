import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage } from './validator.js';

/**
 * Integration-test — een echt, handmatig geschreven safari-hero-pakket moet
 * door validatePackage() als OK worden geaccepteerd. Bewijst dat het contract
 * werkbaar is voor de content-vorm die Engine A straks moet produceren
 * (gelaagde hero met transparent-nav-aanvraag, imgHeroResponsive-gebruik,
 * unsplash-image-URL, lucide-icoontjes).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'tests', 'fixtures', 'safari-hero-v1');

describe('validatePackage - safari-hero-v1 fixture (integration)', () => {
  it('accepteert het handmatig geschreven safari-hero-pakket volledig', () => {
    const files = {
      manifestJson: readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'),
      componentTsx: readFileSync(join(FIXTURE_DIR, 'SafariHeroSection.tsx'), 'utf8'),
    };

    const r = validatePackage(files);

    if (!r.ok) {
      // Print alle issues voor snelle diagnose
      console.error('safari-hero-v1 issues:', JSON.stringify(r.issues, null, 2));
    }

    expect(r.ok).toBe(true);
    expect(r.errorCount).toBe(0);
    expect(r.manifest?.id).toBe('safari-hero-v1');
    expect(r.manifest?.componentName).toBe('SafariHeroSection');
    expect(r.manifest?.registryKey).toBe('safari_hero');
  });
});
