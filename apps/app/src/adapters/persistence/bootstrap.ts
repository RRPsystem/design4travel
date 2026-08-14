import type { SupabaseClient } from '@supabase/supabase-js';
import { DesignDocSchema, SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { invokeEdge } from '../supabase/invoke.js';

export type BootstrapFailureReason =
  | 'auth_required'
  | 'no_active_organization'
  | 'multiple_active_organizations'
  | 'internal_error';

export interface BootstrapOrg {
  organization_id: string;
  name: string;
}

export type BootstrapResult =
  | {
      ok: true;
      projectId: string;
      projectDocumentId: string;
      doc: DesignDoc;
      lockVersion: number;
    }
  | {
      ok: false;
      reason: BootstrapFailureReason;
      organizations?: BootstrapOrg[];
      detail?: string;
    };

interface BootstrapOptions {
  client: SupabaseClient;
  seedDoc: DesignDoc;
  documentName?: string;
}

interface CreateResponse {
  project_id: string;
  project_document_id: string;
  lock_version: number;
}

/**
 * Voert de eerste-load-bootstrap uit voor een ingelogde user:
 *
 *   1. Verifieer sessie.
 *   2. Vind de actieve organizations-memberships (RLS-filter houdt dit tot de
 *      user zelf beperkt). Precies één = automatisch, anders expliciete keuze
 *      vereist / geen org = fout.
 *   3. Roep de `create-project-document` Edge Function aan (idempotent — twee
 *      tabs krijgen dezelfde IDs).
 *   4. Laad de daadwerkelijke doc-inhoud uit `project_documents`; herschrijf
 *      `doc.id` naar de returned UUID zodat de rest van de app op één ID rekent.
 */
export async function bootstrapDocument(
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const { client, seedDoc } = opts;

  const sessionRes = await client.auth.getSession();
  const session = sessionRes.data?.session;
  if (!session || !session.user) {
    return { ok: false, reason: 'auth_required' };
  }

  const membersRes = await client
    .from('organization_members')
    .select('organization_id, organizations!inner(id, name, deleted_at)')
    .is('deleted_at', null)
    .is('organizations.deleted_at', null);

  if (membersRes.error) {
    return { ok: false, reason: 'internal_error', detail: membersRes.error.message };
  }

  // Supabase-js typet joined records generiek als array — bij een many-to-one
  // FK is dat feitelijk 0 of 1 rij. We accepteren beide vormen en pikken de
  // eerste (enige) hit eruit.
  type JoinedOrg = { id: string; name: string; deleted_at: string | null };
  type MemberRow = {
    organization_id: string;
    organizations: JoinedOrg | JoinedOrg[] | null;
  };
  const rows = (membersRes.data ?? []) as unknown as MemberRow[];
  const orgs: BootstrapOrg[] = rows
    .map((r) => {
      const joined = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
      if (!joined) return null;
      return { organization_id: r.organization_id, name: joined.name };
    })
    .filter((v): v is BootstrapOrg => v !== null);

  if (orgs.length === 0) {
    return { ok: false, reason: 'no_active_organization' };
  }
  if (orgs.length > 1) {
    return {
      ok: false,
      reason: 'multiple_active_organizations',
      organizations: orgs,
    };
  }

  const activeOrg = orgs[0]!;

  const documentName = opts.documentName ?? 'Nieuw ontwerp';
  const documentType = seedDoc.project.documentType;

  const createRes = await invokeEdge<CreateResponse>(
    client,
    'create-project-document',
    {
      organization_id: activeOrg.organization_id,
      name: documentName,
      document_type: documentType,
      schema_version: SCHEMA_VERSION,
      seed_doc: seedDoc,
    },
  );

  if (!createRes.ok) {
    return {
      ok: false,
      reason: 'internal_error',
      detail: `create-project-document: status=${createRes.status} code=${createRes.code ?? '-'}`,
    };
  }

  const created = createRes.data;
  if (
    !created ||
    typeof created.project_id !== 'string' ||
    typeof created.project_document_id !== 'string' ||
    typeof created.lock_version !== 'number'
  ) {
    return { ok: false, reason: 'internal_error', detail: 'invalid_create_response' };
  }

  const docRes = await client
    .from('project_documents')
    .select('doc')
    .eq('id', created.project_document_id)
    .maybeSingle();

  if (docRes.error) {
    return { ok: false, reason: 'internal_error', detail: docRes.error.message };
  }
  if (!docRes.data) {
    return { ok: false, reason: 'internal_error', detail: 'document_row_missing' };
  }

  const rawDoc = (docRes.data as { doc: unknown }).doc;
  // De persisted doc heeft nog de seed-.id ('seed-landing' of iets vergelijkbaars).
  // Herschrijf naar de daadwerkelijke UUID zodat load/save consistent zijn en
  // de designDocStore één ID gebruikt.
  const normalized =
    rawDoc && typeof rawDoc === 'object'
      ? { ...(rawDoc as Record<string, unknown>), id: created.project_document_id }
      : rawDoc;
  const parsed = DesignDocSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'internal_error',
      detail: `doc_schema_invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    };
  }

  return {
    ok: true,
    projectId: created.project_id,
    projectDocumentId: created.project_document_id,
    doc: parsed.data as DesignDoc,
    lockVersion: created.lock_version,
  };
}
