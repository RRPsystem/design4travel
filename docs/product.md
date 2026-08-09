# Productdefinitie — design4.travel

Deze definitie is de canonical bron. README is samenvatting; `docs/architecture.md` is de technische uitwerking. Bij wijzigingen: update dit document en README parallel.

**Laatste update:** 2026-08-09.

---

## 1. Wat is Design4?

Design4.travel is een AI-native ontwerp- en ontwikkelomgeving voor reisprofessionals. Chat aan de linkerkant, live preview aan de rechterkant. De gebruiker praat met AI en ziet direct wat er gebeurt in de canvas.

Positionering: **v0 (AI-codegeneratie) × Canva (visueel ontwerpen) voor de reisbranche**, met domeinkennis van reisdata en integratie met het Studio4-datamodel.

Design4 is een eigenstandig product in de 4-familie (studio4, roadbook4, camper4). Aparte repo, aparte deploys, aparte subscription.

---

## 2. Wie is de doelgroep?

Primair reisagents die zich onvoldoende bediend voelen door standaardsecties in Studio4 en die zelf willen ontwerpen zonder HTML/CSS te kennen. Twee sub-segmenten (mix nog niet definitief):

- **Bestaande Studio4-agents** — upsell boven bestaande brand-site.
- **Nieuwe leads** — reisondernemers die nu Wix/Squarespace/Framer gebruiken en Studio4-domeinkennis + Design4-vrijheid combineren.

Secundair: interne curators en designpartners die via Develop mode de typed-node-bibliotheek uitbreiden.

---

## 3. Wat kan de gebruiker maken?

Design4 scheidt **documenttype** (wat maak je?) van **uitvoerformaat** (hoe wordt het gerenderd?):

**Documenttypes** (Zod-enum in `DesignDoc.project.documentType`):

- `website` — landingspagina's, marketingpagina's, campagnesites
- `offerte` — reisvoorstellen
- `roadbook` — interactieve reisplannen
- `brochure` — visuele reisproducten (Canva-achtig)
- `social` — marketing- en social-media-uitingen
- `document` — Word-achtige documenten (contracten, informatiepakketten)

**Uitvoerformaten** (renderer-targets):

- `web` — HTML in browser (fase 1)
- `pdf` — PDF-export (fase 4)
- `image` — social-formats en previews (fase 4)
- `docx` — Word-documenten (later)

Één design-doc kan meerdere uitvoerformaten activeren. Een `offerte`-document kan bijvoorbeeld in `web` (preview in de browser) én `pdf` (voor mail) renderen — zonder aparte design-docs.

Plus, cross-cutting:

- Herbruikbare Studio4-componenten (bibliotheek, publiceerbaar naar Studio4)
- Custom React/TypeScript-componenten (via Develop mode, na review-gate)

---

## 4. Twee modi

### Compose mode (default)

De gebruiker ontwerpt door te praten met AI. AI plaatst en configureert **typed nodes** uit de bibliotheek: `card`, `image`, `heading`, `text`, `list`, `facilities`, `price`, `layout-row`, `layout-column`, `hero`, `gallery`, `map`, `day-block`, `activity-block`, `pricing-table`, ... De bibliotheek is uitbreidbaar per fase.

Elke node heeft:

- Een **Zod-schema** — valideert props en levert defaults; centraal geraadpleegd door de renderer
- **Bind-slots** die AI koppelt aan het genormaliseerde Studio4-datamodel
- **Per-uitvoerformaat-overrides** (`web`, `pdf`, `image`) — een blok mag er in PDF iets anders uitzien dan in de web-preview
- **Fallback-gedrag** voor missende data

Compose is de veilige default. Publish direct naar alle actieve uitvoerformaten.

### Develop mode

Wanneer de standaardbibliotheek onvoldoende is, kan AI in Develop mode **nieuwe React/TypeScript-componenten** genereren. Dit gebeurt in een geïsoleerde sandbox:

- **Sandboxed preview** (WebContainer / Sandpack / iframe met CSP + resource-limits)
- **Build & tests** draaien in de sandbox voordat de component gepubliceerd kan worden
- **Review-gate** — een mens (interne curator, brand-admin, of designpartner met scope-recht) reviewt code + preview + testresultaten
- Na review: component wordt **geregistreerd als nieuwe typed node** met schema, bind-slots en scope (per brand of per agent)

Develop mode is **niet publiek beschikbaar in de MVP**. Wordt intern gebruikt om de typed-node-bibliotheek uit te breiden. Publieke beschikbaarheid komt in latere roadmap-fase, mét volledige sandbox + review-gate + governance.

---

## 5. Opslag- en publicatiemodel

