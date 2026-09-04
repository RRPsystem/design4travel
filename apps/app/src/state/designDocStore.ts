import { create } from 'zustand';
import {
  applyPatch,
  DesignDocSchema,
  docsEqualIgnoringMeta,
  emptyStack,
  PatchError,
  pushSnapshot,
  redo as redoStack,
  undo as undoStack,
  type ApplyResult,
  type DesignDoc,
  type NodeInstance,
  type PatchOp,
  type UndoStack,
  type VersionHistoryAdapter,
  type VersionSnapshot,
  type VersionSummary,
  type RollbackResult,
} from '@design4/design-doc';
import type { PersistenceAdapter } from '@design4/design-doc';
import type { NodeRegistry } from '@design4/typed-nodes';
import type { SampleDataVariant } from '@design4/data-bindings';
import { isLockVersionMismatch } from '../adapters/persistence/supabase.js';
import { messageForRollbackError } from '../features/version-history/errorMessages.js';

type State = {
  doc: DesignDoc;
  stack: UndoStack;
  selectedNodeId?: string;
  variant: SampleDataVariant;
  /**
   * `lock-conflict` is een absorberende state: de laatste save is met
   * `lock_version_mismatch` afgewezen. Autosave is gepauzeerd tot een
   * expliciete rebase/reload (nu aparte scope). Verdere mutaties werken de
   * in-memory doc wél bij zodat de gebruiker niet zijn werk kwijtraakt.
   */
  saveState: 'idle' | 'saving' | 'saved' | 'error' | 'lock-conflict';
  lastError?: string;
  /** Huidige backend lock_version — bumpt bij elke save/rollback. */
  currentLockVersion: number;
  /**
   * Wanneer gezet: preview toont deze oudere versie, de editor blijft
   * ongewijzigd. Herstel naar de echte editor via `stopPreviewingVersion()`
   * of via een succesvolle `restoreVersion()`.
   */
  previewingVersion: VersionSnapshot | null;
  /** Wordt tijdens een lopende rollback op `true` gezet zodat de UI kan blokkeren. */
  isRestoring: boolean;
};

type Actions = {
  applyOps(ops: PatchOp[]): ApplyResult;
  select(nodeId?: string): void;
  setVariant(v: SampleDataVariant): void;
  undo(): boolean;
  redo(): boolean;
  reset(seed: DesignDoc): void;
  previewVersion(v: VersionSnapshot): void;
  stopPreviewingVersion(): void;
  restoreVersion(v: VersionSnapshot): Promise<RollbackResult>;

  /**
   * Streaming-transactie voor live-preview tijdens AI-streams.
   *
   * Gebruik: `beginStream()` vóór stream-start; `applyStreamOp(op)` bij elk
   * inkomend tool_complete-event met een patch; `commitStream()` bij stream-
   * eind (succes) OF `rollbackStream()` bij stream-error.
   *
   * Verschil met `applyOps`: elke `applyStreamOp` muteert de doc DIRECT
   * (preview updated live via subscription), maar pusht GEEN undo-snapshot
   * en triggert GEEN scheduleSave. `commitStream()` doet dat één keer voor
   * de hele turn — één undo-eenheid per stream, één save. `rollbackStream()`
   * herstelt naar de baseline-doc uit `beginStream()`.
   *
   * Zonder voorafgaande `beginStream()` zijn `applyStreamOp`/`commitStream`/
   * `rollbackStream` no-ops (fail-safe voor stray callbacks).
   */
  beginStream(): void;
  applyStreamOp(op: PatchOp): ApplyResult;
  commitStream(): { changed: boolean };
  rollbackStream(): void;
};

let persistence: PersistenceAdapter | null = null;
let versionsAdapter: VersionHistoryAdapter | null = null;
let versionSink: ((doc: DesignDoc) => VersionSummary) | null = null;
let nodeRegistry: NodeRegistry | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Baseline-doc voor de actieve streaming-transactie. `null` = geen actieve
 * stream. Gezet door `beginStream()`, hersteld naar de doc bij `rollbackStream()`,
 * gebruikt voor de undo-snapshot bij `commitStream()`. Module-level (net als
 * `saveTimer`) omdat het transient control-plane state is die niets in de
 * Zustand-store hoort te lekken.
 */
let streamBaseline: DesignDoc | null = null;

