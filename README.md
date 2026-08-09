# design4.travel

> AI-native ontwerp- en ontwikkelomgeving voor reisprofessionals. Chat links, live preview rechts. Maak al pratend websites, offertes, roadbooks, brochures, PDF's, documenten, social-uitingen én herbruikbare componenten.

**Status:** fase 1 werkend. Applicatieshell, chat, live preview, mock-landingspagina, typed ontwerpmodel, losse renderer, localStorage-autosave, undo/redo, elementselectie als chatcontext, 39 tests groen.

**Laatste update:** 2026-08-09.

---

## Kern

Design4.travel is een op zichzelf staand product in de 4-familie (naast studio4, roadbook4, camper4). Positionering: **v0 × Canva voor reisprofessionals**, met domeinkennis en integratie met het Studio4-datamodel.

De centrale UX is een gesprek met AI aan de linkerkant en een live preview/canvas aan de rechterkant. Elementen aanklikken in de preview selecteert ze in de chat. De gebruiker hoeft geen HTML, CSS of databinding te kennen.

### Twee modi (Develop nog niet gebouwd)

| Mode | Wat | Voor wie | Publiceerbaar? |
|---|---|---|---|
| **Compose** | Ontwerpen met goedgekeurde typed nodes (`card`, `image`, `heading`, `text`, `list`, `facilities`, `price`, `layout-row`, `layout-column`, …) + bindings tegen het Studio4-datamodel. | Alle reisagents, zonder codekennis. | Ja, direct naar alle uitvoerformaten. |
| **Develop** | AI genereert nieuwe React/TypeScript-componenten, draait ze in een sandbox, met build + tests. Component kan na review-gate geregistreerd worden als nieuwe typed node in de bibliotheek. | Power-users, interne curators, designpartners. | Alleen na review — dan wordt de component beschikbaar in Compose mode. |

Typed JSON blijft in beide modi het standaard opslag- en publicatiemodel. Custom componenten registreren zich als nieuwe node-types met eigen schema.

### Documenttypes × uitvoerformaten

Design4 onderscheidt **wat je maakt** (documenttype) van **hoe het gerenderd wordt** (uitvoerformaat).

- **Documenttypes:** `website`, `offerte`, `roadbook`, `brochure`, `social`, `document`.
- **Uitvoerformaten:** `web`, `pdf`, `image`, later `docx`.

Een offerte of roadbook is *niet automatisch* een aparte technische rendertarget — het is een documenttype dat kan renderen naar web (voorbeeld) én naar PDF (afdruk/mail).

---

## Positionering

Zelfstandig product met eigen deploys (nog niet geconfigureerd in fase 1):

- **App:** `app.design4.travel`
- **Publieke marketing-site:** `design4.travel`
- **Interne API:** `api.design4.travel`

Publish-flow naar Studio4 (offerte/roadbook/website), PDF-export, embed en Netlify-preview zijn latere uitbreidingspunten — zie [`docs/architecture.md`](docs/architecture.md).

## Ecosysteem-context (Studio4-familie)

Design4.travel leeft in het Studio4-ecosysteem (naast `studio4`, `roadbook4`, `camper4`). Design4 zelf bouwt design-documenten; de echte reisdata en leveranciers-integraties leven **buiten Design4**, achter een beveiligde server-side integratielaag.

Bronnen die via die laag beschikbaar kunnen komen (allemaal later, niet in fase 1):

- **Travel Compositor** — reispakketten en boekingsdata
- **Qenner** — reserveringssysteem
- **NextPax** — accommodatie-channel-manager
- **Interne Studio4-data** — het reeds genormaliseerde reismodel (`accommodation.*`, `trip.*`, `day.*`, `activity.*`)

**Hard security-principe:**

- **API-credentials van leveranciers komen nooit in de frontend of in het design-doc.** Ze leven server-side (in `apps/api`, nog niet gebouwd).
- **Ruwe leveranciers-responses komen nooit in de frontend of in het design-doc.** De server-side laag normaliseert alles naar het Studio4-model; alleen dat model wordt in bindings gebruikt (`accommodation.name`, etc.).
- Design-doc en renderer weten niet dat TC/Qenner/NextPax bestaan — ze zien alleen de genormaliseerde shapes uit `packages/data-bindings`.

Dit maakt Design4 bron-onafhankelijk: welke leveranciers Studio4 gebruikt kan wijzigen zonder dat één design-doc breekt.

---

## Datamodel & rendering

- **Opslagformaat:** getypeerd JSON design-document met expliciete project-metadata (`documentType`), pagina's, per-uitvoerformaat-overrides. Geen losse HTML/CSS als canonical bron.
- **Data-abstractielaag:** bindings tegen een genormaliseerd Studio4-model (`accommodation.*`, `trip.*`, `day.*`, `activity.*`), niet direct tegen bronveldnamen (TC/WebU/handmatig). Fase 1 gebruikt in-memory mock-data.
- **Multi-output rendering:** één design-doc → target-adapter per uitvoerformaat. Fase 1 heeft alleen `web`; `pdf`/`image` throwen expliciete `NotImplementedError`.
- **Design-tokens:** brand-primary/secondary/typografie als variabelen (`{brand.primary}`). Eén ontwerp neemt automatisch de merkstijl over.
- **Component registry:** built-in typed nodes + (later) door de gebruiker geregistreerde custom componenten uit Develop mode, scoped per brand of agent. Fase 1: alleen built-ins.

