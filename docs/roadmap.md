# Roadmap — design4.travel

Volgorde is een richting, geen commitment. Wordt bijgesteld op basis van designpartner-feedback.

**Laatste update:** 2026-08-10.

---

## Fase 1 — applicatieshell (klaar, gemarkeerd als v0.1.0)

Werkende basis, minimum-viable-experience. **v0.1.0 markeert uitsluitend deze fase-1-basis** — het is geen commitment aan een specifieke volgende fase.

- ✅ Monorepo (npm workspaces) met vier packages + één app
- ✅ Typed JSON design-doc met project-metadata (`documentType`), pagina's, per-output-overrides, Zod-validatie
- ✅ Zeven built-in typed nodes (`layout-row`, `layout-column`, `heading`, `text`, `image`, `hero`, `cta`), elk met eigen Zod-schema en bind-slots
- ✅ Losse renderer-package met `TargetAdapter`-interface; web-target werkend, andere formaten throwen expliciete `NotImplementedError`
- ✅ Per-node validatie via de eigen Zod-schema tijdens `resolveProps`, inclusief brand-token-substitutie en bind-resolutie
- ✅ Responsive web-renderer: `clamp()` voor hero-titel, generieke overflow-protectie (`box-sizing`, `overflow-wrap: anywhere`, `min-width: 0`)
- ✅ Data-bindings tegen mock Studio4-model (drie sample-varianten)
- ✅ Vite + React app met chat-pane links en preview-iframe rechts
- ✅ Preview-iframe communiceert via getypeerd postMessage-protocol
- ✅ Deterministische mock-AI met zes verplichte prompt-patronen (geen network, geen API-key)
- ✅ Autosave via localStorage-implementatie van centrale `PersistenceAdapter`
- ✅ Undo/redo op document-niveau
- ✅ Element-selectie in canvas → zichtbaar als context-chip in de chat
- ✅ Viewport-toggle (desktop/mobiel) en sample-data-variant-switcher
- ✅ Build, typecheck, lint (0 warnings) en 49 tests groen

---

## Na fase 1 — mogelijke volgende richtingen (nog geen definitieve fasering)

De onderstaande blokken zijn **kandidaat-fasen**, geen vastgelegde volgorde of scope. Welke eerst opgepakt wordt en met welke omvang hangt af van designpartner-signalen, kosten-batenafwegingen en zakelijke prioriteiten. Elke volgende versie krijgt zijn eigen tag (`v0.2.0`, `v0.3.0`, …) op basis van wat daadwerkelijk gebouwd wordt.

### Kandidaat — echte AI-integratie

- Backend-endpoint dat Claude-calls proxy't; **API-key server-side**, nooit in de frontend-bundle
- Vervanger voor `MockAIAdapter` die dezelfde interface implementeert
- Design-session state (chat verwerkt huidige document-state, geen from-scratch redesign)
- Usage-limiet / credit-teller zichtbaar in UI

### Kandidaat — persistente opslag

- Vervanger voor localStorage-adapter tegen een backend-datastore. Kandidaten: Supabase (gedeeld of apart project), of anders. Niet vastgelegd.
- RLS-strategie en multi-user-scoping komen met de keuze mee

### Kandidaat — auth & SSO

- Handoff-endpoint voor eenmalige autorisatiecode vanuit Studio4
- Entitlement-webhook-ontvanger (subscription-status, credits-limiet, terms-versie)
- Read-only fallback bij ingetrokken toegang mid-sessie

### Kandidaat — publish naar Studio4

- Nieuwe `packages/publish/` met `PublishAdapter`-interface
- Studio4 Template-API-adapter: publiceer een design als component in de brand-bibliotheek
- Basis-entitlement-webhooks tussen Studio4 en Design4

### Kandidaat — leveranciers-integratielaag (Studio4-ecosysteem)

Server-side laag in `apps/api` die reisdata uit **Travel Compositor**, **Qenner**, **NextPax** en **interne Studio4-data** normaliseert naar het `Studio4Model` dat design-doc-bindings al gebruiken. Zie [`architecture.md`](architecture.md) → Leveranciers-integratielaag voor de vijf non-negotiable regels (credentials server-side, geen ruwe vendor-responses in frontend, etc.).

### Kandidaat — meer uitvoerformaten

- PDF-target (engine-keuze open: Puppeteer / react-pdf / anders)
- Image-target voor social-formats
- Per-node component-varianten voor uitvoerformaten die anders renderen
- Per-target validatie tijdens design, niet pas bij publish

### Kandidaat — bredere Compose-catalogus

Uitbreidingen aan de typed-nodes-bibliotheek, richting complete pagina's en documenten. Volgorde te bepalen op basis van designpartner-feedback. Kandidaat-nodes:

- Dagprogramma-blok (`day.*` shape), activiteit-blok, bestemming-blok
- Prijs/offerteblok met bereken-logica
- Facilities-blok, gallery, map
- Composities (meerdere componenten in één design-doc → volledige secties)
- Volledige pagina's (layout, header/footer, navigatie) en volledige documenten (offerte-PDF, roadbook-PDF, brochure)
- Marketing-uitingen (social-formats, e-mailtemplates)
- Complete thema's (design-tokens die door alle blokken doorwerken)

### Kandidaat — Develop mode (AI-codegeneratie)

Sandbox voor AI-gegenereerde React/TS-componenten. Vereist eerst technologie-keuze (WebContainer / Sandpack / iframe+CSP+worker), sandboxed preview, build + tests binnen sandbox, en een review-gate voor promotie naar `NodeDefinition` met `source: 'custom'`.

### Kandidaat — governance & schaalslagen

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