/**
 * Hangt de NodeRegistry aan de store. Verplicht in productie: `applyOps`
 * weigert non-empty ops-arrays met `registry-missing` als de registry niet
 * gehangen is (fail-closed — anders zou property-validatie stilletjes worden
 * overgeslagen en zouden onbekende hero-props ongemerkt worden opgeslagen).
 */
export function attachNodeRegistry(registry: NodeRegistry) {
  nodeRegistry = registry;
}

export function detachNodeRegistry() {
  nodeRegistry = null;
}

export function attachPersistence(adapter: PersistenceAdapter) {
  persistence = adapter;
}

/**
 * Bewust GEEN noopPersistence-alternatief — dat zou stille wegflowering van
 * changes betekenen terwijl de UI nog "Opgeslagen" toont. `null` + de
 * scheduleSave-guard is expliciet en veilig.
 *
 * Cancel eventuele debounce-timer meteen zodat er geen lopende callback meer
 * kan fires. En als toch een callback het net vóór clearTimeout heeft
 * uitgevoerd: de capture-closure in scheduleSave check't `persistence ===
 * captured` en zal skippen — geen save-lek naar een volgende adapter.
 */
export function detachPersistence() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persistence = null;
}

export function attachVersions(adapter: VersionHistoryAdapter) {
  versionsAdapter = adapter;
}

export function detachVersions() {
  versionsAdapter = null;
}

/**
 * Registreert een callback die na iedere debounced save wordt aangeroepen om
 * een nieuwe versie vast te leggen. Retourneert de nieuwe VersionSummary
 * zodat `currentLockVersion` automatisch bijgewerkt kan worden.
 *
 * In productie wordt de versie door de save-RPC zelf gemaakt — dan is deze
 * sink niet nodig. De mock-adapter simuleert dat gedrag.
 */
export function attachVersionSink(sink: (doc: DesignDoc) => VersionSummary) {
  versionSink = sink;
}

export function detachVersionSink() {
  versionSink = null;
}

/**
 * Vindt een node in het document. Gebruikt door de pre-validatie om
 * onbekende node-ids af te wijzen vóórdat we een op toepassen.
 */
function findNodeInDoc(doc: DesignDoc, nodeId: string): NodeInstance | undefined {
  for (const page of doc.pages) {
    const stack: NodeInstance[] = [page.root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.id === nodeId) return n;
      if (n.children) stack.push(...n.children);
    }
  }
  return undefined;
}

/** Runtime-shape van een Zod-object schema, voor zover we het nodig hebben. */
interface ZodObjectLike {
  shape?: Record<string, ZodTypeLike>;
  strict?: () => ZodTypeLike;
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues?: Array<{ path: (string | number)[]; message: string }> };
  };
}
interface ZodTypeLike {
  safeParse: (v: unknown) => {
    success: boolean;
    error?: { issues?: Array<{ path: (string | number)[]; message: string }> };
  };
}

/**
 * Valideert dat één specifieke NIEUWE key/value legaal is voor een bestaand
 * node-type. Gebruikt door setProp/setProps om te voorkomen dat bestaande
 * onbekende legacy-props (die al lang in de node.props zitten) elke nieuwe
 * geldige wijziging blokkeren. We valideren dus per NIEUWE key, niet de
 * gemergde node.props.
 */
function validateSingleProp(
  nodeType: string,
  propsSchema: ZodObjectLike,
  key: string,
  value: unknown,
):
  | { ok: true }
  | { ok: false; reason: 'unsupported-property'; message: string } {
  const shape = propsSchema.shape;
  if (!shape || !(key in shape)) {
    return {
      ok: false,
      reason: 'unsupported-property',
      message: `Eigenschap "${key}" wordt niet ondersteund door node-type "${nodeType}".`,
    };
  }
  const fieldSchema = shape[key]!;
  const r = fieldSchema.safeParse(value);
  if (!r.success) {
    const detail = r.error?.issues?.[0]?.message ?? 'ongeldige waarde';
    return {
      ok: false,
      reason: 'unsupported-property',
      message: `Waarde voor "${nodeType}.${key}" is ongeldig: ${detail}`,
    };
  }
  return { ok: true };
}

