import { create } from 'zustand';
import {
  applyPatches,
  DesignDocSchema,
  emptyStack,
  pushSnapshot,
  redo as redoStack,
  undo as undoStack,
  type DesignDoc,
  type PatchOp,
  type UndoStack,
  type VersionHistoryAdapter,
  type VersionSnapshot,
  type VersionSummary,
  type RollbackResult,
} from '@design4/design-doc';
import type { PersistenceAdapter } from '@design4/design-doc';
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
  applyOps(ops: PatchOp[]): void;
  select(nodeId?: string): void;
  setVariant(v: SampleDataVariant): void;
  undo(): boolean;
  redo(): boolean;
  reset(seed: DesignDoc): void;
  previewVersion(v: VersionSnapshot): void;
  stopPreviewingVersion(): void;
  restoreVersion(v: VersionSnapshot): Promise<RollbackResult>;
};

let persistence: PersistenceAdapter | null = null;
let versionsAdapter: VersionHistoryAdapter | null = null;
let versionSink: ((doc: DesignDoc) => VersionSummary) | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

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

  applyOps(ops) {
    const state = get();
    if (!state.doc?.id) return;
    let next: DesignDoc;
    try {
      next = applyPatches(state.doc, ops);
    } catch (e) {
      set({ saveState: 'error', lastError: String(e) });
      return;
    }
    const parsed = DesignDocSchema.safeParse(next);
    if (!parsed.success) {
      set({
        saveState: 'error',
        lastError: `Patch produceerde ongeldig document: ${parsed.error.issues[0]?.message ?? 'onbekend'}`,
      });
      return;
    }
    const paused = state.saveState === 'lock-conflict';
    set({
      doc: parsed.data as DesignDoc,
      stack: pushSnapshot(state.stack, state.doc),
      // In lock-conflict blijft de gepauzeerde state (+ NL-melding) staan
      // zodat de gebruiker mag doortypen zonder dat autosave opnieuw probeert.
      saveState: paused ? 'lock-conflict' : 'idle',
      lastError: paused ? state.lastError : undefined,
      // Actieve mutaties beëindigen automatisch een preview-modus.
      previewingVersion: null,
    });
    scheduleSave(parsed.data as DesignDoc, (s) => set(s));
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
