# Roadmap — design4.travel

Volgorde is een richting, geen commitment. Wordt bijgesteld op basis van designpartner-feedback.

**Laatste update:** 2026-08-09.

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
