import { ContentSourceError, type ContentSourceAdapter } from './adapter.js';
import { TravelContentSchema, type TravelContent } from './schema.js';
import { sha256Hex } from './hash.js';

/**
 * Raw TC-shape van packages/content-fixtures/travel/*.json. Alleen de velden
 * die de adapter daadwerkelijk gebruikt zijn hier opgenomen — de rest
 * (interne IDs, geolocation, facilities.otherFacilities met TC-icoon-IDs,
 * itinerary-html, etc.) wordt bewust weggegooid.
 */
interface RawTravelFixture {
  title?: string;
  slug?: string;
  description?: string;
  intro_text?: string;
  number_of_days?: number;
  number_of_nights?: number;
  price_per_person?: string | number;
  countries?: string[];
  destinations?: Array<{
    name?: string;
    country?: string;
    fromDay?: number;
    toDay?: number;
    description?: string;
    highlights?: string[];
  }>;
  hotels?: Array<{
    day?: number;
    city?: string;
    name?: string;
    nights?: number;
    category?: string;
    roomType?: string;
    mealPlan?: string;
    shortDescription?: string;
    description?: string;
    pricePerNight?: number;
  }>;
  hero_image?: string;
}

const HTML_TAG = /<[^>]+>/g;
const WHITESPACE_COLLAPSE = /\s+/g;

function stripHtml(s: string | undefined, max = 2000): string | undefined {
  if (!s) return undefined;
  const plain = s.replace(HTML_TAG, ' ').replace(WHITESPACE_COLLAPSE, ' ').trim();
  if (!plain) return undefined;
  return plain.length > max ? plain.slice(0, max - 1) + '…' : plain;
}

function heroHintFromHeroImage(hero: string | undefined): string | undefined {
  if (!hero) return undefined;
  // Bekende fixture-conventie: "pexels://safari-elephant-sunset-hero" →
  // "safari elephant sunset". Strip protocol, sluffix "-hero"/"-1"/enz, en
  // vervang '-' door spatie. Als het al plain-text is: gewoon returnen.
  const withoutProto = hero.replace(/^[a-z]+:\/\//, '');
  return withoutProto
    .replace(/-hero$/i, '')
    .replace(/-\d+$/, '')
    .replace(/-/g, ' ')
    .trim() || undefined;
}

function normalizePrice(raw: unknown): TravelContent['price'] {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return { amount: n, currency: 'EUR', per: 'person' };
}

/**
 * FixtureContentSourceAdapter — leest een travel-fixture uit
 * packages/content-fixtures/travel/, mapt naar het TravelContent-schema en
 * berekent een deterministic hash.
 *
 * loader() is dependency-injected zodat we in Node fs.readFile gebruiken,
 * in Deno Deno.readTextFile, en in tests een in-memory map. Adapter zelf
 * is FS-onafhankelijk.
 */
export class FixtureContentSourceAdapter implements ContentSourceAdapter {
  readonly kind = 'fixture' as const;

  constructor(private readonly loader: (slug: string) => Promise<string | null>) {}

  async resolve(sourceId?: string): Promise<TravelContent> {
    if (!sourceId) {
      throw new ContentSourceError('fixture requires sourceId (slug)', 'fixture_source_id_required');
    }
    const raw = await this.loader(sourceId);
    if (!raw) {
      throw new ContentSourceError(`fixture not found: ${sourceId}`, 'fixture_not_found');
    }
    let parsed: RawTravelFixture;
    try {
      parsed = JSON.parse(raw) as RawTravelFixture;
    } catch (e) {
      throw new ContentSourceError(
        `fixture json parse error: ${(e as Error).message}`,
        'fixture_json_invalid',
      );
    }

    // Map & sanitize
    const destinations = (parsed.destinations ?? [])
      .filter((d) => d.name && d.country)
      .map((d) => ({
        name: d.name!,
        country: d.country!,
        from_day: d.fromDay,
        to_day: d.toDay,
        description: stripHtml(d.description, 1500),
        highlights: d.highlights && d.highlights.length ? d.highlights.slice(0, 20) : undefined,
      }));

    // Dedup destinations op {name,country} — TC-fixtures hebben vaak
    // dezelfde stad meerdere keren voor transitdagen.
    const seenDest = new Set<string>();
    const dedupDestinations = destinations.filter((d) => {
      const k = `${d.name}|${d.country}`;
      if (seenDest.has(k)) return false;
      seenDest.add(k);
      return true;
    });

    const hotels = (parsed.hotels ?? [])
      .filter((h) => h.name && h.city && h.day !== undefined && h.nights !== undefined)
      .map((h) => ({
        day: h.day!,
        city: h.city!,
        name: h.name!,
        nights: h.nights!,
        category: h.category,
        room_type: h.roomType,
        meal_plan: h.mealPlan,
        short_description: stripHtml(h.shortDescription || h.description, 800),
        price_per_night: h.pricePerNight,
      }));

    const countries = parsed.countries && parsed.countries.length
      ? parsed.countries
      : Array.from(new Set(dedupDestinations.map((d) => d.country)));

    const contentWithoutMeta = {
      schema_version: '1.0' as const,
      title: (parsed.title ?? '').trim() || 'Onbenoemd ontwerp',
      subtitle: undefined,
      intro: stripHtml(parsed.intro_text || parsed.description, 1500),
      days: parsed.number_of_days ?? Math.max(...dedupDestinations.map((d) => d.to_day ?? 1), 1),
      nights: parsed.number_of_nights,
      countries,
      price: normalizePrice(parsed.price_per_person),
      destinations: dedupDestinations,
      hotels: hotels.length ? hotels : undefined,
      hero_image_hint: heroHintFromHeroImage(parsed.hero_image),
    };

    const hash = await sha256Hex(contentWithoutMeta);

    const content: TravelContent = {
      ...contentWithoutMeta,
      meta: {
        source_kind: 'fixture',
        source_id: sourceId,
        version: '1.0',
        hash,
      },
    };

    // Final gate: parse tegen Zod-schema zodat elke bron gegarandeerd
    // conform is. Bij nieuwe fixture-shape die niet mapt → throw.
    const result = TravelContentSchema.safeParse(content);
    if (!result.success) {
      throw new ContentSourceError(
        `fixture map produced invalid TravelContent: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
        'fixture_map_schema_violation',
      );
    }
    return result.data;
  }
}
