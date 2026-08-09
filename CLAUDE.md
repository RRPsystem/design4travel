# CLAUDE.md — instructies voor AI-assistent-sessies

Deze notitie is de eerste plek om te lezen als je in een nieuwe sessie werk op deze repo begint.

---

## Wat is dit project

`design4.travel` — AI-native ontwerp- en ontwikkelomgeving voor reisprofessionals. Chat links, live preview rechts. Broader dan een Studio4-componentdesigner: het is v0 × Canva voor de reisbranche.

Zie [`README.md`](README.md) voor een samenvatting en [`docs/product.md`](docs/product.md) voor de volledige productdefinitie. [`docs/architecture.md`](docs/architecture.md) heeft de technische uitwerking. [`docs/roadmap.md`](docs/roadmap.md) voor fasering.

---

## Bron-van-waarheid

1. **Deze repo is canonical.** Product- en architectuurbesluiten leven hier — niet in geheugen van andere projecten (bv. TravelBridgeAI). Als je een conflict tegenkomt, is deze repo leidend.
2. **README + docs/** = wat besloten is. **Voorlopige uitgangspunten** zijn expliciet als "voorlopig" gemarkeerd — behandel ze zo.
3. **Bij nieuwe beslissingen:** update README en het relevante document onder `docs/` in dezelfde wijziging. Los niets in code op zonder de docs bij te trekken.

---

## Kernprincipes voor werk op deze codebase

1. **Documenttype ≠ uitvoerformaat.** `website`/`offerte`/`roadbook`/`brochure`/`social`/`document` zijn documenttypes. `web`/`pdf`/`image`/`docx` zijn uitvoerformaten. Een offerte kan naar web én PDF renderen — dat zijn geen aparte design-docs.

2. **Getypeerd JSON is canonical.** Elke node wordt gevalideerd via zijn eigen Zod-schema (`NodeDefinition.propsSchema`). Custom componenten uit Develop mode registreren zich als nieuwe node-types met eigen schema.

3. **Renderer is een aparte package.** Chat-app weet niks van DOM-details van het ontwerp; renderer weet niks van chat-state. Verstoor deze scheiding niet.

4. **Alleen de preview draait in een iframe.** De chat draait niet in een iframe. Het iframe biedt in fase 1 renderer-scheiding, geen security-isolation.

5. **Compose mode is veilige default.** Develop mode (AI-codegeneratie voor nieuwe componenten) is escape-hatch en vereist sandbox + review-gate. Nooit publiek zonder die gates.

6. **Geen API-keys of secrets in de frontend.** Toekomstige echte AI en publish-integraties lopen via een aparte backend (`apps/api`, nog niet gebouwd). Als je de neiging voelt om een key aan een env-var in `apps/app` te hangen — niet doen.

7. **Alleen interfaces bouwen die daadwerkelijk gebruikt worden.** Fase 1 heeft `AIAdapter`, `PersistenceAdapter`, `NodeRegistry` en `TargetAdapter` omdat de MVP die aanroept. `PublishAdapter`/`SessionAdapter`/`EntitlementAdapter` bestaan alleen als gedocumenteerd uitbreidingspunt in [`docs/architecture.md`](docs/architecture.md) — geen lege stub-packages.

8. **Vermijd overengineering.** Geen abstractie zonder minstens twee use-cases. Geen half-af werk. Bugfix ≠ omliggende cleanup.

9. **PersistenceAdapter-interface leeft op één plek** — `packages/design-doc/src/persistence.ts`. localStorage-implementatie in `apps/app`. Toekomstige Supabase-implementatie in een eigen bestand of package die dezelfde interface implementeert.

---

## Wat NIET automatisch mag

- **Geen git-acties** (init, commit, push, force-push) zonder expliciete gebruikersgoedkeuring per sessie.
- **Geen npm-registry publish**.
- **Geen dependencies toevoegen** die niet nodig zijn voor concrete taak. Bij twijfel: vragen.
- **Geen wijzigingen aan de PersistenceAdapter-interface** zonder de localStorage-adapter mee te migreren.
- **Geen echte AI-integratie** in `apps/app` zonder eerst `apps/api` als backend te hebben en de key server-side te houden.

---

## Fase 1-status (klaar)

- Monorepo (npm workspaces): 4 packages + 1 app
- Getypeerd JSON design-doc met project-metadata, meerpagina-ondersteuning, per-output-overrides
- 7 built-in typed nodes met eigen Zod-schemas
- Renderer-package met web-target werkend, `pdf`/`image` throwen `NotImplementedError`
- Vite-app met chat + preview-iframe, postMessage-protocol
- Deterministische mock-AI met 6 prompt-patronen (geen network)
- localStorage-autosave via `PersistenceAdapter`-interface
- Undo/redo op document-niveau
- Element-selectie in canvas → chat-context
- 39 Vitest-tests groen, typecheck schoon, build slaagt

Zie [`docs/roadmap.md`](docs/roadmap.md) voor wat volgt.

---

## Snelle referenties

- **Design-doc-schema:** `packages/design-doc/src/schema.ts`
- **PersistenceAdapter (centraal):** `packages/design-doc/src/persistence.ts`
- **Patch-operaties:** `packages/design-doc/src/patch.ts`
- **NodeRegistry & 7 built-ins:** `packages/typed-nodes/src/`
- **Renderer + TargetAdapter:** `packages/renderer/src/`
- **AIAdapter + MockAIAdapter:** `apps/app/src/adapters/ai/`
- **Chat-store / doc-store:** `apps/app/src/state/`
- **postMessage-protocol:** `apps/app/src/features/preview/previewProtocol.ts`
- **Seed mock landing page:** `apps/app/src/seed/mockLandingPage.ts`

---

## Dev-commando's

```bash
npm install
npm run dev           # http://localhost:5173
npm run build
npm run typecheck
npm run test
```