/**
 * Strikte validatie van een COMPLETE node-subtree — gebruikt voor nieuw
 * ingevoegde nodes (insertNode, addPage). Onbekend node-type of onbekende
 * prop-key → afwijzing. Legacy-tolerantie geldt alleen voor bestaande
 * node.props op reeds opgeslagen nodes, niet voor nieuw ingebrachte.
 */
function validateNewNodeStrict(
  node: NodeInstance,
  registry: NodeRegistry,
):
  | { ok: true }
  | {
      ok: false;
      reason: 'unsupported-property';
      message: string;
    } {
  const def = registry.lookup(node.type);
  if (!def) {
    return {
      ok: false,
      reason: 'unsupported-property',
      message: `Onbekend node-type in nieuwe node: "${node.type}".`,
    };
  }
  const propsSchema = def.propsSchema as unknown as ZodObjectLike;
  const strictSchema =
    typeof propsSchema.strict === 'function' ? propsSchema.strict() : propsSchema;
  const parseResult = strictSchema.safeParse(node.props ?? {});
  if (!parseResult.success) {
    const issue = parseResult.error?.issues?.[0];
    const path = issue?.path?.join('.') ?? '';
    const detail = issue?.message ?? 'onbekende reden';
    return {
      ok: false,
      reason: 'unsupported-property',
      message: path
        ? `Nieuwe node "${node.type}": eigenschap "${path}" ongeldig — ${detail}`
        : `Nieuwe node "${node.type}": ongeldige eigenschappen — ${detail}`,
    };
  }
  if (node.children) {
    for (const child of node.children) {
      const childResult = validateNewNodeStrict(child, registry);
      if (!childResult.ok) return childResult;
    }
  }
  return { ok: true };
}

/**
 * Sequentiële prevalidatie tegen een tussentijds kandidaat-document. Voor
 * meerstaps-patches als `[addPage, insertNode-in-that-page.root]` of
 * `[insertNode-x, setProp-on-x]` moet elke opvolgende op tegen de nieuwe
 * kandidaat-stand worden gecheckt — niet tegen `state.doc`, want de node
 * die je wilt raken bestaat daar nog niet.
 *
 * De WERKELIJKE store-mutatie gebeurt pas als deze functie voor ALLE ops
 * `ok:true` retourneert. Bij een fail: de store blijft ongewijzigd.
 * Immer's `produce()` (via applyPatch) maakt bij elke stap een structureel
 * gedeelde nieuwe copy, dus dit is puur functioneel en veroorzaakt geen
 * leak naar `state.doc`.
 */
function validateAndBuildCandidate(
  doc: DesignDoc,
  ops: PatchOp[],
  registry: NodeRegistry,
):
  | { ok: true; candidate: DesignDoc }
  | {
      ok: false;
      reason: 'invalid-patch' | 'unknown-node' | 'unsupported-property';
      message: string;
    } {
  let candidate = doc;
  for (const op of ops) {
    // 1. Op-specifieke prevalidatie tegen de HUIDIGE candidate-stand.
    switch (op.kind) {
      case 'setProp':
      case 'setProps':
      case 'setBind': {
        const node = findNodeInDoc(candidate, op.nodeId);
        if (!node) {
          return {
            ok: false,
            reason: 'unknown-node',
            message: `Node niet gevonden: ${op.nodeId}`,
          };
        }
        if (op.kind === 'setProp' || op.kind === 'setProps') {
          const def = registry.lookup(node.type);
          if (!def) {
            return {
              ok: false,
              reason: 'unsupported-property',
              message: `Node-type "${node.type}" heeft geen bekend props-schema.`,
            };
          }
          const propsSchema = def.propsSchema as unknown as ZodObjectLike;
          if (op.kind === 'setProp') {
            const r = validateSingleProp(node.type, propsSchema, op.key, op.value);
            if (!r.ok) return r;
          } else {
            for (const [k, v] of Object.entries(op.props)) {
              const r = validateSingleProp(node.type, propsSchema, k, v);
              if (!r.ok) return r;
            }
          }
        }
        break;
      }
      case 'insertNode': {
        // Nieuwe node → strikt volledig valideren.
        const r = validateNewNodeStrict(op.node, registry);
        if (!r.ok) return r;
        break;
      }
      case 'addPage': {
        // Nieuwe pagina → alle nodes in de subtree strikt valideren.
        const r = validateNewNodeStrict(op.page.root, registry);
        if (!r.ok) return r;
        break;
      }
      // Andere ops (reorderChildren / removeNode / setBrandToken /
      // removePage / renamePage / reorderPages) hebben geen prop-schema-check
      // — applyPatch gooit PatchError bij structurele fouten (unknown parent,
      // duplicate id, laatste pagina, order-mismatch). Vertaald door de
      // catch-tak hieronder naar `invalid-patch`.
      default:
        break;
    }

    // 2. Dry-run apply → candidate wordt de nieuwe stand voor de volgende op.
    try {
      candidate = applyPatch(candidate, op);
    } catch (e) {
      const message =
        e instanceof PatchError
          ? `Patch afgewezen: ${e.message}`
          : `Patch afgewezen: ${String(e)}`;
      return { ok: false, reason: 'invalid-patch', message };
    }
  }
  return { ok: true, candidate };
}

