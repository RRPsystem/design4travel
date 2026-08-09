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
} from '@design4/design-doc';
import type { PersistenceAdapter } from '@design4/design-doc';
import type { SampleDataVariant } from '@design4/data-bindings';

type State = {
  doc: DesignDoc;
  stack: UndoStack;
  selectedNodeId?: string;
  variant: SampleDataVariant;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  lastError?: string;
};

type Actions = {
  applyOps(ops: PatchOp[]): void;
  select(nodeId?: string): void;
  setVariant(v: SampleDataVariant): void;
  undo(): boolean;
  redo(): boolean;
  reset(seed: DesignDoc): void;
};

let persistence: PersistenceAdapter | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function attachPersistence(adapter: PersistenceAdapter) {
  persistence = adapter;
}

function scheduleSave(doc: DesignDoc, setState: (s: Partial<State>) => void) {
  if (!persistence) return;
  if (saveTimer) clearTimeout(saveTimer);
  setState({ saveState: 'saving' });
  saveTimer = setTimeout(async () => {
    try {
      await persistence!.save(doc.id, doc);
      setState({ saveState: 'saved' });
    } catch (e) {
      setState({ saveState: 'error', lastError: String(e) });
    }
  }, 300);
}

export const useDesignDocStore = create<State & Actions>((set, get) => ({
  doc: {} as DesignDoc, // must be replaced by reset() before use
  stack: emptyStack(),
  variant: 'luxury',
  saveState: 'idle',

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
    set({
      doc: parsed.data as DesignDoc,
      stack: pushSnapshot(state.stack, state.doc),
      saveState: 'idle',
      lastError: undefined,
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
    set({ doc: res.doc, stack: res.stack });
    scheduleSave(res.doc, (s) => set(s));
    return true;
  },

  redo() {
    const state = get();
    const res = redoStack(state.stack, state.doc);
    if (!res) return false;
    set({ doc: res.doc, stack: res.stack });
    scheduleSave(res.doc, (s) => set(s));
    return true;
  },

  reset(seed) {
    set({ doc: seed, stack: emptyStack(), saveState: 'idle', lastError: undefined });
  },
}));
