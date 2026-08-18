# Studio4 Content Gateway — v1 spec

**Status**: draft, contract-first. TravelBridgeAI-repo implementeert
endpoints; Design4-repo consumeert via `StudioContentGatewayAdapter`.

**Doel**: Design4 heeft géén Travel Compositor API-keys, géén directe DB-
toegang tot TravelBridgeAI, géén ruwe TC-response. Alle content wordt door
Studio4 (TravelBridgeAI) gesanitiseerd naar het canonical `TravelContent v1`-
schema (uit `@design4/travel-content`), en per klant/rol geautoriseerd.

**Locatie endpoints**: TravelBridgeAI Netlify Functions
(`/api/content/*` via `netlify/functions/content-*.ts`).

**Auth**: Design4-frontend stuurt user-JWT als Bearer; gateway verifieert met
Studio4-Supabase (`verifyAuthWithRole`, zelfde patroon als bestaande
`/api/pexels/search` etc.). Rate-limit per user + org.

**Security-invarianten** (harde regels):
- Response bevat NOOIT `raw_tc_data`, klant-/boekingsgegevens,
  leverancierscredentials, of tenant-only-velden.
- Response bevat NOOIT TC API-keys of interne DB primary-keys.
- Response conformt strict aan `TravelContent v1` — Zod-parse als eind-gate.
- Media-URLs komen uit de fotoprioriteit-volgorde:
  1. originele reisfoto's (TC hotel/destination images, geuploade brand-
     media in Supabase Storage)
  2. Studio4-beeldbank / merkfoto's
  3. Pexels/Unsplash fallback via query
- Gegenereerde components mogen deze endpoints niet zelf aanroepen — de
  Design4-preview-host of Studio4-runtime levert content, brand en assets
  als props.

---

## Endpoints

### `POST /api/content/travels/search`

Zoek reizen op ID, titel, of bestemming. Voor de "Reis-inhoud"-dropdown in
Design4 SimpleView, en voor UI-picker in Studio4.

**Request**:
```json
{
  "query": "safari",          // free-text OR
  "tc_id": "54545455",        // exacte TC-record-ID OR
  "destination": "Mauritius", // exacte destination-naam
  "limit": 20                  // optioneel, default 20, max 50
}
```

**Response 200**:
```json
{
  "ok": true,
  "results": [
    {
      "source_kind": "travel_compositor",
      "source_id": "54545455",
      "title": "Safari Zuid-Afrika & strand Mauritius",
      "days": 14,
      "countries": ["Zuid-Afrika", "Mauritius"],
      "destinations_preview": ["Johannesburg", "Kruger", "Mauritius"],
      "thumbnail_url": "https://tr2storage.blob.core.windows.net/...jpg",
      "updated_at": "2026-08-01T10:00:00Z"
    }
  ],
  "total": 1
}
```

Alleen preview-velden. Volledige content via `/api/content/travels/:id`.

**Errors**:
- `401 unauthorized` — geen valide JWT
- `403 forbidden` — user's rol staat geen content-toegang toe
- `429 rate_limited` — > 30 requests/60s per user

---

### `GET /api/content/travels/:source_id`

Volledige `TravelContent v1` van één reis. Gemapt uit TC-raw, HTML-gestript,
IDs gesanitiseerd.

**Path params**:
- `source_id`: TC-record-ID (regex `[a-zA-Z0-9_-]{1,64}`)

**Response 200** — exact `TravelContent v1` shape:
```json
{
  "ok": true,
  "content": {
    "schema_version": "1.0",
    "title": "Safari Zuid-Afrika & strand Mauritius",
    "intro": "...",
    "days": 14,
    "nights": 13,
    "countries": ["Zuid-Afrika", "Mauritius"],
    "destinations": [
      { "name": "Johannesburg", "country": "Zuid-Afrika", "from_day": 1, "to_day": 2, "description": "..." }
    ],
    "hotels": [
      { "day": 1, "city": "Johannesburg", "name": "Airport Transit Lodge", "nights": 1, "category": "S3" }
    ],
    "hero_image_hint": "safari elephant sunset",
    "meta": {
      "source_kind": "travel_compositor",
      "source_id": "54545455",
      "version": "1.0",
      "hash": "<sha-256-hex>",
      "fetched_at": "2026-08-18T10:15:00Z"
    }
  }
}
```

