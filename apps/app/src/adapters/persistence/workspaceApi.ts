import type { SupabaseClient } from '@supabase/supabase-js';
import { DesignDocSchema, type DesignDoc } from '@design4/design-doc';
import { invokeEdge } from '../supabase/invoke.js';

/**
 * Workspace-level Supabase-toegang: project-lijst, doc-lijst, project-lifecycle,
 * document-creatie. Alle acties hier zijn STATE-arm; ze doen één RPC/query en
 * geven het resultaat terug. State-management gebeurt in useWorkspaceStore.
 *
 * Ontwerpprincipes:
 * - Reads via `client.from(...)` onder RLS.
 * - Writes via `client.rpc(...)` (authenticated-granted RPCs uit migraties
 *   0005 en 0016) of via Edge Function (`client.functions.invoke(...)`) voor
 *   RPCs die service-role vereisen (create_document, create-project-with-
 *   document).
 * - Return-shape: uniform `{ok: true, data} | {ok: false, error}` zodat de
 *   store zonder try/catch kan werken.
 */

export interface Project {
  id: string;
  name: string;
  description: string | null;
  document_type: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ProjectDocument {
  id: string;
  project_id: string;
  document_type: string;
  title: string;
  lock_version: number;
  updated_at: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

// -----------------------------------------------------------------------------
// Actieve organisatie bepalen
// -----------------------------------------------------------------------------

export interface ActiveOrg {
  organization_id: string;
  name: string;
}

/**
 * Bepaal de actieve organisatie van de user. Hergebruikt de bestaande logica
 * uit bootstrap.ts (voor het geval één actieve org bestaat). Voor multi-org
 * (later) komt hier een keuze-UI bovenop; voor nu: hard error op >1.
 */
export async function loadActiveOrgs(
  client: SupabaseClient,
): Promise<ApiResult<ActiveOrg[]>> {
  const { data, error } = await client
    .from('organization_members')
    .select('organization_id, organizations!inner(id, name, deleted_at)')
    .is('deleted_at', null)
    .is('organizations.deleted_at', null);
  if (error) return { ok: false, error: error.message };
  type JoinedOrg = { id: string; name: string; deleted_at: string | null };
  type Row = { organization_id: string; organizations: JoinedOrg | JoinedOrg[] | null };
  const rows = (data ?? []) as unknown as Row[];
  const orgs: ActiveOrg[] = rows
    .map((r) => {
      const joined = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
      if (!joined) return null;
      return { organization_id: r.organization_id, name: joined.name };
    })
    .filter((v): v is ActiveOrg => v !== null);
  return { ok: true, data: orgs };
}

// -----------------------------------------------------------------------------
// Projects
// -----------------------------------------------------------------------------

/**
 * Alle zichtbare projecten (via RLS). Deleted_at is null = actief; niet-null =
 * gearchiveerd. Beide worden opgehaald; het dashboard filtert per sectie.
 */
export async function loadProjects(
  client: SupabaseClient,
): Promise<ApiResult<Project[]>> {
  const { data, error } = await client
    .from('projects')
    .select('id, name, description, document_type, created_at, updated_at, deleted_at')
    .order('updated_at', { ascending: false });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as Project[] };
}

export async function loadProject(
  client: SupabaseClient,
  projectId: string,
): Promise<ApiResult<Project | null>> {
  const { data, error } = await client
    .from('projects')
    .select('id, name, description, document_type, created_at, updated_at, deleted_at')
    .eq('id', projectId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data as Project | null) ?? null };
}

// -----------------------------------------------------------------------------
// Project-documents
// -----------------------------------------------------------------------------

export async function loadProjectDocuments(
  client: SupabaseClient,
  projectId: string,
): Promise<ApiResult<ProjectDocument[]>> {
  const { data, error } = await client
    .from('project_documents')
    .select('id, project_id, document_type, title, lock_version, updated_at')
    .eq('project_id', projectId)
    .order('updated_at', { ascending: false });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as ProjectDocument[] };
}

/**
 * Laad het volledige document (met doc-JSON + lock_version) voor de editor.
 * Herschrijft doc.id naar de UUID zodat de rest van de app op één ID rekent
 * (zelfde patroon als bootstrap.ts).
 */
export interface LoadedDocument {
  project_id: string;
  document_id: string;
  document_type: string;
  title: string;
  lock_version: number;
  doc: DesignDoc;
}