Zie [`docs/architecture.md`](docs/architecture.md) voor lagen, dataflow, prompt→preview-keten en uitbreidingspunten.

---

## Voorlopige uitgangspunten

Nog niet vast — worden bevestigd via POC en designpartner-gesprekken.

**Business** — subscription (waarschijnlijk verplicht), prijspunt open, scopes Brand/Agent, statussen Trial/Active/Suspended/Cancelled. Doelgroep-mix (Studio4-upsell vs nieuwe leads) open.

**Auth & SSO (richting)** — eenmalige short-lived autorisatiecode vanuit Studio4, lokale sessievalidatie, ondertekende idempotente entitlement-webhooks, continue autosave + read-only fallback, autorisatie backend-first via RLS + edge-function guards. Nog niet gebouwd.

**Tech** — Supabase-project (voorlopig gedeeld met Studio4 in apart schema), AI-schema-toegang (MVP statische injectie, V2 tool-use), sandbox-technologie voor Develop mode (WebContainer / Sandpack / iframe+CSP — nog niet gekozen), PDF-engine (Puppeteer / react-pdf — nog niet gekozen).

---

## Stack (fase 1)

- **Monorepo:** npm workspaces
- **Taal:** TypeScript, strict, `noUncheckedIndexedAccess`
- **App:** Vite + React 18 + Zustand
- **Schema:** Zod (design-doc en node-props)
- **State-mutaties:** immer
- **Tests:** Vitest
- **Rendering:** eigen renderer-package met inline styles (geen framework-lock-in)
- **Persistence:** localStorage (Supabase-adapter volgt via dezelfde `PersistenceAdapter`-interface)
- **AI:** deterministische mock-adapter — geen network, geen API-key. Echte Claude-integratie komt later via een backend-proxy.

---

## Installatie

Vereist Node 20+ (zie `.nvmrc`).

```bash
git clone <repo-url>
cd Design4Travel
npm install
```

Er is nog geen git-remote — de repo is ook nog niet geïnitialiseerd. Zie `docs/roadmap.md` voor status.

---

## Commando's

```bash
npm run dev           # start apps/app op http://localhost:5173
npm run build         # bouw alle packages + app
npm run typecheck     # tsc --build over de hele workspace
npm run test          # vitest run
npm run test:watch    # vitest interactief
```

De chat draait op `http://localhost:5173/`, de preview wordt daaruit als iframe geladen via `http://localhost:5173/preview.html`.

---

## Mappenstructuur

```
Design4Travel/
├── apps/
│   └── app/                          # Vite + React SPA — chat + preview-iframe
│       ├── index.html                # chat-entry
│       ├── preview.html              # preview-entry (iframe target)
│       └── src/
│           ├── main.tsx              # chat-entry mount
│           ├── App.tsx               # split-layout
│           ├── preview-main.tsx      # preview-entry mount
│           ├── PreviewApp.tsx        # preview-side, roept renderer aan
│           ├── features/chat/        # ChatPane, MessageList, PromptInput, useChatController
│           ├── features/preview/     # PreviewPane, previewProtocol
│           ├── state/                # designDocStore, chatStore (Zustand)
│           ├── adapters/ai/          # AIAdapter interface + MockAIAdapter
│           ├── adapters/persistence/ # localStorage-implementatie
│           └── seed/                 # seed mock landing page
├── packages/
│   ├── design-doc/                   # typed JSON schema, patch, undo, PersistenceAdapter
│   ├── typed-nodes/                  # NodeRegistry + 7 built-in nodes met Zod-schemas
│   ├── renderer/                     # TargetAdapter + web-renderer + resolveProps
│   └── data-bindings/                # Studio4-modelmap + mock-data + resolver
├── docs/
│   ├── product.md                    # volledige productdefinitie
│   ├── architecture.md               # lagen, dataflow, uitbreidingspunten
│   └── roadmap.md                    # fase 1 (klaar) + volgende fasen
├── README.md
├── package.json                      # npm workspaces root
├── tsconfig.base.json
├── tsconfig.json                     # project references
├── vitest.config.ts
├── .gitignore
├── .editorconfig
├── .nvmrc
└── .prettierrc
```

**Bewust nog niet aanwezig in fase 1** — gedocumenteerd als uitbreidingspunten in [`docs/architecture.md`](docs/architecture.md):

- `apps/api/` (auth-handoff, template-publish, webhook-receiver, sandbox-gateway)
- `apps/site/` (marketing-site `design4.travel`)
- `packages/publish/` (PublishAdapter voor Studio4/Netlify/Git/PDF)
- `packages/auth/` (SessionAdapter, EntitlementAdapter)
- `supabase/` (schema-migraties, RLS-policies)

---

## Latere roadmap

Zie [`docs/roadmap.md`](docs/roadmap.md).

---

## Voor Claude (nieuwe sessie)

Zie [`CLAUDE.md`](CLAUDE.md) zodra dat bestand er is. Kort:

- Deze repo is de canonical bron voor product- en architectuurbesluiten. Andere projecten of memory-notities zijn geen gezag.
- "Voorlopige uitgangspunten" zijn nog niet besloten — behandel ze als zodanig.
- Compose mode is de veilige default. Develop mode is escape-hatch met sandbox + review-gate; nooit publiek zonder die gates.
- Bij nieuwe beslissingen: update README + relevant doc onder `docs/` in dezelfde PR.