**Canonical opslag:** getypeerde JSON design-document, een tree van `type`-nodes met `bind`-slots en per-target overrides. Geen losse HTML/CSS.

**Custom componenten** uit Develop mode registreren zich als **nieuwe node-types** met eigen schema. Vanaf dat moment gebruikt Compose mode ze als elke andere node.

**Publish** loopt via de renderer-laag:

- Naar **Studio4** via interne Template API (websites, offertes, roadbooks, bibliotheek)
- Naar **PDF** via aparte render-engine (kandidaten: Puppeteer, react-pdf; nog te kiezen)
- Naar **embed/link** voor externe hosting van landingspagina's
- Naar **Netlify preview** voor development-review en designpartner-feedback
- Naar **Git** voor custom componenten uit Develop mode (versiebeheer + review-history)

---

## 6. Datamodel-abstractie

Design4-bindings verwijzen NIET direct naar bronveldnamen (TC, WebU, handmatig ingevoerd). In plaats daarvan bindt de renderer tegen een **genormaliseerd Studio4-model**:

- `accommodation.*` (name, stars, images, facilities, price, location, ...)
- `trip.*` (title, days, price, dates, participants, ...)
- `day.*` (date, title, activities, accommodation, transport, ...)
- `activity.*` (title, description, images, duration, ...)
- `destination.*` (name, description, images, coordinates, ...)

Studio4 vertaalt zijn heterogene bronnen naar dit model. Design4-templates blijven zo bron-onafhankelijk en overleven schema-veranderingen aan de bron-kant.

**Design-tokens** (brand-primary, brand-secondary, typografie) komen door als variabelen (`{brand.primary}`). Eén ontwerp neemt automatisch de merkstijl over van de gebruikende brand.

---

## 7. Voorlopige uitgangspunten

Deze staan nog niet vast. Ze worden bevestigd via POC en designpartner-gesprekken.

### Business

- **Subscription verplicht.** Geen gratis tier. Prijspunt nog open (€49 / €199 / €499 hebben totaal andere product-implicaties).
- **Toegangsscopes:** Brand (alle toegestane agents van een brand) of Agent (één specifieke agent).
- **Statussen:** Trial, Active, Suspended (ontwerpen blijven, geen nieuwe AI-generatie), Cancelled (read-only + export gedurende bewaartermijn).
- **Kostenmodel AI-tokens:** credits per tier of soft-cap per maand. Nog niet gekozen.

### Auth & SSO

- **Eenmalige short-lived autorisatiecode** bij handoff vanuit Studio4 (≤60s, single-use, gebonden aan user+brand, direct vernietigd na inwisseling).
- Design4 wisselt in bij `app.design4.travel/auth/handoff` voor een lokale sessie. Geen volledig token in URL, geen dubbele login.
- **Lokale sessievalidatie.** Studio4 wordt geraadpleegd bij: sessiestart, publish, gevoelige acties, periodiek (interval nog te bepalen — ruwe guess: 15 min).
- **Entitlement-webhooks** (Studio4 → Design4) voor: abonnement opgezegd/gesuspend, credits-limiet bereikt, terms-versie geüpdatet, scope-wijziging. Ondertekend + idempotent.
- **Continue autosave + read-only fallback** bij mid-sessie ingetrokken toegang. Geen dataverlies, geen kaal foutscherm.
- **Autorisatie backend-first, altijd.** Frontend-knoppen beveiligen nooit alleen. RLS + edge-function guards.
- **Terms-registratie als JSON-record** per activatie: `{product, scope, brand_id, status, terms_version, accepted_by, accepted_at, billing_model, monthly_limit}`.

### Tech

- **Supabase-project:** MVP-start met hetzelfde project als Studio4, apart schema `design4.*` + strikte RLS. Migratie naar apart project blijft open.
- **AI-schema-toegang:** MVP = statische schema-injectie in system-prompt. V2 = tool-use (`get_schema`, `preview_with_sample_data`, `register_component`) zodra >~30 entity-types.
- **Rendering-primitief:** kleine set typed nodes, uitbreidbaar per fase.
- **Sandbox voor Develop mode:** WebContainer of Sandpack of iframe+CSP (nog te kiezen op basis van performance + isolation-garanties).
- **Frontend framework:** Next.js of Vite+React (te kiezen bij scaffolding van `apps/app`).
- **PDF-engine:** Puppeteer, react-pdf, of anders (nog te kiezen).
- **Deploy:** Netlify.

---

## 8. Wat is expliciet NIET (nu of ooit)

