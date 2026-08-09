# Architectuur — design4.travel

Deze notitie beschrijft de architectuur zoals die in fase 1 werkt, plus de expliciete uitbreidingspunten voor latere fasen. Bij wijzigingen: update dit document en de README parallel.

**Laatste update:** 2026-08-09.

---

## Ontwerpprincipes

1. **Getypeerd JSON-ontwerpmodel is canonical** — geen losse HTML/CSS als bron. Elke node wordt gevalideerd via zijn eigen Zod-schema.
2. **Documenttype ≠ uitvoerformaat.** `website`/`offerte`/`roadbook`/`brochure`/`social`/`document` beschrijven *wat* je maakt. `web`/`pdf`/`image`/(later `docx`) beschrijven *hoe* de renderer het naar buiten brengt.
3. **Renderer is een aparte module.** De chat-app weet niks van DOM-details van het ontwerp; de renderer weet niks van chat-state.
4. **Preview draait in een iframe.** De chat draait niet in een iframe — alleen de preview. Iframe geeft physische isolation die later doorontwikkeld kan worden voor Develop-mode sandboxing.
5. **Voorlopige uitgangspunten** (subscription, auth-flow, PDF-engine, sandbox-tech) worden expliciet als voorlopig gemarkeerd; niet als besloten productbesluit weggezet.
6. **Vermijd overengineering.** Alleen interfaces die de MVP daadwerkelijk gebruikt bestaan als code — de rest is gedocumenteerd als uitbreidingspunt.
7. **Geen API-keys of secrets in de frontend.** Ooit-echte AI en publish-integraties lopen via een aparte backend die pas later gebouwd wordt.
8. **Leveranciers-integraties lopen via een beveiligde server-side integratielaag.** Design4-frontend en design-doc weten niet dat externe leveranciers bestaan; ze zien alleen het genormaliseerde Studio4-model.

---

## Lagen (huidig)

```
┌─────────────────────────────────────────────────────────────┐
│  Chat/AI-laag                                                │
│    apps/app/src/features/chat/*                              │
│    apps/app/src/adapters/ai/  (AIAdapter + MockAIAdapter)    │
└──────────────────────┬───────────────────────────────────────┘
                       │ patches (typed PatchOp[])
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Design-doc-laag                                             │
│    packages/design-doc                                       │
│    • Zod-schema (DesignDoc/Page/NodeInstance)                │
│    • applyPatch / applyPatches                               │
│    • undo/redo stack                                         │
│    • PersistenceAdapter (interface, één centrale plek)       │
│  Store: apps/app/src/state/designDocStore.ts (Zustand)       │
└──────────────────────┬───────────────────────────────────────┘
                       │ postMessage (typed protocol)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Preview (iframe, apps/app/preview.html)                    │
│    apps/app/src/PreviewApp.tsx                               │
│    • luistert naar host-messages                             │
│    • roept renderer aan                                      │
│    • rapporteert node-selectie terug                         │
└──────────────────────┬───────────────────────────────────────┘
                       │ renderTarget('web', doc, ctx)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Renderer-laag                                               │
│    packages/renderer                                         │
│    • TargetAdapter-interface (web/pdf/image/…)               │
│    • web-target: React-tree, per-node component              │
│    • resolveProps: merge base+override, resolve binds+tokens │
│      + validate via node's Zod-schema                        │
└──────────────────────┬───────────────────────────────────────┘
                       │ node.type lookup
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Typed-nodes-laag                                            │
│    packages/typed-nodes                                      │
│    • NodeRegistry-interface + InMemoryNodeRegistry           │
│    • 7 built-ins: layout-row, layout-column, heading, text,  │
│      image, hero, cta                                        │
│    • per node: propsSchema (Zod), bindSlots, acceptsChildren │
└──────────────────────┬───────────────────────────────────────┘
                       │ resolveBinding(model, path)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Data-bindings-laag                                          │
│    packages/data-bindings                                    │
│    • Studio4Model-types (accommodation, trip, day, activity) │
│    • mockData: luxury / budget / missing-image varianten     │
│    • resolveBinding(model, "accommodation.name")             │
└─────────────────────────────────────────────────────────────┘
```

