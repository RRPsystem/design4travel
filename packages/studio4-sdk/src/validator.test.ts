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
  requestedImports: ['lucide-react', './types'],
  consumes: {
    brand: ['primary_color', 'name'],
    primaryColor: true,
    pageContent: ['hero'],
  },
  media: [
    { role: 'background', kind: 'image', minWidth: 1600 },
  ],
  assets: [
    { key: 'hero-bg', query: 'safari sunset kruger', role: 'hero-bg' },
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
import type { SectionProps } from './types';

export function HeroSafariSection({ brand, primaryColor, pageContent, assets = {} }: SectionProps) {
  return (
    <section className="relative min-h-screen" style={{ backgroundColor: primaryColor }}>
      <img src={assets['hero-bg']} alt="" />
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

  // AST-scan (iteratie 2) elimineert false-positives van de tekst-scan.
  it('accepteert "Function" in JSDoc/line-comment (false-positive fix)', () => {
    const tsx = VALID_TSX + `
// Design4-backend media-search vervangt Function-tokens na validatie.
/* Function-string in block-comment mag ook. */
`;
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(true);
  });

  it('accepteert "fetch" in string-literal (false-positive fix)', () => {
    const tsx = VALID_TSX + `
const doc = { note: 'we do NOT use fetch here, data comes from props' };
`;
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(true);
  });

  it('accepteert "eval" als property-key op eigen object (false-positive fix)', () => {
    const tsx = VALID_TSX + `
const helpers = { eval: (x: number) => x + 1 };
const y = helpers.eval(5);
`;
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(true);
  });

  it('accepteert obj.fetch — property-access is geen global-ref', () => {
    const tsx = VALID_TSX + `
const service: { fetch: () => void } = { fetch: () => {} };
service.fetch();
`;
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(true);
  });

  it('blijft fetch afwijzen in template-literal expression `${fetch()}`', () => {
    const tsx = VALID_TSX + `
const s = \`live: \${fetch('/api').toString()}\`;
`;
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('fetch'))).toBe(true);
  });

  it('blijft { fetch } shorthand-reference afwijzen', () => {
    const tsx = VALID_TSX + `
const dep = { fetch };
`;
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('fetch'))).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Image domain whitelist
// -----------------------------------------------------------------------------

describe('validatePackage - image domain whitelist', () => {
  // TSX-template met een concrete URL als string-literal, om de URL-scan te
  // testen. Gebruikt assets['hero-bg'] als src (asset-manifest patroon) en
  // heeft een tweede image met concrete URL om te valideren tegen whitelist.
  function makeTsxWithUrl(url: string): string {
    return `
import { ArrowDown } from 'lucide-react';
import type { SectionProps } from './types';

export function HeroSafariSection({ brand, primaryColor, pageContent, assets = {} }: SectionProps) {
  const otherImage = '${url}';
  return (
    <section className="relative min-h-screen" style={{ backgroundColor: primaryColor }}>
      <img src={assets['hero-bg']} alt="" />
      <img src={otherImage} alt="brand-logo" />
      <h1>{brand.name}</h1>
      <ArrowDown />
    </section>
  );
}
`;
  }

  it('accepteert URLs op whitelisted domeinen (cloudinary)', () => {
    const r = validatePackage(
      makeFiles({ componentTsx: makeTsxWithUrl('https://res.cloudinary.com/demo/image/upload/sample.jpg') }),
    );
    expect(r.ok).toBe(true);
  });

  it('accepteert subdomeinen van whitelisted hosts (supabase)', () => {
    const r = validatePackage(
      makeFiles({ componentTsx: makeTsxWithUrl('https://foo.supabase.co/storage/v1/object/public/x.jpg') }),
    );
    expect(r.ok).toBe(true);
  });

  it('wijst URLs op niet-whitelisted domeinen af', () => {
    const r = validatePackage(
      makeFiles({ componentTsx: makeTsxWithUrl('https://evil.example.com/tracker.gif') }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 'policy.image-domain-not-allowed')).toBe(true);
  });

  it('wijst images.unsplash.com af — AI moet assets-manifest gebruiken', () => {
    const r = validatePackage(
      makeFiles({ componentTsx: makeTsxWithUrl('https://images.unsplash.com/photo-1516426122078-c23e76319801') }),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 'policy.image-domain-not-allowed')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Asset-manifest cross-check (nieuw in fase 0)
// -----------------------------------------------------------------------------

describe('validatePackage - asset-manifest cross-check', () => {
  it('happy path: assets["hero-bg"] gebruikt + gedeclareerd → ok', () => {
    const r = validatePackage(makeFiles());
    expect(r.ok).toBe(true);
  });

  it('wijst af als component assets["foo"] gebruikt maar niet in manifest.assets staat', () => {
    const tsx = VALID_TSX.replace("assets['hero-bg']", "assets['not-declared']");
    const r = validatePackage(makeFiles({ componentTsx: tsx }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.rule === 'policy.asset-key-not-declared')).toBe(true);
  });

  it('warning (geen error) als manifest.assets een unused key heeft', () => {
    const bad = {
      ...VALID_MANIFEST,
      assets: [
        { key: 'hero-bg', query: 'safari sunset kruger', role: 'hero-bg' as const },
        { key: 'orphan', query: 'unused', role: 'card' as const },
      ],
    };
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(true);
    expect(r.warningCount).toBeGreaterThan(0);
    expect(r.issues.some((i) => i.rule === 'policy.asset-key-unused' && i.message.includes('orphan'))).toBe(true);
  });

  it('accepteert component zonder assets als manifest ook geen assets heeft', () => {
    const nakedTsx = `
import type { SectionProps } from './types';
export function HeroSafariSection({ brand }: SectionProps) {
  return <section><h1>{brand.name}</h1></section>;
}
`;
    const nakedManifest = { ...VALID_MANIFEST };
    delete (nakedManifest as { assets?: unknown }).assets;
    const r = validatePackage(makeFiles({ componentTsx: nakedTsx, manifestJson: JSON.stringify(nakedManifest) }));
    expect(r.ok).toBe(true);
  });

  it('wijst manifest.assets af met dubbele key', () => {
    const bad = {
      ...VALID_MANIFEST,
      assets: [
        { key: 'hero-bg', query: 'safari one', role: 'hero-bg' as const },
        { key: 'hero-bg', query: 'safari two', role: 'card' as const },
      ],
    };
    const r = validatePackage(makeFiles({ manifestJson: JSON.stringify(bad) }));
    expect(r.ok).toBe(false);
  });
});
