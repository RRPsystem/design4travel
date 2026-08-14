import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DesignDocSchema,
  type DesignDoc,
  type PersistenceAdapter,
} from '@design4/design-doc';
import { invokeEdge } from '../supabase/invoke.js';

/**
 * Typed error die de designDocStore opvangt om over te gaan naar de
 * absorberende `saveState: 'lock-conflict'` en autosave te pauzeren.
 * De 409 komt uit `save-document` (SQLSTATE 55P03) en betekent dat een
 * andere client de doc-inhoud heeft bijgewerkt sinds onze laatste read.
 * Reload/rebase is aparte scope — we behouden de in-memory doc.
 */
export class LockVersionMismatchError extends Error {
  readonly code = 'lock_version_mismatch' as const;
  constructor() {
    super('lock_version_mismatch');
    this.name = 'LockVersionMismatchError';
  }
}

export function isLockVersionMismatch(e: unknown): e is LockVersionMismatchError {
  return (
    e instanceof LockVersionMismatchError ||
    (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'lock_version_mismatch')
  );
}

interface SupabasePersistenceOptions {
  client: SupabaseClient;
  /** UUID uit bootstrap — save-document schrijft per project, niet per doc. */
  projectId: string;
  /** Schema-versie zoals aan de backend vastgehouden — meestal SCHEMA_VERSION. */
  schemaVersion: string;
  /** Leeft in designDocStore. Wordt vlak voor iedere save uitgelezen. */
  getExpectedLockVersion: () => number;
  /** Aangeroepen na succesvolle save met de returned new_lock_version. */
  onLockVersionUpdate: (newLockVersion: number) => void;
}

interface SaveResponse {
  new_lock_version: number;
}

export function createSupabasePersistenceAdapter(
  opts: SupabasePersistenceOptions,
): PersistenceAdapter {
  const { client, projectId, schemaVersion, getExpectedLockVersion, onLockVersionUpdate } =
    opts;

  return {
    async load(docId) {
      const { data, error } = await client
        .from('project_documents')
        .select('doc')
        .eq('id', docId)
        .maybeSingle();
      if (error) {
        throw new Error(`persistence.load failed: ${error.message}`);
      }
      if (!data) return null;
      const raw = (data as { doc: unknown }).doc;
      const normalized =
        raw && typeof raw === 'object'
          ? { ...(raw as Record<string, unknown>), id: docId }
          : raw;
      const parsed = DesignDocSchema.safeParse(normalized);
      if (!parsed.success) {
        console.warn('[persistence.load] doc failed schema validation', parsed.error);
        return null;
      }
      return parsed.data as DesignDoc;
    },

    async save(_docId, doc) {
      const expected = getExpectedLockVersion();
      const res = await invokeEdge<SaveResponse>(client, 'save-document', {
        project_id: projectId,
        doc,
        schema_version: schemaVersion,
        expected_lock_version: expected,
      });

      if (!res.ok) {
        if (res.status === 409 && res.code === 'lock_version_mismatch') {
          throw new LockVersionMismatchError();
        }
        throw new Error(
          `save-document failed: status=${res.status} code=${res.code ?? '-'}`,
        );
      }

      const newLock = res.data.new_lock_version;
      if (typeof newLock !== 'number' || !Number.isFinite(newLock) || newLock < 1) {
        throw new Error('save-document response missing new_lock_version');
      }
      onLockVersionUpdate(newLock);
    },

    async delete() {
      // Bewust niet geïmplementeerd — er is nog geen delete-Edge-Function en
      // de app roept delete() vandaag nergens aan. Als delete later nodig is,
      // komt daar een aparte RPC + Edge Function voor.
      throw new Error(
        'SupabasePersistenceAdapter.delete is not implemented — no delete flow shipped yet',
      );
    },
  };
}