Design4-side: Zod-parse tegen `TravelContentSchema` uit
`@design4/travel-content`. Faalt de parse → weiger content.

**Errors**:
- `404 not_found` — TC-ID bestaat niet of user's org heeft geen toegang
- `502 upstream_error` — TC-API down / timeout
- `503 map_failed` — TC-response kan niet naar TravelContent gemapt (schema-
  drift; alert-worthy)

---

### `GET /api/content/brand`

Brand/design-context voor de huidige user's organisatie.

**Response 200**:
```json
{
  "ok": true,
  "brand": {
    "id": "brand_uuid",
    "name": "Rondreis Planner",
    "logo_url": "https://tr2storage.blob.core.windows.net/.../logo.png",
    "primary_color": "#c8672a",
    "secondary_color": "#1a0f08",
    "tagline": "Onvergetelijke rondreizen",
    "font_hint": "Inter"
  }
}
```

Design4 gebruikt dit voor AI-prompt-hints (primaryColor, tagline) en later
voor render-tijd brand-injectie in preview.

Alleen publieke/branding-velden. Geen contact-details, geen financiële info.

---

### `POST /api/content/media/search`

Zoek toegestane media (originele reisfoto's, brand-media, of fallback stock).
Vervangt op termijn Design4's directe Unsplash/Pexels-integratie in
`media-search` Edge Function.

**Request**:
```json
{
  "query": "safari sunset kruger elephants",
  "prefer_source": "original",  // "original" | "brand" | "stock" (default: try in order)
  "context": { "travel_id": "54545455", "orientation": "landscape" }
}
```

**Response 200** — zelfde shape als huidige Design4 media-search:
```json
{
  "ok": true,
  "url": "https://tr2storage.blob.core.windows.net/media/safari-elephant-1.jpg",
  "thumb": "https://tr2storage.blob.core.windows.net/media/safari-elephant-1-thumb.jpg",
  "alt": "Olifanten bij zonsondergang in Kruger National Park",
  "source": "original",
  "photographer": { "name": "TravelBridgeAI content team" }
}
```

Fotoprioriteit-volgorde in de gateway:
1. TC hotel/destination images gekoppeld aan `context.travel_id` (indien gegeven)
2. Brand-eigen media library
3. Pexels/Unsplash met query (fallback)

---

## Auth-model

Design4-frontend heeft een user-JWT van Design4-Supabase (`ltzzxjrn...`).
TravelBridgeAI heeft eigen Supabase (`studio4.travel`). Voor de gateway
gaan we ervanuit dat **dezelfde user in beide auth-projecten bestaat** met
dezelfde `id` — user_provisioning outside scope. Als user niet in TB4-Supabase
staat: 401.

**Flow**:
1. Design4-Edge-Function (`resolve-content-source` extra kind:
   `studio4_content`) haalt user-JWT uit incoming request.
2. Roept gateway aan met `Authorization: Bearer <user-jwt>`.
3. Gateway roept Studio4-Supabase `/auth/v1/user` aan met dezelfde JWT.
4. Als OK: gateway leest `user.user_metadata.role` + org, doet rol-check.

**Roles die toegang krijgen**: `agent`, `admin`, `brand`, `franchise`,
`operator`, `travelxl`, `reisonderneming` (matcht bestaande
`AI_MEDIA_ALLOWED_ROLES` uit TB4).

**Alternatief bij divergerende auth-modellen**: shared service-secret
tussen Design4-backend en gateway; Design4 stuurt `Bearer <secret>` +
body `{user_id, org_id}`. Gateway vertrouwt Design4 op basis van secret,
doet zelf RLS-check. Overwegen als user-migration te complex is.

---

## Implementation-skeleton (TravelBridgeAI-side)

Bij ieder endpoint (Netlify Function):

```typescript
// netlify/functions/content-travels-search.ts
import { verifyAuthWithRole } from './lib/verify-auth';
import { SimpleRateLimiter } from './lib/rate-limit';
import { mapTcToTravelContentPreview } from './lib/tc-map';

const ALLOWED_ROLES = ['agent', 'admin', 'brand', 'franchise', 'operator', 'travelxl', 'reisonderneming'];
const rateLimiter = new SimpleRateLimiter({ maxRequests: 30, windowSec: 60 });

export default async (req: Request): Promise<Response> => {
  const auth = await verifyAuthWithRole(req, ALLOWED_ROLES);
  if ('error' in auth) return jsonError(auth.status, auth.error);

  const rate = rateLimiter.check(auth.user.id);
  if (!rate.ok) return jsonError(429, 'rate_limited');

  const body = await req.json();
  const results = await searchTcTravels({
    query: body.query,
    tc_id: body.tc_id,
    destination: body.destination,
    org_id: auth.user.org_id,       // scoping!
    limit: Math.min(body.limit ?? 20, 50),
  });

  // Sanitiseer: filter tenant-only velden, strip HTML, ...
  const safe = results.map(mapTcToTravelContentPreview);

  return json({ ok: true, results: safe, total: safe.length });
};

export const config = { path: '/api/content/travels/search' };
```

`tc-map.ts` doet de TC-raw → TravelContent-mapping. Zorg dat je géén raw
TC-object doorgeeft aan de response — alleen expliciet gepickte velden.

---

## Design4-side integratie (Fase 2)

Design4-repo krijgt:

1. **`packages/travel-content/src/studio4-gateway-adapter.ts`** — nieuwe
   `ContentSourceAdapter` (kind: `studio4_content`). HTTP-fetch tegen gateway
   met user-JWT doorgestuurd.
2. **`supabase/functions/resolve-content-source`** — nieuwe branch voor
   `kind === 'studio4_content'`: gooi door naar gateway, parse response
   tegen `TravelContentSchema`, upsert in `content_sources`-tabel (zelfde
   patroon als fixture-kind).
3. **SimpleView** — content-source-dropdown krijgt een tweede sectie
   "Mijn reizen (Studio4)" met search-input + resultaten.

**Design4-secrets nodig**:
- `STUDIO4_GATEWAY_URL` — bv. `https://studio4.travel/api/content`
- Geen shared secret vereist als we user-JWT-doorgeef gebruiken.

---

## Acceptatietest (user-spec)

> Voer TC-ID `54545455` in Design4 in → Studio4 gateway herkent de reis →
> Design4 toont titel, bestemmingen, dagen, programma en beschikbare
> beelden → AI maakt ermee een ontwerp zonder enige TC-key of directe
> API-call in Design4.

Verificatiepunten:
- [ ] Design4 heeft geen `TC_API_KEY` env-var
- [ ] Design4 heeft geen import van TC-SDK
- [ ] Design4 heeft geen HTTP-call naar `online.travelcompositor.com`
- [ ] Gegenereerde component code bevat geen fetch-calls naar TC
- [ ] Response van `/api/content/travels/54545455` bevat exact
      `TravelContent v1` shape, Zod-parseable
- [ ] `content_sources`-row heeft `source_kind='studio4_content'`,
      `source_id='54545455'`, gevulde `hash`

---

## Volgorde uitvoering

1. **Fase 1a (deze push, Design4-side)**: `StudioContentGatewayAdapter` in
   `@design4/travel-content` met mock-implementatie voor lokaal + fetch-
   implementatie voor productie. `resolve-content-source` accepteert kind
   `studio4_content`. UI-dropdown krijgt "Studio4-reis"-sectie (nog niet
   functioneel — wacht op TB4-endpoints).
2. **Fase 1b (parallel, TravelBridgeAI-repo)**: 4 endpoints
   implementeren volgens deze spec. Kan mock-data teruggeven als TC-
   integratie nog niet af is.
3. **Fase 1c (integratie)**: TB4-endpoints live → Design4-secrets zetten
   (`STUDIO4_GATEWAY_URL`) → acceptatietest.
4. **Later**: Design4 haalt eigen Unsplash/Pexels-keys weg zodra
   `/api/content/media/search` alle media-behoeftes dekt.
