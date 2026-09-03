import { create } from 'zustand';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { supabase, supabaseAnonKey, supabaseUrl } from '../adapters/supabase/client.js';
import {
  attachNodeRegistry,
  attachPersistence,
  attachVersions,
  detachNodeRegistry,
  detachPersistence,
  detachVersions,
  useDesignDocStore,
} from './designDocStore.js';
import { createDefaultRegistry } from '@design4/typed-nodes';
import { createSupabasePersistenceAdapter } from '../adapters/persistence/supabase.js';
import { createSupabaseVersionHistoryAdapter } from '../adapters/versions/supabase.js';
import { ClaudeAIAdapter } from '../adapters/ai/claudeAI.js';
import { attachAI, resetAI } from '../adapters/ai/registry.js';
import { seedLandingPage } from '../seed/mockLandingPage.js';
import { seedFromTravelContent } from '../features/workspace/seedFromTravelContent.js';
import { resolveContentSource } from '../adapters/persistence/contentSourceApi.js';
import {
  archiveProject,
  createDocumentInProject,
  createProjectWithFirstDocument,
  duplicateProject,
  loadActiveOrgs,
  loadDocument,
  loadProjectDocuments,
  loadProjects,
  renameProject,
  restoreProject,
  type ActiveOrg,
  type ApiResult,
  type Project,
  type ProjectDocument,
} from '../adapters/persistence/workspaceApi.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Bouw een seed-DesignDoc voor een gegeven document-type. Voor MVP gebruiken
 * we hetzelfde landing-page-seed voor alle types, maar met `documentType`
 * correct gezet. Per-type-seeds (offerte-template, roadbook-layout etc.)
 * komen later.
 */
export function seedForType(documentType: string): DesignDoc {
  const seed = seedLandingPage();
  return {
    ...seed,
    project: {
      ...seed.project,
      documentType: documentType as DesignDoc['project']['documentType'],
    },
  };
}

// -----------------------------------------------------------------------------
// Store shape
// -----------------------------------------------------------------------------

type WorkspaceStatus =
  | 'idle'                     // net gemount, nog niks geladen
  | 'loading-orgs'
  | 'loading-projects'
  | 'ready'                    // projecten geladen
  | 'error';

export type State = {
  status: WorkspaceStatus;
  errorMessage: string | null;

  activeOrgId: string | null;
  activeOrgName: string | null;
  activeOrgs: ActiveOrg[];        // volledige lijst (voor future org-picker)

  projects: Project[];             // alles (active + archived); UI filtert.

  /** Currently open project (for project-view). null als in dashboard. */
  activeProjectId: string | null;
  documents: ProjectDocument[];    // documenten binnen actieveProject

  /** Currently open document (for editor). null als niet in editor. */
  activeDocumentId: string | null;
  activeDocumentTitle: string | null;
  activeProjectName: string | null;

  /** Fine-grained loading-states voor UI. */
  documentsLoading: boolean;
  documentOpenLoading: boolean;
};

type Actions = {
  /** Init: laad orgs → laad projects. Roepen bij App-mount na sign-in. */
  init(): Promise<void>;
  refreshProjects(): Promise<void>;
  openProject(projectId: string): Promise<ApiResult<ProjectDocument[]>>;
  closeProject(): void;
  openDocument(documentId: string): Promise<ApiResult<null>>;
  closeDocument(): void;
  createProjectWithDocument(input: {
    project_name: string;
    project_description?: string | null;
    first_document_type: string;
    first_document_title: string;
    /**
     * Optioneel: koppel een content-bron aan het nieuwe document. Wordt eerst
     * resolved via `resolve-content-source`; bij succes bouwt de store een
     * deterministische seed-page uit de TravelContent (zie
     * seedFromTravelContent) en zet `project.contentSourceId` in de doc. Bij
     * fout krijgt de user een error-code terug en wordt het project NIET
     * aangemaakt (fail-early).
     */
    content_source?: { kind: 'fixture'; source_id: string };
  }): Promise<ApiResult<{ project_id: string; project_document_id: string }>>;
  createDocumentInProject(input: {
    project_id: string;
    document_type: string;
    title: string;
  }): Promise<ApiResult<{ project_document_id: string }>>;
  renameProject(projectId: string, newName: string): Promise<ApiResult<null>>;
  duplicateProject(sourceId: string, newName: string): Promise<ApiResult<{ new_project_id: string }>>;
  archiveProject(projectId: string): Promise<ApiResult<null>>;
  restoreProject(projectId: string): Promise<ApiResult<null>>;
};

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

