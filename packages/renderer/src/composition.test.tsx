import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { createDefaultRegistry } from '@design4/typed-nodes';
import { SAMPLE_DATA_VARIANTS } from '@design4/data-bindings';
import { renderTarget } from './index.js';

/**
 * Visuele integratie-test — een complete compositie met ALLE nieuwe
 * primitives + de acceptatie-testscenarios uit user's brief voor PR-A.
 *
 * Test-strategie: server-side render naar static HTML, dan assert dat de
 * verwachte CSS-eigenschappen (background-color, border-radius per hoek,
 * overlay, etc.) daadwerkelijk in de output verschijnen. Geen visuele
 * screenshot (dat is out-of-scope), wel een sterk signaal dat de
 * renderer + styling-pipeline correct wire't.
 *
 * Getest scenario: één section met alle primitives (hero-met-overlay,
 * section-met-lichtbeige-bg, badge, button, image met half-round + 4:3,
 * divider gouden streepje). Verwachte prompt-verzoeken uit user's brief:
 *   - "dun gouden streepje van 80 pixels onder de titel"
 *   - "lichtbeige sectie-achtergrond"
 *   - "foto rechts half rond, 4:3"
 *   - "donkere transparante overlay over hero"
 */

const registry = createDefaultRegistry();

function makeDoc(): DesignDoc {
  return {
    version: SCHEMA_VERSION,
    id: 'composition-test-doc',
    project: { documentType: 'website', title: 'Composition Test' },
    meta: { createdAt: '2026-08-15T00:00:00Z', updatedAt: '2026-08-15T00:00:00Z' },
    brandTokens: { 'brand.primary': '#4f46e5', 'brand.gold': '#d4af37' },
    outputs: { web: { enabled: true } },
    pages: [
      {
        id: 'p1',
        name: 'Home',
        root: {
          id: 'root',
          type: 'layout-column',
          props: { gap: 0, padding: 0 },
          children: [
            // Hero met donkere transparante overlay (acceptance #5).
            {
              id: 'hero-1',
              type: 'hero',
              props: {
                title: 'Ontdek Portugal',
                subtitle: 'Zorgvuldig samengestelde reizen.',
                imageSrc: 'https://images.example.com/portugal-hero.jpg',
                overlayColor: '#000000',
                overlayOpacity: 0.55,
                height: 480,
                align: 'center',
              },
            },
            // Section met lichtbeige achtergrond (acceptance #3).
            {
              id: 'sec-intro',
              type: 'section',
              props: {
                paddingY: 48,
                style: { background: { color: '#f5efe6' } },
              },
              children: [
                {
                  id: 'sec-heading',
                  type: 'heading',
                  props: { text: 'Een reis met karakter', level: 2 },
                },
                // Gouden divider onder de titel (acceptance #2).
                {
                  id: 'div-gold',
                  type: 'divider',
                  props: {
                    orientation: 'horizontal',
                    length: 80,
                    thickness: 2,
                    color: '#d4af37',
                    style: 'solid',
                    align: 'start',
                    spacing: 12,
                  },
                },
                {
                  id: 'sec-intro-text',
                  type: 'text',
                  props: { text: 'Handgemaakte routes en verblijven.' },
                },
              ],
            },
            // Section met een half-ronde 4:3 foto (acceptance #4) + badge
            // + button-zonder-link (moet als span renderen).
            {
              id: 'sec-highlights',
              type: 'section',
              props: { paddingY: 32 },
              children: [
                {
                  id: 'badge-offerte',
                  type: 'badge',
                  props: {
                    text: 'Offerte 992375',
                    color: '#4f46e5',
                    variant: 'subtle',
                  },
                },
                {
                  id: 'btn-visual',
                  type: 'button',
                  props: {
                    text: 'Aanbevolen',
                    // Geen href → moet als span renderen, geen <a>.
                    color: '#4f46e5',
                    variant: 'solid',
                  },
                },
                {
                  id: 'img-portugal',
                  type: 'image',
                  props: {
                    src: 'https://images.example.com/algarve.jpg',
                    aspectRatio: '4:3',
                    objectFit: 'cover',
                    maskPreset: 'half-rounded-right',
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

describe('renderer — composition test', () => {
  const doc = makeDoc();
  const html = renderToStaticMarkup(
    renderTarget('web', doc, {
      registry,
      dataModel: SAMPLE_DATA_VARIANTS.luxury,
    }) as React.ReactElement,
  );

  it('rendert zonder errors', () => {
    expect(html).toBeTruthy();
    expect(html).not.toMatch(/Onbekend node-type/);
  });

  it('hero: donkere overlay met opgegeven opacity', () => {
    // overlayColor=#000000, overlayOpacity=0.55 → we verwachten
    // background:#000000 en opacity:0.55 op het overlay-element.
    expect(html).toMatch(/background:#000000/);
    expect(html).toMatch(/opacity:0\.55/);
  });

  it('section: lichtbeige achtergrond aanwezig', () => {
    expect(html).toMatch(/background-color:#f5efe6/);
  });

  it('divider: gouden streepje 80px 2px solid', () => {
    // Nog goud + 2px in de output.
    expect(html).toMatch(/#d4af37/);
    expect(html).toMatch(/2px solid/);
    expect(html).toMatch(/width:80px/);
  });

  it('image: aspect-ratio 4:3 + half-rounded-right radius', () => {
    // aspect-ratio in inline-style.
    expect(html).toMatch(/aspect-ratio:4 \/ 3/);
    // half-rounded-right → 0 999px 999px 0
    expect(html).toMatch(/border-radius:0 999px 999px 0/);
  });

  it('badge: rendert als span met subtle-variant', () => {
    expect(html).toMatch(/<span[^>]*>Offerte 992375<\/span>/);
  });

  it('button zonder href: rendert als span, NIET als <a>', () => {
    // Zoek de "Aanbevolen"-tekst; die mag alleen in een span zitten.
    const aTagRegex = /<a[^>]*>[^<]*Aanbevolen/;
    const spanRegex = /<span[^>]*>Aanbevolen<\/span>/;
    expect(html).not.toMatch(aTagRegex);
    expect(html).toMatch(spanRegex);
  });
});
