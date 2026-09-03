# Roadmap — design4.travel

Volgorde is een richting, geen commitment. Wordt bijgesteld op basis van designpartner-feedback.

**Laatste update:** 2026-09-03.

---

## Legenda

Onderdelen zijn gecategoriseerd op basis van hun **echte** stand, niet alleen "staat in main":

- ✅ **Gebouwd in main** — code is gemerged in `main`, tests groen
- 🚀 **Deployed & getest** — draait in productie, handmatig verifieerbaar op live URL
- 🟡 **Gedeeltelijk** — deels gebouwd; hoofd-pad werkt, maar één of meer expliciete gaps
- ⬜ **Nog te bouwen** — nog niet in main

Voor de meeste "gebouwd in main"-onderdelen is de deploy-status **nog niet geverifieerd** — dat is een aparte code-versus-live audit (zie [`docs/audit.md`](audit.md), nog te schrijven). Zolang die audit niet is uitgevoerd, betekent ✅ uitdrukkelijk: *bestaat in de codebase*, niet *werkt in productie*.

---

## v0.1.0 — applicatieshell (afgesloten)

Werkende basis, minimum-viable-experience.

- ✅ Monorepo (npm workspaces) met packages + `apps/app`
- ✅ Typed JSON design-doc met project-metadata, pagina's, per-output-overrides, Zod-validatie
- ✅ Built-in typed nodes (layout-row, layout-column, heading, text, image, hero, cta, …), elk met eigen Zod-schema
- ✅ Renderer-package met `TargetAdapter`-interface; web-target werkend, `pdf`/`image` throwen `NotImplementedError`
- ✅ Chat-pane links + preview-iframe rechts, getypeerd postMessage-protocol
- ✅ Deterministische mock-AI met zes prompt-patronen (geen network)
- ✅ Autosave via localStorage-implementatie van `PersistenceAdapter`
- ✅ Undo/redo op document-niveau, element-selectie → context-chip in chat
- ✅ Viewport-toggle + sample-data-variant-switcher
- ✅ Build + typecheck + 49 tests groen

---

## Wat er sinds v0.1.0 is bijgekomen (in main, deploy-status nog te auditen)

### AI & chat