const initialState: State = {
  status: 'idle',
  errorMessage: null,
  activeOrgId: null,
  activeOrgName: null,
  activeOrgs: [],
  projects: [],
  activeProjectId: null,
  documents: [],
  activeDocumentId: null,
  activeDocumentTitle: null,
  activeProjectName: null,
  documentsLoading: false,
  documentOpenLoading: false,
};

export const useWorkspaceStore = create<State & Actions>((set, get) => ({
  ...initialState,

  async init() {
    set({ status: 'loading-orgs', errorMessage: null });
    const orgs = await loadActiveOrgs(supabase);
    if (!orgs.ok) {
      set({ status: 'error', errorMessage: orgs.error });
      return;
    }
    if (orgs.data.length === 0) {
      set({
        status: 'error',
        errorMessage: 'no_active_organization',
        activeOrgs: [],
      });
      return;
    }
    // Voor MVP: pak de eerste actieve org. Multi-org picker later.
    const first = orgs.data[0]!;
    set({
      activeOrgs: orgs.data,
      activeOrgId: first.organization_id,
      activeOrgName: first.name,
    });
    await get().refreshProjects();
  },

  async refreshProjects() {
    set({ status: 'loading-projects' });
    const res = await loadProjects(supabase);
    if (!res.ok) {
      set({ status: 'error', errorMessage: res.error });
      return;
    }
    set({ projects: res.data, status: 'ready', errorMessage: null });
  },

  async openProject(projectId) {
    set({ documentsLoading: true, activeProjectId: projectId });
    const res = await loadProjectDocuments(supabase, projectId);
    if (!res.ok) {
      set({ documentsLoading: false });
      return { ok: false, error: res.error };
    }
    const project = get().projects.find((p) => p.id === projectId);
    set({
      documents: res.data,
      documentsLoading: false,
      activeProjectName: project?.name ?? null,
    });
    return { ok: true, data: res.data };
  },

  closeProject() {
    // Alleen closing van project — als een document nog open is, wordt dat
    // ELDERS gesloten (closeDocument). We houden de closeProject strak op
    // project-scope om cascading side-effects te vermijden.
    set({
      activeProjectId: null,
      activeProjectName: null,
      documents: [],
    });
  },

  async openDocument(documentId) {
    set({ documentOpenLoading: true });

    // 1. Load doc from Supabase (RLS-scoped).
    const res = await loadDocument(supabase, documentId);
    if (!res.ok) {
      set({ documentOpenLoading: false });
      return { ok: false, error: res.error };
    }
    if (!res.data) {
      set({ documentOpenLoading: false });
      return { ok: false, error: 'not_found' };
    }
    const loaded = res.data;

    // 2. Detach any previous adapters BEFORE attaching new ones. Bewust géén
    //    noopPersistence (data-loss risk); detachPersistence stopt de
    //    debounce-timer expliciet.
    detachPersistence();
    detachVersions();
    resetAI();

    // 3. Reset design-doc store with fresh doc.
    useDesignDocStore.getState().reset(loaded.doc);
    useDesignDocStore.setState({ currentLockVersion: loaded.lock_version });

    // 4. Attach new adapters for this document.
    const versions = createSupabaseVersionHistoryAdapter({
      client: supabase,
      onLockVersionUpdate: (n) =>
        useDesignDocStore.setState({ currentLockVersion: n }),
    });
    const persistence = createSupabasePersistenceAdapter({
      client: supabase,
      projectDocumentId: loaded.document_id,
      schemaVersion: SCHEMA_VERSION,
      getExpectedLockVersion: () => useDesignDocStore.getState().currentLockVersion,
      onLockVersionUpdate: (n) =>
        useDesignDocStore.setState({ currentLockVersion: n }),
    });

    attachVersions(versions);
    // NodeRegistry vóór persistence — de store gebruikt hem in applyOps voor
    // property-key-validatie. Zonder registry werkt applyOps nog steeds (met
    // alleen node-existentie-check), maar dan zou een run door de AI met een
    // onbekende hero-prop stilletjes gestript worden door de Zod-parse.
    attachNodeRegistry(createDefaultRegistry());
    // Autosave-gate: attachPersistence als ALLERLAATSTE zodat scheduleSave
    // pas vuurt als alles staat.
    attachPersistence(persistence);
    attachAI(
      new ClaudeAIAdapter({
        client: supabase,
        projectDocumentId: loaded.document_id,
        supabaseUrl,
        supabaseAnonKey,
      }),
    );

    // 5. Update workspace-state met actieve doc-info.
    const project = get().projects.find((p) => p.id === loaded.project_id);
    set({
      activeDocumentId: loaded.document_id,
      activeDocumentTitle: loaded.title,
      activeProjectId: loaded.project_id,
      activeProjectName: project?.name ?? null,
      documentOpenLoading: false,
    });

    return { ok: true, data: null };
  },

  closeDocument() {
    detachPersistence();
    detachVersions();
    detachNodeRegistry();
    resetAI();
    // Reset design-doc store to een fresh (leeg) doc zodat er geen stale
    // content zichtbaar is als de user snel navigate't. seedLandingPage()
    // is een makkelijke placeholder.
    useDesignDocStore.getState().reset(seedLandingPage());
    useDesignDocStore.setState({ currentLockVersion: 0 });
    set({
      activeDocumentId: null,
      activeDocumentTitle: null,
    });
  },

  async createProjectWithDocument(input) {
    const orgId = get().activeOrgId;
    if (!orgId) return { ok: false, error: 'no_active_organization' };

    // Optioneel: content-source resolven vóór create. Fail-early — als de
    // bron ongeldig is willen we geen half-gekoppeld project achterlaten.
    let seed: DesignDoc;
    if (input.content_source) {
      const resolved = await resolveContentSource(supabase, input.content_source);
      if (!resolved.ok) {
        return { ok: false, error: `content_source_${resolved.error}` };
      }
      seed = seedFromTravelContent({
        travel: resolved.content,
        contentSourceId: resolved.contentSourceId,
        documentType: input.first_document_type as DesignDoc['project']['documentType'],
        documentTitle: input.first_document_title,
      });
    } else {
      seed = seedForType(input.first_document_type);
    }

    const res = await createProjectWithFirstDocument(supabase, {
      organization_id: orgId,
      project_name: input.project_name,
      project_description: input.project_description ?? null,
      first_document_type: input.first_document_type,
      first_document_title: input.first_document_title,
      seed_doc: seed,
      schema_version: SCHEMA_VERSION,
    });
    if (!res.ok) return { ok: false, error: res.error };
    // Refresh projects zodat het nieuwe project in de lijst zit.
    await get().refreshProjects();
    return {
      ok: true,
      data: {
        project_id: res.data.project_id,
        project_document_id: res.data.project_document_id,
      },
    };
  },

  async createDocumentInProject(input) {
    const seed = seedForType(input.document_type);
    const res = await createDocumentInProject(supabase, {
      project_id: input.project_id,
      document_type: input.document_type,
      title: input.title,
      seed_doc: seed,
      schema_version: SCHEMA_VERSION,
    });
    if (!res.ok) return { ok: false, error: res.error };
    // Refresh doc-lijst als het gaande project openstaat.
    if (get().activeProjectId === input.project_id) {
      const docs = await loadProjectDocuments(supabase, input.project_id);
      if (docs.ok) set({ documents: docs.data });
    }
    return { ok: true, data: { project_document_id: res.data.project_document_id } };
  },

  async renameProject(projectId, newName) {
    const res = await renameProject(supabase, projectId, newName);
    if (!res.ok) return res;
    // Optimistic local update (spaart een refresh-roundtrip).
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, name: newName } : p,
      ),
      activeProjectName:
        s.activeProjectId === projectId ? newName : s.activeProjectName,
    }));
    return { ok: true, data: null };
  },

  async duplicateProject(sourceId, newName) {
    const res = await duplicateProject(supabase, sourceId, newName);
    if (!res.ok) return res;
    await get().refreshProjects();
    return res;
  },

  async archiveProject(projectId) {
    const res = await archiveProject(supabase, projectId);
    if (!res.ok) return res;
    // Als het actieve project geasrchiveerd wordt, sluit 'm.
    if (get().activeProjectId === projectId) {
      get().closeProject();
    }
    if (get().activeDocumentId) {
      // Voor de zekerheid: als het actieve document tot dit project behoort,
      // sluiten. (Wordt door route-guard sowieso opgevangen bij navigeren.)
      const doc = get().documents.find((d) => d.id === get().activeDocumentId);
      if (doc?.project_id === projectId) get().closeDocument();
    }
    await get().refreshProjects();
    return { ok: true, data: null };
  },

  async restoreProject(projectId) {
    const res = await restoreProject(supabase, projectId);
    if (!res.ok) return res;
    await get().refreshProjects();
    return { ok: true, data: null };
  },
}));
