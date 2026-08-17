/**
 * Inline kopie van @design4/travel-content/schema. Deno Edge Functions kunnen
 * geen workspace-packages importeren; deze kopie MOET handmatig gesynchroniseerd
 * blijven met packages/travel-content/src/schema.ts.
 *
 * Bij een wijziging in de canonical → update ook hier + bump schema_version.
 */

import { z } from 'https://esm.sh/zod@3.23.8';

export const TravelSourceKindSchema = z.enum([
  'fixture',
  'travel_compositor',
  'studio4_content',
  'manual',
]);

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
  hash: z.string().length(64).optional(),
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