function scheduleSave(doc: DesignDoc, setState: (s: Partial<State>) => void) {
  if (!persistence) return;
  // Absorberend: eenmaal in lock-conflict tot rebase/reload — nooit doorvloeien
  // naar een nieuwe save met een stale lock_version.
  if (useDesignDocStore.getState().saveState === 'lock-conflict') return;
  if (saveTimer) clearTimeout(saveTimer);
  setState({ saveState: 'saving' });
  // Capture de HUIDIGE adapter-referentie. Als er tussen nu en het aflopen
  // van de debounce-timer een detachPersistence() of attachPersistence(other)
  // gebeurt, mag deze pending save NIET meer fires — anders schrijven we doc A
  // naar adapter B (data-lek tussen documenten). De closure-check onderaan
  // vangt dat: als `persistence !== captured`, skip de save-poging.
  const captured = persistence;
  saveTimer = setTimeout(async () => {
    if (persistence !== captured) return;
    try {
      await captured.save(doc.id, doc);
      if (persistence !== captured) return;
      if (versionSink) {
        const summary = versionSink(doc);
        setState({ saveState: 'saved', currentLockVersion: summary.version_number });
      } else {
        setState({ saveState: 'saved' });
      }
    } catch (e) {
      // Bij een fout in een STALE-adapter-save: negeer geluidloos. De fout
      // gaat over een oud document; de UI hoort daar niet meer op te reageren.
      if (persistence !== captured) return;
      if (isLockVersionMismatch(e)) {
        setState({
          saveState: 'lock-conflict',
          lastError: messageForRollbackError('lock_version_mismatch'),
        });
      } else {
        setState({ saveState: 'error', lastError: String(e) });
      }
    }
  }, 300);
}

