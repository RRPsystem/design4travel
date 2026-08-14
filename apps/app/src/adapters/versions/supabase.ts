import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DesignDocSchema,
  type DesignDoc,
  type RollbackErrorCode,
  type RollbackResult,
  type VersionHistoryAdapter,
  type VersionSnapshot,
  type VersionSummary,
} from '@design4/design-doc';
import { invokeEdge } from '../supabase/invoke.js';

interface SupabaseVersionHistoryOptions {
  client: SupabaseClient;
  /** Aangeroepen na succesvolle rollback met de returned new_lock_version. */
  onLockVersionUpdate: (newLockVersion: number) => void;
}

interface RollbackSuccessBody {
  new_lock_version: number;
  new_version_number: number;
}

// Alle bekende publieke rollback-codes. Onbekende → 'internal_error'.
const ROLLBACK_CODES: ReadonlySet<RollbackErrorCode> = new Set<RollbackErrorCode>([
  'invalid_json',
  'invalid_request',
  'missing_authorization',
  'invalid_user_token',
  'method_not_allowed',
  'insufficient_role',
  'membership_not_active',
  'not_found',
  'target_version_not_found',
  'organization_not_active',
  'project_not_active',
  'lock_version_mismatch',
  'target_schema_version_incompatible',
  'payload_too_large',
  'internal_error',
]);

function toRollbackCode(code: string | undefined): RollbackErrorCode {
  if (code && ROLLBACK_CODES.has(code as RollbackErrorCode)) {
    return code as RollbackErrorCode;
  }
  return 'internal_error';
}

/**
 * Supabase-backed VersionHistoryAdapter.
 * - list/get lopen direct via RLS-select op `project_document_versions` (leeg-resultaat
 *   op onbekende ID is de RLS-invulling, geen expliciete `not_found`).
 * - rollback loopt via de bestaande `rollback-document` Edge Function (A3.2).
 */
export function createSupabaseVersionHistoryAdapter(
  opts: SupabaseVersionHistoryOptions,
): VersionHistoryAdapter {
  const { client, onLockVersionUpdate } = opts;

  return {
    async list(projectDocumentId) {
      // `author_label` staat WEL in de mock + het VersionSummary-interface
      // (optioneel), maar NIET in de daadwerkelijke DB-tabel — die heeft
      // alleen author_id + author_note. Selecteren zou 42703 geven.
      const { data, error } = await client
        .from('project_document_versions')
        .select('version_number, created_at, author_id, author_note')
        .eq('project_document_id', projectDocumentId)
        .order('version_number', { ascending: false });
      if (error) {
        throw new Error(`versions.list failed: ${error.message}`);
      }
      const rows = (data ?? []) as Array<{
        version_number: number;
        created_at: string;
        author_id: string | null;
        author_note: string | null;
      }>;
      return rows.map<VersionSummary>((r) => ({
        version_number: r.version_number,
        created_at: r.created_at,
        ...(r.author_id !== null ? { author_id: r.author_id } : {}),
        ...(r.author_note !== null ? { author_note: r.author_note } : {}),
      }));
    },

    async get(projectDocumentId, versionNumber) {
      const { data, error } = await client
        .from('project_document_versions')
        .select('version_number, created_at, author_id, author_note, doc')
        .eq('project_document_id', projectDocumentId)
        .eq('version_number', versionNumber)
        .maybeSingle();
      if (error) {
        throw new Error(`versions.get failed: ${error.message}`);
      }
      if (!data) return null;
      const row = data as {
        version_number: number;
        created_at: string;
        author_id: string | null;
        author_note: string | null;
        doc: unknown;
      };
      const rawDoc = row.doc;
      const normalized =
        rawDoc && typeof rawDoc === 'object'
          ? { ...(rawDoc as Record<string, unknown>), id: projectDocumentId }
          : rawDoc;
      const parsed = DesignDocSchema.safeParse(normalized);
      if (!parsed.success) {
        throw new Error(
          `versions.get: doc failed schema validation (${parsed.error.issues[0]?.message ?? 'unknown'})`,
        );
      }
      const snap: VersionSnapshot = {
        version_number: row.version_number,
        created_at: row.created_at,
        doc: parsed.data as DesignDoc,
        ...(row.author_id !== null ? { author_id: row.author_id } : {}),
        ...(row.author_note !== null ? { author_note: row.author_note } : {}),
      };
      return snap;
    },

    async rollback(projectDocumentId, targetVersionNumber, expectedLockVersion): Promise<RollbackResult> {
      const res = await invokeEdge<RollbackSuccessBody>(
        client,
        'rollback-document',
        {
          project_document_id: projectDocumentId,
          target_version_number: targetVersionNumber,
          expected_lock_version: expectedLockVersion,
        },
      );
      if (!res.ok) {
        return { ok: false, error: toRollbackCode(res.code) };
      }
      const body = res.data;
      if (
        typeof body.new_lock_version !== 'number' ||
        typeof body.new_version_number !== 'number'
      ) {
        return { ok: false, error: 'internal_error' };
      }
      onLockVersionUpdate(body.new_lock_version);
      return {
        ok: true,
        new_lock_version: body.new_lock_version,
        new_version_number: body.new_version_number,
      };
    },
  };
}