Elke laag is een eigen npm-workspace-package (behalve chat en preview, die in `apps/app` samen leven omdat ze één Vite-app zijn met twee entrypoints).

---

## Chat ↔ preview: hoe ze technisch gescheiden zijn

- **Twee HTML-entries in dezelfde Vite-app:** `index.html` (chat) en `preview.html` (preview). Configuratie in `apps/app/vite.config.ts` via `rollupOptions.input`.
- **De chat-app rendert een `<iframe src="/preview.html">`.** Alleen de preview draait in een iframe; de chat zelf niet.
- **Communicatie via `postMessage`.** Getypeerd protocol in `apps/app/src/features/preview/previewProtocol.ts`:
  - **Host → preview:** `load-doc`, `set-selection`, `set-variant`
  - **Preview → host:** `ready`, `node-selected`
- **Geen shared globals.** De preview-app importeert zelf `@design4/renderer`, `@design4/typed-nodes`, `@design4/data-bindings`. Ze delen alleen bundle-code via Vite's chunking — geen runtime-state.
- **Geen tenant-isolation of full sandbox** in fase 1. Dit iframe-pattern is de infrastructuur die later doorontwikkeld kan worden (strengere CSP, aparte origin, resource-limits) voor Develop-mode.

---

## Prompt → zichtbare wijziging (fase 1-flow)

```
1. Gebruiker typt in ChatPane → PromptInput
2. useChatController.sendPrompt(text)
   • append user-message
   • setBusy(true)
3. MockAIAdapter.generatePatch({ doc, selectedNodeId }, text)
   • pattern-match regexes
   • return { assistantMessage, patches: PatchOp[] }
4. designDocStore.applyOps(patches)
   • immer-update via applyPatches
   • valideer resultaat via DesignDocSchema
   • push snapshot naar undo-stack
   • schedule autosave (300ms debounce) via PersistenceAdapter
5. PreviewPane useEffect() ziet doc-verandering
   • sendToPreview(iframe.contentWindow, { kind: 'load-doc', doc, variant, selectedNodeId })
6. PreviewApp ontvangt bericht
   • setDoc(msg.doc) → re-render
7. renderTarget('web', doc, ctx) → React-tree in iframe
```

Faalgevallen:
- `applyPatches` throwt → store zet `saveState: 'error'` + `lastError` (zichtbaar in ChatPane-header).
- `DesignDocSchema` faalt → patch wordt niet gecommit, error zichtbaar.
- Per-node `propsSchema` faalt → `resolveProps` returned defaults + error, renderer toont inline `RenderError` boven de node.

---

## Design-doc-schema (uitgelicht)

```ts
DesignDoc = {
  version: string;
  id: string;
  project: {
    documentType: 'website' | 'offerte' | 'roadbook' | 'brochure' | 'social' | 'document';
    title: string;
    brandId?: string;
  };
  meta: { createdAt, updatedAt, updatedBy? };
  brandTokens?: Record<string, string>;          // "brand.primary": "#4f46e5"
  outputs: {
    web:   { enabled: boolean };
    pdf?:  { enabled: boolean };
    image?: { enabled: boolean };
  };
  pages: Page[];                                 // ≥ 1
}

Page = {
  id: string;
  name?: string;
  root: NodeInstance;
}

NodeInstance = {
  id: string;
  type: string;                                  // node-type-name
  props: Record<string, unknown>;
  bind?: Record<string, string>;                 // "text": "accommodation.name"
  overrides?: {
    web?: { props?, bind? };
    pdf?: { props?, bind? };
    image?: { props?, bind? };
  };
  children?: NodeInstance[];
}
```

**Waarom dit vorm:**
- `project.documentType` scheidt "wat maken we" van "hoe renderen we het".
- `outputs` beschrijft welke uitvoerformaten actief zijn (fase 1: alleen `web`).
- `pages: Page[]` — één pagina in de demo, meerpagina-documenten blijven mogelijk zonder schema-breaking migratie.
- `overrides` per uitvoerformaat vanaf dag 1 in het schema, zodat PDF-specifieke tweaks later niet-breaking toegevoegd kunnen worden.
- `version` in het document zelf, zodat we later migraties kunnen doen zonder gokwerk.

