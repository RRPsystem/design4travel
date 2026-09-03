import { describe, expect, it } from 'vitest';
import { DesignDocSchema } from '@design4/design-doc';
import type { TravelContent } from '@design4/travel-content/schema';
import { seedFromTravelContent } from './seedFromTravelContent.js';

const CONTENT_SOURCE_ID = '11111111-2222-4333-8444-555555555555';

function makeTravel(overrides: Partial<TravelContent> = {}): TravelContent {
  return {
    schema_version: '1.0',
    title: 'Safari Zuid-Afrika',
    days: 14,
    countries: ['Zuid-Afrika'],
    destinations: [
      { name: 'Kruger', country: 'Zuid-Afrika', from_day: 3, to_day: 6 },
    ],
    meta: { source_kind: 'fixture', source_id: 'safari-001', version: '1.0' },
    ...overrides,
  } as TravelContent;
}

describe('seedFromTravelContent', () => {
  it('produces a schema-valid DesignDoc with contentSourceId set', () => {
    const doc = seedFromTravelContent({
      travel: makeTravel(),
      contentSourceId: CONTENT_SOURCE_ID,
      documentType: 'website',
      documentTitle: 'Mijn reis',
    });
    const parsed = DesignDocSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    expect(doc.project.contentSourceId).toBe(CONTENT_SOURCE_ID);
    expect(doc.project.title).toBe('Mijn reis');
    expect(doc.project.documentType).toBe('website');
  });

  it('populates hero with title from travel-content', () => {
    const doc = seedFromTravelContent({
      travel: makeTravel({ title: 'Rondreis Marokko' }),
      contentSourceId: CONTENT_SOURCE_ID,
      documentType: 'website',
      documentTitle: 'Marokko',
    });
    const hero = doc.pages[0]!.root.children!.find((c) => c.type === 'hero');
    expect(hero).toBeDefined();
    expect(hero!.props.title).toBe('Rondreis Marokko');
  });

  it('includes destinations section when destinations present', () => {
    const doc = seedFromTravelContent({
      travel: makeTravel({
        destinations: [
          { name: 'Marrakech', country: 'Marokko' },
          { name: 'Fes', country: 'Marokko' },
        ],
      }),
      contentSourceId: CONTENT_SOURCE_ID,
      documentType: 'website',
      documentTitle: 'Marokko',
    });
    const destSection = doc.pages[0]!.root.children!.find((c) => c.id === 'destinations');
    expect(destSection).toBeDefined();
    // 1 heading + 2 destinations = 3 children
    expect(destSection!.children).toHaveLength(3);
  });

  it('includes hotels section only when hotels present', () => {
    const withoutHotels = seedFromTravelContent({
      travel: makeTravel(),
      contentSourceId: CONTENT_SOURCE_ID,
      documentType: 'website',
      documentTitle: 'X',
    });
    expect(withoutHotels.pages[0]!.root.children!.some((c) => c.id === 'hotels')).toBe(false);

    const withHotels = seedFromTravelContent({
      travel: makeTravel({
        hotels: [
          { day: 3, city: 'Kruger', name: 'Lion Sands', nights: 3 },
        ],
      }),
      contentSourceId: CONTENT_SOURCE_ID,
      documentType: 'website',
      documentTitle: 'X',
    });
    expect(withHotels.pages[0]!.root.children!.some((c) => c.id === 'hotels')).toBe(true);
  });

  it('includes price CTA only when price present', () => {
    const withoutPrice = seedFromTravelContent({
      travel: makeTravel(),
      contentSourceId: CONTENT_SOURCE_ID,
      documentType: 'website',
      documentTitle: 'X',
    });
    expect(withoutPrice.pages[0]!.root.children!.some((c) => c.id === 'price-cta')).toBe(false);

    const withPrice = seedFromTravelContent({
      travel: makeTravel({ price: { amount: 4995, currency: 'EUR', per: 'person' } }),
      contentSourceId: CONTENT_SOURCE_ID,
      documentType: 'website',
      documentTitle: 'X',
    });
    const cta = withPrice.pages[0]!.root.children!.find((c) => c.id === 'price-cta');
    expect(cta).toBeDefined();
    expect(cta!.props.text).toBe('Vanaf 4995 EUR');
  });

  it('generates unique node IDs across destinations and hotels', () => {
    const doc = seedFromTravelContent({
      travel: makeTravel({
        destinations: [
          { name: 'A', country: 'X' },
          { name: 'B', country: 'Y' },
        ],
        hotels: [
          { day: 1, city: 'A-city', name: 'Hotel A', nights: 2 },
          { day: 3, city: 'B-city', name: 'Hotel B', nights: 3 },
        ],
      }),
      contentSourceId: CONTENT_SOURCE_ID,
      documentType: 'website',
      documentTitle: 'X',
    });
    // Collect all node ids recursively.
    const ids = new Set<string>();
    function walk(n: { id: string; children?: Array<{ id: string; children?: unknown[] }> }) {
      if (ids.has(n.id)) {
        throw new Error(`duplicate node id: ${n.id}`);
      }
      ids.add(n.id);
      (n.children ?? []).forEach((c) => walk(c as never));
    }
    walk(doc.pages[0]!.root as never);
    expect(ids.size).toBeGreaterThan(0);
  });

  it('renders a fallback subtitle when travel.subtitle is absent', () => {
    const doc = seedFromTravelContent({
      travel: makeTravel({ days: 7, countries: ['Nederland', 'België'] }),
      contentSourceId: CONTENT_SOURCE_ID,
      documentType: 'website',
      documentTitle: 'X',
    });
    const hero = doc.pages[0]!.root.children!.find((c) => c.type === 'hero');
    expect(hero!.props.subtitle).toBe('7 dagen · Nederland · België');
  });
});
