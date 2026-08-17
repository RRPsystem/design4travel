import { z } from 'zod';

/**
 * TravelContent v1.0 — het uniforme, gesanitiseerde schema waar iedere
 * content-bron (fixture / travel_compositor / studio4_content / manual) naar
 * mapt. Dit is wat AI, sandbox en componenten mogen zien.
 *
 * KRITIEKE VEILIGHEIDSREGELS (checked door adapter, hier gedocumenteerd):
 *   - Geen ruwe TravelCompositor-record-IDs of interne DB-primary-keys.
 *   - Geen API-keys, geen credentials, geen partner-tarieven of tenant-only-velden.
 *   - Geen HTML — alle rich-text-velden zijn plain-text summaries.
 *   - Geen willekeurige extra velden — Zod's `.strict()` wijst onbekende
 *     top-level velden af zodat er niets stiekem meesnappt uit de bron.
 *
 * De adapter is verantwoordelijk voor: raw → deze shape + hashing. Consumer
 * hoeft alleen `parse()` te doen om te weten dat de content veilig is.
 */

export const TravelSourceKindSchema = z.enum([
  'fixture',
  'travel_compositor',
  'studio4_content',
  'manual',
]);
export type TravelSourceKind = z.infer<typeof TravelSourceKindSchema>;

const DestinationSchema = z.object({
  name: z.string().min(1).max(120),
  country: z.string().min(1).max(120),
  from_day: z.number().int().nonnegative().optional(),
  to_day: z.number().int().nonnegative().optional(),
  description: z.string().max(2000).optional(),
  highlights: z.array(z.string().max(200)).max(20).optional(),
}).strict();

const HotelSchema = z.object({
  day: z.number().int().nonnegative(),
  city: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  nights: z.number().int().positive(),
  category: z.string().max(40).optional(),
  room_type: z.string().max(200).optional(),
  meal_plan: z.string().max(80).optional(),
  short_description: z.string().max(1000).optional(),
  price_per_night: z.number().nonnegative().optional(),
}).strict();

const PriceSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  per: z.enum(['person', 'total']),
}).strict();

const MetaSchema = z.object({
  source_kind: TravelSourceKindSchema,
  source_id: z.string().max(200).optional(),
  version: z.string().max(80).optional(),
  hash: z.string().length(64).optional(), // sha-256 hex
}).strict();

export const TravelContentSchema = z.object({
  schema_version: z.literal('1.0'),
  title: z.string().min(1).max(240),
  subtitle: z.string().max(400).optional(),
  intro: z.string().max(2000).optional(),
  days: z.number().int().positive(),
  nights: z.number().int().nonnegative().optional(),
  countries: z.array(z.string().min(1).max(120)).min(1).max(10),
  price: PriceSchema.optional(),
  destinations: z.array(DestinationSchema).min(1).max(30),
  hotels: z.array(HotelSchema).max(30).optional(),
  hero_image_hint: z.string().min(1).max(200).optional(),
  meta: MetaSchema,
}).strict();

export type TravelContent = z.infer<typeof TravelContentSchema>;
export type TravelDestination = z.infer<typeof DestinationSchema>;
export type TravelHotel = z.infer<typeof HotelSchema>;