---

## Renderer

Interface (in `packages/renderer/src/types.ts`):

```ts
type TargetAdapter = {
  output: OutputFormat;                          // 'web' | 'pdf' | 'image'
  renderRoot(doc, ctx): ReactNode;
  renderNode(node, doc, ctx): ReactNode;
};
```

Registratie in `packages/renderer/src/render.ts`:

```ts
const registry: Partial<Record<OutputFormat, TargetAdapter>> = { web: webTarget };
export function renderTarget(output, doc, ctx): ReactNode
export function registerTarget(adapter: TargetAdapter): void
```

Fase 1 heeft alleen de web-adapter. `renderTarget('pdf', …)` throwt `NotImplementedError` — geen stille failure.

**Props-resolutie** (`packages/renderer/src/resolveProps.ts`):

1. Merge `node.props` + `node.overrides[output].props`.
2. Merge `node.bind` + `node.overrides[output].bind`.
3. Resolve elke binding via `resolveBinding(dataModel, path)`.
4. Substitueer `{brand.token}`-references met waarden uit `doc.brandTokens`.
5. Valideer via `NodeDefinition.propsSchema.safeParse(...)`.
6. Bij validatie-fout: return schema-defaults + error-message, renderer toont een `RenderError`-balk boven de node.

---

## Typed-nodes-catalogus (fase 1)

Zeven built-in nodes, allemaal in `packages/typed-nodes/src/nodes/`:

| Type | Doel | Bindbare props |
|---|---|---|
| `layout-row` | horizontale flexbox-container | — |
| `layout-column` | verticale flexbox-container | — |
| `heading` | H1–H4 | `text` |
| `text` | paragraaf-tekst | `text` |
| `image` | `<img>` met fallback | `src`, `alt` |
| `hero` | hero-sectie met titel, subtitel, achtergrond | `title`, `subtitle`, `imageSrc` |
| `cta` | call-to-action knop | `text`, `href` |

Elke node exporteert:
- Een `PropsSchema` (Zod) — de renderer valideert hiertegen.
- Bind-slots — welke props door bindings gedreven kunnen worden.
- `acceptsChildren` — mag deze node children bevatten?
- `source: 'builtin'` — reserved veld dat `'custom'` wordt zodra Develop-mode nodes toevoegt.

---

## Uitbreidingspunten (nog niet gebouwd)

Documenteer alleen — geen code in fase 1.

### Meer uitvoerformaten

Implementeer `TargetAdapter` in `packages/renderer/src/targets/pdf.tsx` (of aparte package) en registreer via `registerTarget()`. Node-definities kunnen per uitvoerformaat een andere renderer-implementatie leveren zodra we dat nodig hebben.

**Openstaand:** PDF-engine (Puppeteer / react-pdf / anders), DOCX-engine.

### Echte AI-integratie

Vervang `MockAIAdapter` door een `ClaudeAIAdapter` die via een backend-proxy (`apps/api`) een Claude-call maakt. **API-key blijft server-side** — nooit in de frontend-bundle. Interface (`AIAdapter`) blijft ongewijzigd.

### Supabase-persistence

Implementeer `PersistenceAdapter` (interface leeft centraal in `packages/design-doc/src/persistence.ts`) tegen Supabase. Wisselen gaat via `attachPersistence()` in `apps/app/src/state/designDocStore.ts`.

**Openstaand:** RLS-policy-strategie, wel/geen gedeeld schema met Studio4.

### Publish-flow

Nieuwe package `packages/publish/` met `PublishAdapter`-interface, plus concrete adapters:
- `studio4-template-api` — publish naar Studio4-bibliotheek
- `pdf-export` — download / e-mail
- `netlify-preview` — publieke preview-URL
- `git` — versiebeheer voor custom componenten (Develop-mode)

Wordt aangeroepen vanuit `apps/api`, niet vanuit `apps/app`.