- ✅ Echte Claude-integratie via Supabase Edge Function `generate-patch` (Sonnet-orchestrator + Opus-delegate)
- ✅ Streaming chat — live-feed van tool_use + text-delta via Anthropic SSE
- ✅ Vibe-coding upgrade: multi-turn conversatie + page-ops + proactieve system prompt
- ✅ Anti-hallucination guard rails (poisoned-history bescherming, expliciete doc-summary, empty-response fallback, future-tense = tool_use dwang)
- ✅ AI-edit-feedback reflecteert daadwerkelijk toegepaste wijzigingen (PR #4)

### Opslag, auth, versies

- ✅ Supabase-client + magic-link auth gate (PR #3)
- ✅ `SupabasePersistenceAdapter` en `SupabaseVersionHistoryAdapter` (stuk 2b)
- ✅ Documentversie-historie + rollback UI (PR #2, PR #1: `rollback-document` Edge Function)
- ✅ Multi-project + multi-document backend (migraties t/m `0017_create_project_with_first_document.sql`)
- ✅ Multi-project frontend (router + workspace + dashboard)
- ✅ AI-call-metrics-tabel (`0013_ai_call_metrics.sql`)

### Studio4 Content Gateway + travel-content

- ✅ `packages/travel-content/` met `FixtureContentSourceAdapter` + `StudioContentGatewayAdapter` + `searchStudioTravels`
- ✅ `resolve-content-source` Edge Function (fixtures embedded, PostgREST upsert-fix)
- ✅ Migratie `0022_content_sources.sql` (tabel + RLS)
- ✅ Studio4 Content Gateway v1 spec (`docs/studio4-content-gateway.md`)
- ✅ UI-input voor Studio4-reis-URL in Design4

### Sandbox & security

- ✅ `sandbox-build-trigger` + `sandbox-callback` Edge Functions
- ✅ `generate-studio4-component` Edge Function (AI-componentgenerator)
- ✅ E2B sandbox-pipeline (prepare/build/capture, elk <150s IDLE_TIMEOUT), 1GB swap-fix voor Chromium
- ✅ Canonical AST-validator als HTTP-gate (`validate-package` Netlify Function op `previewdesign4.netlify.app`)
- ✅ Sandbox-runs-tabel + stale-cleanup (`0018_sandbox_runs.sql`, `0020_sandbox_runs_stale_cleanup.sql`)

### Design references & assets

- ✅ Design-references bucket + policies (`0019_design_references_bucket_policies.sql`)
- ✅ Design-templates (`0021_design_templates.sql`)
- ✅ `media-search` Edge Function (Unsplash + Pexels + picsum-fallback)
- ✅ Image-token pipeline met asset-manifest gate (canonical valideert wat sandbox bouwt)
- ✅ `visual-compare` Edge Function (render-and-compare)
- ✅ `packages/studio4-preview-host/` — runtime + security-validator (`previewdesign4.netlify.app`)
- ✅ `packages/studio4-sdk/` (canonical AST-validator + fixture-integratie)

### Design-primitives foundation

- ✅ `BoxStyle` + 6 primitives + capability-ladder (branch merged in main)

**Tests:** 177 passing in 20 files (peildatum 2026-09-03).

---

## 🟡 v0.2 — "Van echte reis naar echt ontwerp" (focus vóór alles anders)

**Doel:** bewijzen dat de kern werkt end-to-end. Studio4/TC-reis → Design4 → automatisch goed eerste ontwerp → gebruiker praat met AI → AI kent de reis → foto's/content kloppen → opslaan → versie terugzetten.

**Concrete gap** (blocker voor v0.2):

- ⬜ **`contentSourceId` in `DesignDocSchema`.** De `travel-content`-package, de `resolve-content-source` Edge Function en migratie `0022_content_sources.sql` staan er, maar het design-document zelf heeft geen veld dat naar zijn content-bron verwijst. Zie `packages/design-doc/src/schema.ts` regels 66-89 — `ProjectMeta` heeft alleen `documentType`, `title`, `brandId`.
- ⬜ **TravelContent → eerste ontwerp.** Bij het aanmaken van een document uit een reis moet de opgehaalde `TravelContent` het initiële blok-plaatsen voeden (niet alleen een lege mock-page).
- ⬜ **Content-context naar `generate-patch`.** De AI-Edge-Function moet de resolved TravelContent meekrijgen als context, zodat instructies als "zet het hotel in de tweede nacht bovenaan" begrepen worden.
- ⬜ **Bron behouden tijdens vervolg-edits.** `contentSourceId` mag niet weglekken bij document-updates.
- ⬜ **End-to-end proof:** één echte Travel Compositor-reis via Studio4 door de hele flow.

**Voorwaarde vooraf:**

- 🟡 **Code-versus-live audit.** Verifieer welke Edge Functions daadwerkelijk gedeployed zijn, welke secrets ingesteld staan, en of `previewdesign4.netlify.app` + `resolve-content-source` productioneel werken. Zonder dat weten we niet welke ✅ hierboven écht 🚀 is. (Ook: opruimen van artifact-directory `supabase/functions/create-project-document;C/`.)

---

## Kandidaat-fasen na v0.2 (geen vaste volgorde)

Volgorde en scope hangen af van v0.2-uitkomst en designpartner-signaal.

### Publish naar Studio4

- Nieuwe `packages/publish/` met `PublishAdapter`-interface
- Studio4 Template-API-adapter (design als component in brand-bibliotheek)
- Entitlement-webhook-ontvanger (subscription-status, credits-limiet, terms-versie)

### Meer uitvoerformaten

- PDF-target (engine-keuze open: Puppeteer / react-pdf / anders)
- Image-target voor social-formats
- Per-node component-varianten voor uitvoerformaten die anders renderen
- Per-target validatie tijdens design, niet pas bij publish

### Bredere Compose-catalogus

Uitbreidingen richting complete pagina's en documenten. Volgorde te bepalen op basis van designpartner-feedback. Kandidaat-nodes:

- Dagprogramma-blok (`day.*`), activiteit-blok, bestemming-blok
- Prijs/offerteblok met bereken-logica
- Facilities, gallery, map
- Composities (meerdere componenten in één design-doc → volledige secties)
- Volledige pagina's (header/footer/navigatie) en volledige documenten (offerte-PDF, roadbook-PDF, brochure)
- Marketing-uitingen (social-formats, e-mailtemplates)
- Complete thema's

### Leveranciers-integratielaag uitbreiden

Server-side laag in `apps/api` (nog niet gebouwd) die reisdata uit **Travel Compositor**, **Qenner**, **NextPax** normaliseert naar het `Studio4Model`. Vandaag loopt dit deels via Studio4 zelf als upstream; als Design4 direct met bronnen wil praten komt hier de scheiding.

### Develop mode publiek

Vandaag: `generate-studio4-component` + sandbox-pipeline werken achter admin-flag. Publieke beschikbaarheid vereist review-gate voor promotie naar `NodeDefinition` met `source: 'custom'`, en governance-model.

### Governance & schaalslagen

- Governance-laag (approval, gedeelde brand-library, netwerk-templates voor TravelXL/franchise)
- Tool-use AI-pattern (`get_schema`, `preview_with_sample_data`, `register_component`) ter vervanging van statische injectie
- Marketplace / templates-uitwisseling tussen agents
- Marketing-site (`apps/site/`)

---

## Randvoorwaarden per kandidaat-fase

- Elke uitbreiding respecteert de architectuur-principes in `docs/architecture.md`.
- Geen API-key of secret in de frontend, ooit.
- Leveranciers-integraties (TC, Qenner, NextPax, Studio4-data) lopen altijd via de server-side laag; ruwe vendor-responses komen nooit in frontend of design-doc.
- Uitbreidingspunten (interfaces) worden pas als code gerealiseerd zodra de eerste concrete use-case er is — niet vooraf als lege stubs.
- Elke technische keuze die het productgedrag raakt (prijzing, doelgroep, publish-strategie, PDF-engine, sandbox-tech, persistence-backend) is voorlopig tot een designpartner- of business-signaal het bevestigt.

## Uitbreidbaarheid — architectuuruitgangspunt

Design4Travel is ontworpen om later via losse adapters/renderers te worden uitgebreid met onder andere WordPress-pagina's, Studio4-templates, HTML- en HTML5-banners, en andere toekomstige documenttypes en publicatiedoelen. **Documenttype** (bv. `website`/`offerte`/`banner`), **uitvoerformaat** (bv. `web`/`pdf`/`image`/`html5-embed`) en **publicatiedoel** (bv. WordPress-REST, Studio4-Template-API, ad-server-upload) blijven bewust drie afzonderlijke concepten: één documenttype kan naar meerdere uitvoerformaten renderen, en één uitvoerformaat kan naar meerdere publicatiedoelen gepushed worden. Nieuwe documenttypes komen via een `chk_document_type`-CHECK-uitbreidingsmigration; nieuwe uitvoerformaten via extra `TargetAdapter`-implementaties in `packages/renderer/`; nieuwe publicatiedoelen via `PublishAdapter`-implementaties (nog te bouwen zodra de eerste concrete use-case er is, per het uitbreidingspunt-principe hierboven). Datamodel en RLS-model uit Blok A1 blokkeren deze uitbreidingen niet.

## Internationalisatie & lokalisatie — architectuuruitgangspunt

Design4Travel is bedoeld voor internationaal gebruik. Travel Compositor is wereldwijd; toekomstige koppelingen kunnen o.a. Facilitravel en Nezasa omvatten. Het platform mag niet worden ontworpen rond alleen Nederland of alleen Nederlands. **Documenttype**, **uitvoerformaat**, **publicatiedoel**, **taal** en **markt** blijven vijf afzonderlijke concepten die onafhankelijk combineerbaar zijn (bv. `offerte` → `pdf` → e-mail-attachment → `de-DE` → markt `DE`). Concreet uitgangspunt:

1. **UI-taal per gebruiker.** UI-teksten leven in locale/i18n-bestanden, nooit hardcoded in componenten. Elke gebruiker kiest een eigen interfacetaal; opslag via een additieve `profiles.preferred_locale`-kolom zodra de eerste taal-switcher gebouwd wordt.
2. **Content-vertalingen per document.** Één project kan meerdere taalversies hebben, elk met eigen versie-tracking en goedkeuringsstatus. Brontekst, machinevertaling en handmatig gecorrigeerde vertaling zijn onderscheidbaar (bv. via een `translation_source`-veld `original`/`machine`/`human`). Dezelfde content moet per taal naar elk uitvoerformaat renderen.
3. **Markt ≠ taal.** Locale-tags in BCP-47-vorm (`nl-NL`, `nl-BE`, `de-DE`, `en-GB`, `en-US`). Valuta, decimaalscheiding, datum-/tijdformaat, meeteenheden en telefoonformaten volgen de markt, niet de taal. Toekomstige RTL-ondersteuning (`ar`, `he`) meenemen in typografische keuzes.
4. **Providers via adapters.** Provider-content uit Travel Compositor, Facilitravel, Nezasa en volgende providers wordt server-side genormaliseerd naar het `Studio4Model`; oorspronkelijke taal en providermetadata blijven bewaard in `document_data_snapshots.locale` en `.provenance`. Provider-specifieke taalvelden bepalen nooit rechtstreeks de centrale contentstructuur.
5. **Publicatie per taal en markt.** WordPress-pagina's, Studio4-templates, banners en andere exports worden per taal/markt-combinatie gerenderd en gepubliceerd; de toekomstige `PublishAdapter` krijgt taal en markt als expliciete parameters, niet impliciet uit de omgeving.

**Impact op Blok A1-datamodel:** één aandachtspunt — `project_documents` heeft `project_id UNIQUE` (1:1 project↔document). Bij implementatie moet gekozen worden tussen (a) vertalingen in een aparte tabel `project_document_translations(project_document_id, locale, doc, …)` waarbij de 1:1-unique blijft en de bron-doc leidend is, of (b) een intra-doc multilingual-structuur binnen `doc jsonb`. Beide zijn additief oplosbaar zonder breaking change aan bestaande tabellen. Verder blokkeert niets uit Blok A1 deze uitbreidingen: `document_data_snapshots.locale` en `.currency` zijn al voorzien, `provenance jsonb` bewaart provider-origineel, en RLS erft trivialiter via `is_active_org_member(organization_id)`.

### Voorkeursrichting (vastgelegd, nu nog niet bouwen)

1. **Meertalige documenten volgen optie A.** `project_documents` blijft het centrale/masterdocument; vertalingen komen later in een afzonderlijke tabel (`project_document_translations` of vergelijkbaar) waarin versiebeheer, status en goedkeuring **per taal/locale** worden bijgehouden. **Sla meertalige teksten niet structureel als `{locale: text}` op in iedere doc-json-node** — die vorm (optie B) verspreidt taal-state door de hele boom en maakt per-taal-versiebeheer/-approval onhanteerbaar. Als een specifieke node uitzonderlijk taal-agnostisch is (bv. een `image src`), dan blijft die één keer in de master; vertalingen betreffen tekstinhoud, niet layout.
2. **Nu geen implementatie.** Geen translation-tabellen, geen migraties, geen wijzigingen aan bestaande documentstructuren. Dit dient uitsluitend om te voorkomen dat een toekomstige implementatie optie A en B onbewust door elkaar gebruikt.
3. **Vier concepten afzonderlijk houden:** **language** (bv. `de`), **locale** (bv. `de-DE`, BCP-47), **market** (bv. `DE`, ISO 3166-1 alpha-2), **currency** (bv. `EUR`, ISO 4217). Nooit één veld dat er meerdere impliciet in codeert. Adapters en renderers accepteren deze als aparte parameters.
4. **`profiles.preferred_locale` krijgt géén hardcoded default `en-US`.** Bij ontbreken erven gebruikers de organisatie- of markt-standaard; `preferred_locale` is uitsluitend een persoonlijke override. De exacte fallback-volgorde (user → org-default → market-default → platform-default) wordt in de i18n-implementatiefase vastgelegd, niet nu.