export async function loadDocument(
  client: SupabaseClient,
  documentId: string,
): Promise<ApiResult<LoadedDocument | null>> {
  const { data, error } = await client
    .from('project_documents')
    .select('id, project_id, document_type, title, lock_version, doc')
    .eq('id', documentId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: true, data: null };
  const row = data as {
    id: string;
    project_id: string;
    document_type: string;
    title: string;
    lock_version: number;
    doc: unknown;
  };
  const rawDoc = row.doc;
  const normalized =
    rawDoc && typeof rawDoc === 'object'
      ? { ...(rawDoc as Record<string, unknown>), id: row.id }
      : rawDoc;
  const parsed = DesignDocSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false,
      error: `document_schema_invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  return {
    ok: true,
    data: {
      project_id: row.project_id,
      document_id: row.id,
      document_type: row.document_type,
      title: row.title,
      lock_version: row.lock_version,
      doc: parsed.data as DesignDoc,
    },
  };
}

// -----------------------------------------------------------------------------
// Project-lifecycle (create / rename / duplicate / archive / restore)
// -----------------------------------------------------------------------------

/**
 * Atomische creatie van project + eerste document via de nieuwe Edge Function
 * (migratie 0017). Één transactie in Postgres — bij fout in doc-insert rolt
 * ook de project-insert terug. Geen dangling projecten meer.
 */
export interface CreateProjectInput {
  organization_id: string;
  project_name: string;
  project_description?: string | null;
  first_document_type: string;
  first_document_title: string;
  seed_doc: DesignDoc;
  schema_version: string;
}

export async function createProjectWithFirstDocument(
  client: SupabaseClient,
  input: CreateProjectInput,
): Promise<ApiResult<{ project_id: string; project_document_id: string; lock_version: number }>> {
  const res = await invokeEdge<{
    project_id: string;
    project_document_id: string;
    lock_version: number;
  }>(client, 'create-project-with-document', {
    organization_id: input.organization_id,
    project_name: input.project_name,
    project_description: input.project_description ?? null,
    first_document_type: input.first_document_type,
    first_document_title: input.first_document_title,
    seed_doc: input.seed_doc,
    schema_version: input.schema_version,
  });
  if (!res.ok) {
    return {
      ok: false,
      error: res.code ?? `http_${res.status}`,
    };
  }
  return { ok: true, data: res.data };
}

/**
 * Nieuw document binnen een BESTAAND project (via create-document Edge
 * Function, migratie 0016). Voor "+ Nieuw document"-knop in project-view.
 */
export interface CreateDocumentInput {
  project_id: string;
  document_type: string;
  title: string;
  seed_doc: DesignDoc;
  schema_version: string;
}

export async function createDocumentInProject(
  client: SupabaseClient,
  input: CreateDocumentInput,
): Promise<ApiResult<{ project_document_id: string; lock_version: number }>> {
  const res = await invokeEdge<{ project_document_id: string; lock_version: number }>(
    client,
    'create-document',
    input as unknown as Record<string, unknown>,
  );
  if (!res.ok) {
    return { ok: false, error: res.code ?? `http_${res.status}` };
  }
  return { ok: true, data: res.data };
}

/**
 * Rename via directe UPDATE onder RLS. Migratie 0004 grant't
 * `update (name, description, document_type) on projects to authenticated`
 * zolang de user editor+ is (checked door de update-policy).
 */
export async function renameProject(
  client: SupabaseClient,
  projectId: string,
  newName: string,
): Promise<ApiResult<null>> {
  const { error } = await client
    .from('projects')
    .update({ name: newName })
    .eq('id', projectId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: null };
}

export async function duplicateProject(
  client: SupabaseClient,
  sourceProjectId: string,
  newName: string,
): Promise<ApiResult<{ new_project_id: string }>> {
  const { data, error } = await client.rpc('duplicate_project', {
    p_source_project_id: sourceProjectId,
    p_new_name: newName,
  });
  if (error) return { ok: false, error: error.message };
  if (typeof data !== 'string') return { ok: false, error: 'malformed_response' };
  return { ok: true, data: { new_project_id: data } };
}

export async function archiveProject(
  client: SupabaseClient,
  projectId: string,
): Promise<ApiResult<null>> {
  const { error } = await client.rpc('soft_delete_project', { p_project_id: projectId });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: null };
}

export async function restoreProject(
  client: SupabaseClient,
  projectId: string,
): Promise<ApiResult<null>> {
  const { error } = await client.rpc('restore_project', { p_project_id: projectId });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: null };
}