### Auth / SSO / entitlement

Nieuwe package `packages/auth/` met `SessionAdapter` + `EntitlementAdapter`. Auth-handoff-endpoint komt in `apps/api/`. Webhook-ontvanger van Studio4 idem. Fase 1 heeft geen enkel auth-artefact.

### Develop mode

Sandbox-uitvoering van AI-gegenereerde React/TS-componenten:
- Iframe-pattern uitbreiden met strengere CSP en aparte origin per gebruiker
- Sandbox-adapter (kandidaten: WebContainer, Sandpack, of iframe+CSP+worker)
- Build + test pipeline binnen de sandbox
- Review-gate voor promotie naar `NodeDefinition` met `source: 'custom'`
- Component-versiebeheer via Git

Fase 1 heeft alleen de infrastructuur (`source` en `scope`-velden op `NodeDefinition`, iframe-preview) — de sandbox zelf is er niet.

### Marketing-site & interne API

- `apps/site/` — publieke `design4.travel` (Next.js, SSR voor SEO — nog niet gekozen).
- `apps/api/` — Node-backend voor auth-handoff, template-publish, webhooks, sandbox-gateway, AI-proxy, én de leveranciers-integratielaag hieronder.

### Leveranciers-integratielaag (Studio4-ecosysteem)

Design4 is deel van het Studio4-ecosysteem (studio4, roadbook4, camper4). Reisdata en boeking-integraties leven **niet in Design4**, ze leven in een beveiligde server-side laag binnen `apps/api`. Design4 consumeert alleen het genormaliseerde Studio4-model dat die laag emit.

Bronnen die via die laag beschikbaar kunnen komen (later, niet in fase 1):

- **Travel Compositor** — reispakketten, boekingsdata
- **Qenner** — reserveringssysteem
- **NextPax** — accommodatie-channel-manager
- **Interne Studio4-data** — reeds genormaliseerde reisdata uit Studio4 zelf

**Regels (non-negotiable):**

1. **API-credentials van leveranciers leven server-side.** Nooit in `apps/app`, nooit in `.env` van de frontend, nooit in de Vite-bundle. `apps/api` beheert ze (via secrets-store, nog te kiezen).
2. **Ruwe leveranciers-responses (TC-XML, Qenner-JSON, NextPax-payloads) komen niet in de frontend of in het design-doc.** De server-side laag normaliseert naar het `Studio4Model` (zie `packages/data-bindings/src/types.ts`) en levert alleen dat.
3. **Design-doc bindings verwijzen alleen naar het genormaliseerde model** (`accommodation.name`, `trip.days.0.activities`, …), nooit naar bronveldnamen (`tc.hotel.HotelName`, `nextpax.property.title`, …). Zie ook het overeenkomstige principe in [`docs/product.md`](../docs/product.md).
4. **Frontend praat alleen met `apps/api`.** Cross-origin calls naar TC/Qenner/NextPax vanuit de browser zijn per definitie een fout.
5. **Rate-limiting en caching leven in `apps/api`.** Fair-use en kosten-controle horen niet in de frontend of het design-doc.

Deze scheidingen bestaan **nu al conceptueel** in de architectuur (bindings tegen genormaliseerd model in fase 1 met mock-data), zodat toevoegen van de echte integratielaag geen breaking change is aan design-docs of nodes.

---

## Wat er expliciet NIET is in fase 1

- Geen `apps/api`, geen `apps/site` (documenttypes worden alleen in de app-shell voorbereid).
- Geen `packages/publish`, geen `packages/auth` — interfaces daarvoor komen mét de eerste concrete use-case, niet als lege stubs.
- Geen echte AI, geen network-call, geen API-key in de frontend.
- Geen sandbox voor gebruikers-code — iframe biedt renderer-scheiding, niet security-isolation.
- Geen Supabase, geen RLS, geen migraties.
- Geen publish-flow naar Studio4.
- Geen Develop mode.
- Geen multi-page navigatie in de preview (schema ondersteunt het, UI toont pagina 1).
- Geen echte PDF-render, geen offerte- of roadbook-layout-conventies.
