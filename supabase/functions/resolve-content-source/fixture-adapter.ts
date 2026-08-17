/**
 * Deno inline kopie van packages/travel-content/src/fixture-adapter.ts.
 * Sync met canonical bij elke wijziging.
 *
 * FIXTURES worden hier gebundeld als embedded JSON-string in FIXTURES_MAP.
 * Deno Edge Functions kunnen geen filesystem raad hebben over de
 * project-root; embedden is de simpelste weg. Later kunnen we ze naar een
 * Supabase Storage bucket verhuizen.
 */

import { TravelContentSchema, type TravelContent } from './schema.ts';

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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

async function sha256Hex(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(stableStringify(value));
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

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

export interface ResolveResult {
  content: TravelContent;
  hash: string;
  version: string;
}

/**
 * Loader-signature — Deno-implementatie krijgt raw fixture-JSON via FIXTURES_MAP
 * embedded, of via Supabase Storage bucket (toekomst).
 */
export type FixtureLoader = (slug: string) => Promise<string | null>;

export async function resolveFixture(
  slug: string,
  loader: FixtureLoader,
): Promise<ResolveResult> {
  const raw = await loader(slug);
  if (!raw) throw new Error(`fixture_not_found:${slug}`);

  let parsed: RawTravelFixture;
  try {
    parsed = JSON.parse(raw) as RawTravelFixture;
  } catch (e) {
    throw new Error(`fixture_json_invalid:${(e as Error).message}`);
  }

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
  const version = '1.0';

  const content: TravelContent = {
    ...contentWithoutMeta,
    meta: {
      source_kind: 'fixture',
      source_id: slug,
      version,
      hash,
    },
  };

  const check = TravelContentSchema.safeParse(content);
  if (!check.success) {
    throw new Error(`fixture_map_schema_violation:${check.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join(';')}`);
  }
  return { content: check.data, hash, version };
}
