import type { DesignDoc } from './schema.js';

/**
 * Central definition. Both the app-adapter (localStorage) and any future
 * Supabase adapter implement this interface.
 */
export interface PersistenceAdapter {
  load(docId: string): Promise<DesignDoc | null>;
  save(docId: string, doc: DesignDoc): Promise<void>;
  delete(docId: string): Promise<void>;
}

/** No-op adapter — useful as default when nothing is wired up yet. */
export const noopPersistence: PersistenceAdapter = {
  async load() {
    return null;
  },
  async save() {},
  async delete() {},
};