export const useDesignDocStore = create<State & Actions>((set, get) => ({
  doc: {} as DesignDoc, // must be replaced by reset() before use
  stack: emptyStack(),
  variant: 'luxury',
  saveState: 'idle',
  currentLockVersion: 0,
  previewingVersion: null,
  isRestoring: false,

  applyOps(ops): ApplyResult {
    const state = get();
    if (!state.doc?.id) {
      return { ok: false, reason: 'invalid-patch', message: 'Geen actief document.' };
    }

    // Lege ops-array — kort-circuit no-op, geen save, geen state-mutatie.
    // Registry-check komt hierna: bij lege ops maakt het niet uit.
    if (ops.length === 0) {
      return { ok: true, changed: false, reason: 'no-op' };
    }

    // Registry fail-closed: zonder registry weten we niet welke keys legaal
    // zijn. In plaats van stilletjes de validatie over te slaan → expliciete
    // ApplyResult-fout, zodat de chat de gebruiker dat vertelt en er nooit
    // een succesmelding kan verschijnen voor iets dat ongevalideerd werd
    // opgeslagen. In productie hangt workspaceStore.openDocument hem;
    // tests moeten hem expliciet attachen via attachNodeRegistry.
    if (!nodeRegistry) {
      const message =
        'Interne configuratiefout: node-registry ontbreekt, wijziging kan niet worden gevalideerd.';
      set({ saveState: 'error', lastError: message });
      return { ok: false, reason: 'registry-missing', message };
    }

    // Sequentiële prevalidatie tegen kandidaat-document: bij
    // meerstaps-patches (bv. addPage gevolgd door insertNode in die
    // nieuwe page-root, of insertNode gevolgd door setProp op die nieuwe
    // node) moet elke opvolgende op tegen de TUSSENSTAND worden gecheckt.
    // De store zelf blijft ongewijzigd tot alle ops slagen.
    const validation = validateAndBuildCandidate(state.doc, ops, nodeRegistry);
    if (!validation.ok) {
      set({ saveState: 'error', lastError: validation.message });
      return validation;
    }

    const parsed = DesignDocSchema.safeParse(validation.candidate);
    if (!parsed.success) {
      const message = `Patch produceerde ongeldig document: ${parsed.error.issues[0]?.message ?? 'onbekend'}`;
      set({ saveState: 'error', lastError: message });
      return { ok: false, reason: 'schema-invalid', message };
    }

    const parsedDoc = parsed.data as DesignDoc;

    // No-op-detectie op basis van het werkelijke document vóór en na
    // toepassing (meta.updatedAt/updatedBy uitgezonderd — die bumpt
    // applyPatch onvoorwaardelijk). Levert geen state-mutatie op en dus
    // geen scheduleSave, geen nieuwe versie.
    if (docsEqualIgnoringMeta(state.doc, parsedDoc)) {
      return { ok: true, changed: false, reason: 'no-op' };
    }

    const paused = state.saveState === 'lock-conflict';
    set({
      doc: parsedDoc,
      stack: pushSnapshot(state.stack, state.doc),
      // In lock-conflict blijft de gepauzeerde state (+ NL-melding) staan
      // zodat de gebruiker mag doortypen zonder dat autosave opnieuw probeert.
      saveState: paused ? 'lock-conflict' : 'idle',
      lastError: paused ? state.lastError : undefined,
      // Actieve mutaties beëindigen automatisch een preview-modus.
      previewingVersion: null,
    });
    scheduleSave(parsedDoc, (s) => set(s));
    return { ok: true, changed: true };
  },

  beginStream() {
    // Re-entry: als er al een baseline hangt (bv. vorige stream is nooit
    // netjes gecommit/rollback'd) — reset expliciet. Anders zou een tweede
    // stream de eerste baseline weggooien zonder waarschuwing. Log het wel.
    if (streamBaseline !== null) {
      console.warn('[designDocStore] beginStream called while a previous stream was still active — discarding previous baseline');
    }
    streamBaseline = get().doc;
  },

  applyStreamOp(op): ApplyResult {
    const state = get();
    if (!state.doc?.id) {
      return { ok: false, reason: 'invalid-patch', message: 'Geen actief document.' };
    }
    // Fail-safe: zonder actieve stream is dit een no-op. Voorkomt dat een
    // stray callback na commit/rollback alsnog muteert.
    if (streamBaseline === null) {
      return { ok: true, changed: false, reason: 'no-op' };
    }
    if (!nodeRegistry) {
      const message =
        'Interne configuratiefout: node-registry ontbreekt, wijziging kan niet worden gevalideerd.';
      return { ok: false, reason: 'registry-missing', message };
    }

    // Zelfde prevalidatie als applyOps, maar voor één op tegen de huidige
    // (al mogelijk mid-stream-mutated) doc. Faalt de validatie → geen mutatie,
    // caller mag de rest van de stream gewoon door laten lopen.
    const validation = validateAndBuildCandidate(state.doc, [op], nodeRegistry);
    if (!validation.ok) {
      return validation;
    }
    const parsed = DesignDocSchema.safeParse(validation.candidate);
    if (!parsed.success) {
      const message = `Patch produceerde ongeldig document: ${parsed.error.issues[0]?.message ?? 'onbekend'}`;
      return { ok: false, reason: 'schema-invalid', message };
    }
    const parsedDoc = parsed.data as DesignDoc;

    if (docsEqualIgnoringMeta(state.doc, parsedDoc)) {
      return { ok: true, changed: false, reason: 'no-op' };
    }

    // GEEN pushSnapshot, GEEN scheduleSave — dat is de hele reden van deze
    // methode. Undo + save vindt plaats in commitStream, één keer per turn.
    // previewingVersion wél sluiten (mid-stream mutatie beëindigt preview-mode).
    set({ doc: parsedDoc, previewingVersion: null });
    return { ok: true, changed: true };
  },

  commitStream() {
    if (streamBaseline === null) {
      return { changed: false };
    }
    const state = get();
    const baseline = streamBaseline;
    streamBaseline = null;

    // Vergelijk baseline vs. huidige doc: als niks is toegepast, geen undo-
    // entry aanmaken en geen save triggeren (voorkomt lege undo-stappen).
    if (docsEqualIgnoringMeta(baseline, state.doc)) {
      return { changed: false };
    }

    // Push ÉÉN undo-snapshot met baseline als before-state — één undo-klik
    // rolt de hele stream-turn terug. Dan één scheduleSave voor het eind-doc.
    const paused = state.saveState === 'lock-conflict';
    set({
      stack: pushSnapshot(state.stack, baseline),
      saveState: paused ? 'lock-conflict' : 'idle',
      lastError: paused ? state.lastError : undefined,
    });
    scheduleSave(state.doc, (s) => set(s));
    return { changed: true };
  },

  rollbackStream() {
    if (streamBaseline === null) return;
    const baseline = streamBaseline;
    streamBaseline = null;
    // Herstel doc naar pre-stream-state. GEEN scheduleSave — backend heeft
    // baseline al (er is niks tijdens de stream gepersist), dus lokaal +
    // backend zijn nu weer consistent.
    set({ doc: baseline, previewingVersion: null });
  },

  select(nodeId) {
    set({ selectedNodeId: nodeId });
  },

  setVariant(v) {
    set({ variant: v });
  },

  undo() {
    const state = get();
    const res = undoStack(state.stack, state.doc);
    if (!res) return false;
    // saveState / lastError expres niet aangeraakt — een undo tijdens
    // lock-conflict houdt de gepauzeerde state intact (scheduleSave short-circuit).
    set({ doc: res.doc, stack: res.stack, previewingVersion: null });
    scheduleSave(res.doc, (s) => set(s));
    return true;
  },

  redo() {
    const state = get();
    const res = redoStack(state.stack, state.doc);
    if (!res) return false;
    set({ doc: res.doc, stack: res.stack, previewingVersion: null });
    scheduleSave(res.doc, (s) => set(s));
    return true;
  },

  reset(seed) {
    // Safety: als er nog een streaming-baseline hangt (bv. user opent een
    // ander document mid-stream), gooi 'm weg — de baseline hoort bij het
    // oude doc en zou een cross-doc rollback veroorzaken.
    streamBaseline = null;
    set({
      doc: seed,
      stack: emptyStack(),
      saveState: 'idle',
      lastError: undefined,
      currentLockVersion: 0,
      previewingVersion: null,
      isRestoring: false,
    });
  },

  previewVersion(v) {
    set({ previewingVersion: v });
  },

  stopPreviewingVersion() {
    set({ previewingVersion: null });
  },

  async restoreVersion(target) {
    if (!versionsAdapter) {
      return { ok: false, error: 'internal_error' };
    }
    const state = get();
    if (!state.doc?.id) {
      return { ok: false, error: 'internal_error' };
    }
    // Blokkeer double-submits + geef UI feedback.
    set({ isRestoring: true, lastError: undefined });
    let result: RollbackResult;
    try {
      result = await versionsAdapter.rollback(
        state.doc.id,
        target.version_number,
        state.currentLockVersion,
      );
    } catch {
      set({ isRestoring: false });
      return { ok: false, error: 'internal_error' };
    }
    if (!result.ok) {
      set({ isRestoring: false });
      return result;
    }
    // Success — vervang doc met teruggezette inhoud, bump lock_version,
    // sluit preview-modus. De HUIDIGE state is aan de backend-zijde in een
    // nieuwe versie bewaard door de rollback zelf (invariant migration 0010),
    // dus rollback zelf is later ook weer ongedaan te maken door naar die
    // voorgaande versie te herstellen.
    set({
      doc: target.doc,
      stack: pushSnapshot(state.stack, state.doc),
      currentLockVersion: result.new_lock_version,
      previewingVersion: null,
      saveState: 'saved',
      lastError: undefined,
      isRestoring: false,
    });
    // Spiegel naar de lokale persistentie — géén nieuwe version-record hiervoor;
    // dat heeft de adapter.rollback zelf al gedaan (of doet de save-RPC in productie).
    if (persistence) {
      persistence.save(target.doc.id, target.doc).catch(() => {
        /* mirror-only; niet fatal */
      });
    }
    return result;
  },
}));