- **Custom raw-CSS-escape-hatch in Compose mode.** Doorbreekt tenant-isolation, breekt renderer per-target validatie, opent support-hell. Alleen custom componenten via Develop mode (met sandbox + review).
- **AI-gegenereerde code publiek zonder review-gate.** Sandbox-escape en cross-tenant risico's zijn te hoog.
- **Direct binden aan bronveldnamen (TC, WebU).** Data-abstractielaag is non-negotiable, anders breekt alles bij elke bron-migratie.
- **Whole-page design op productie-niveau** vóór de fundering staat. Framework mag het toe, kwaliteit-gates zijn er nog niet.
- **"Iframes per blok" of losse HTML/CSS als canonical bron.** Bewezen anti-patroon voor LCP en isolation.

---

## 9. MVP en verticale POC

### Fase 1 — applicatieshell

- Chat-pane links, live preview-pane rechts
- Mock-landingspagina als eerste render-target (bewijst renderer-splitsing + compose-engine op iets substantiëler dan één component)
- Basis typed nodes werkend (`heading`, `text`, `image`, `layout-row`, `layout-column`)
- Design-doc autosave werkend
- Modulaire fundering (packages/design-doc, packages/typed-nodes, packages/renderer)
- Framework-keuze voor `apps/app` bevestigd

### Eerste verticale POC — AI Hotel Card Designer

Een componentontwerper die het volledige stuur van chat tot publish demonstreert, in alle targets (website, offerte, roadbook, PDF). Bewust *één* component om diepte te forceren en de fundering-lagen echt te stresstesten.

Moet aantonen:

- Chat ↔ canvas werkelijk gekoppeld (element-selectie via canvas → context in chat)
- AI kiest data-bindings uit context ("zet de hotelnaam bovenaan" i.p.v. "bind hotel.name")
- Merkstijl-tokens komen automatisch door
- Preview in web (desktop + mobiel), offerte, roadbook, PDF-export
- Preview met meerdere sample-data-varianten (5-sterren, budget-B&B, missing-image-case)
- Fallback-design per binding (leeg `facilities`, geen image, missing price)
- Publish naar Studio4-bibliotheek
- Basale versie-historie + undo op document-niveau
- Continue autosave + read-only fallback bij ingetrokken toegang
- Entitlement-webhook-ontvanger van Studio4
- Design-session state: chat verwerkt huidige document-state
- Usage-limiet zichtbaar voor gebruiker

**Expliciet niet in MVP + eerste POC:**

- Meerdere componenten in één design-doc (compositie)
- Whole-page design op productie-niveau
- Develop mode publiek
- Governance/approval-flow
- Marketplace / delen tussen agents
- Custom CSS-escape-hatch in Compose
- Tool-use AI-pattern (nog statische injectie)

---

## 10. Validatie tijdens de bouw

We wachten niet tot alle designpartners rond zijn voordat we bouwen. Een lichte, werkende prototype-interface is juist een middel om betere discovery-gesprekken te voeren: "kijk, dit kan je hier al doen — wat mis je?" is een sterker signaal dan een pitch.

**Uitgangspunten:**

- Ontwerp architectuur vanaf dag 1 voor complete pagina's en documenten, ook al levert de eerste POC één component
- Investeer in fundering vóór in features per output-type
- Iteratief per target: eerst één werkend, dan de volgende
- Zodra prototype-shell werkt: minimaal één designpartner-gesprek per week

**Rode vlag om terug te trekken:** als na 5+ designpartner-gesprekken niemand een concreet blok/document noemt dat ze missen → tech-fantasie, terugtrekken. Beter vroeg weten.

---

## 11. Open vragen

- **Prijspunt** — bepaalt product-implicaties (support-load, competitie, verwachting)
- **Doelgroep-mix** — bestaande Studio4-agents (upsell) of nieuwe leads?
- **Governance-laag** voor netwerken (TravelXL/franchise) — MVP niet nodig, data-model moet 't kunnen dragen
- **Kannibalisatie op Studio4-standaard-templates** — hoe positioneren?
- **Kostenmodel AI-tokens** — credits per tier vs soft-cap
- **Renderer-strategie** — gedeeld pakket voor Studio4 en Design4, of per kanaal apart?
- **PDF-engine** — Puppeteer vs react-pdf vs anders
- **Sandbox voor Develop mode** — WebContainer vs Sandpack vs iframe+CSP
- **Design-session state ↔ document-sync** — precies hoe?
- **Marketplace** — revenue-share vs complexiteit
- **Sessieduur + max intrekking-vertraging** — ruwe guess: 8u sessie, 15 min recheck, direct bij publish; definitief bij implementatie
- **Frontend framework** — Next.js vs Vite+React
