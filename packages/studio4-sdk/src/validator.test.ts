import { describe, expect, it } from 'vitest';
import { validatePackage, type PackageFiles } from './validator.js';
import type { Studio4ComponentManifest } from './types.js';

/**
 * Vitest-suite voor de Studio4-SDK v1.0 validator.
 *
 * Doel: bewijzen dat de validator in beide richtingen werkt:
 *   - accept happy-path pakket
 *   - reject elke bekende faalcase (manifest-shape, imports, globals, URLs)
 *
 * Zo landt AI-generatie straks tegen een echte gate, niet een noop.
 */

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const VALID_MANIFEST: Studio4ComponentManifest = {
  sdkVersion: '1.0',
  id: 'hero-safari-v1',
  displayName: 'Safari Hero',
  componentName: 'HeroSafariSection',
  fileName: 'HeroSafariSection.tsx',
  registryKey: 'hero_safari',
  category: 'hero',
  producedBy: {
    engine: 'studio4-component',
    iteration: 1,
    parentCallId: 'acm_test_123',
    sourceReferenceId: 'ref_test_abc',
  },
  requestedImports: ['react', 'lucide-react', '../../lib/imageUtils', './types'],
  consumes: {
    brand: ['primary_color', 'name'],
    primaryColor: true,
    pageContent: ['hero'],
  },
  media: [
    { role: 'background', kind: 'image', minWidth: 1600 },
  ],
  pageLevel: {
    requiresTransparentNav: true,
    recommendedPage: 'home',
    reviewerNote: 'Plaats op pagina met transparentNav={true}',
  },
  responsive: {
    breakpoints: ['sm', 'md', 'lg', 'xl', '2xl'],
    mobileStrategy: 'stacked',
  },
  a11y: {
    landmarks: ['banner'],
    supportsReducedMotion: true,
  },
};

const VALID_TSX = `
import { ArrowDown } from 'lucide-react';
import { imgHeroResponsive } from '../../lib/imageUtils';
import type { SectionProps } from './types';

export function HeroSafariSection({ brand, primaryColor, pageContent }: SectionProps) {
  const bg = imgHeroResponsive('https://images.pexels.com/photos/1/pic.jpg');
  return (
    <section className="relative min-h-screen" style={{ backgroundColor: primaryColor }}>
      <img src={bg.src} srcSet={bg.srcSet} sizes={bg.sizes} alt="" />
      <h1>{brand.name}</h1>
      <ArrowDown />
    </section>
  );
}
`;

function makeFiles(overrides?: Partial<PackageFiles>): PackageFiles {
  return {
    manifestJson: JSON.stringify(VALID_MANIFEST),
    componentTsx: VALID_TSX,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------------

describe('validatePackage - happy path', () => {
  it('accepteert een geldig pakket', () => {
    const r = validatePackage(makeFiles());
    expect(r.ok).toBe(true);
    expect(r.errorCount).toBe(0);
    expect(r.manifest?.id).toBe('hero-safari-v1');
  });
});

// -----------------------------------------------------------------------------
// Manifest shape
// -----------------------------------------------------------------------------

describe('validatePackage - manifest shape', () => {
  it('wijst invalide JSON af', () => {
    const r = validatePackage(makeFiles({ manifestJson: '{"broken":' }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 'manifest.json-invalid-json')).toBe(true);
  });

  it('wijst manifest zonder sdkVersion af', () => {
    const bad = { ...VALID_MANIFEST } as Record<string, unknown>;
    delete bad.sdkVersion;
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule.startsWith('manifest.'))).toBe(true);
  });

  it('wijst verkeerde sdkVersion af', () => {
    const bad = { ...VALID_MANIFEST, sdkVersion: '2.0' };
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(false);
  });

  it('wijst niet-PascalCase componentName af', () => {
    const bad = { ...VALID_MANIFEST, componentName: 'heroSafariSection' };
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('componentName'))).toBe(true);
  });

  it('wijst niet-snake_case registryKey af', () => {
    const bad = { ...VALID_MANIFEST, registryKey: 'HeroSafari' };
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('registryKey'))).toBe(true);
  });

  it('wijst fileName af die niet matcht met componentName', () => {
    const bad = { ...VALID_MANIFEST, fileName: 'OtherName.tsx' };
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('fileName'))).toBe(true);
  });

  it('wijst unknown top-level velden af (strict)', () => {
    const bad = { ...VALID_MANIFEST, unauthorizedField: 'attack' };
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Import whitelist
// -----------------------------------------------------------------------------

describe('validatePackage - import whitelist', () => {
  it('wijst import buiten POLICY_V1_0.allowedImports af', () => {
    const bad = {
      ...VALID_MANIFEST,
      requestedImports: ['react', 'axios', './types'],
    };
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 'policy.import-not-allowed')).toBe(true);
    expect(r.issues.some((i) => i.message.includes('axios'))).toBe(true);
  });

  it('wijst een uit whitelist verwijderde subpath af (bv. echte lodash)', () => {
    const bad = {
      ...VALID_MANIFEST,
      requestedImports: ['react', 'lodash/get', './types'],
    };
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Forbidden globals in TSX
// -----------------------------------------------------------------------------

describe('validatePackage - forbidden globals in TSX', () => {
  it('wijst fetch() gebruik af', () => {
    const tsx = VALID_TSX + `
export function badFn() { return fetch('/api/data'); }
`;
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('fetch'))).toBe(true);
  });

  it('wijst localStorage af', () => {
    const tsx = VALID_TSX + `
const v = localStorage.getItem('key');
`;
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('localStorage'))).toBe(true);
  });

  it('wijst eval af', () => {
    const tsx = VALID_TSX + `
eval('doStuff()');
`;
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('eval'))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Image domain whitelist
// -----------------------------------------------------------------------------

describe('validatePackage - image domain whitelist', () => {
  it('accepteert URLs op whitelisted domeinen (pexels, unsplash)', () => {
    const tsx = VALID_TSX.replace(
      'images.pexels.com/photos/1/pic.jpg',
      'images.unsplash.com/photo-123.jpg',
    );
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(true);
  });

  it('accepteert subdomeinen van whitelisted hosts', () => {
    const tsx = VALID_TSX.replace(
      'images.pexels.com/photos/1/pic.jpg',
      'foo.supabase.co/storage/v1/object/public/x.jpg',
    );
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(true);
  });

  it('wijst URLs op niet-whitelisted domeinen af', () => {
    const tsx = VALID_TSX.replace(
      'images.pexels.com/photos/1/pic.jpg',
      'evil.example.com/tracker.gif',
    );
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 'policy.image-domain-not-allowed')).toBe(true);
  });
});
