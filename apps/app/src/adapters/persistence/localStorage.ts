import {
  DesignDocSchema,
  type DesignDoc,
  type PersistenceAdapter,
} from '@design4/design-doc';

const KEY_PREFIX = 'design4:doc:';

export const localStoragePersistence: PersistenceAdapter = {
  async load(docId) {
    try {
      const raw = window.localStorage.getItem(KEY_PREFIX + docId);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const validated = DesignDocSchema.safeParse(parsed);
      if (!validated.success) {
        console.warn('[persistence] stored doc failed validation, discarding', validated.error);
        return null;
      }
      return validated.data as DesignDoc;
    } catch (e) {
      console.warn('[persistence] load failed', e);
      return null;
    }
  },
  async save(docId, doc) {
    try {
      window.localStorage.setItem(KEY_PREFIX + docId, JSON.stringify(doc));
    } catch (e) {
      console.warn('[persistence] save failed', e);
    }
  },
  async delete(docId) {
    window.localStorage.removeItem(KEY_PREFIX + docId);
  },
};
