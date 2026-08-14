import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { type VersionHistoryAdapter } from '@design4/design-doc';
import { ChatPane } from '../chat/ChatPane.js';
import { PreviewPane } from '../preview/PreviewPane.js';
import { VersionHistoryPanel } from '../version-history/VersionHistoryPanel.js';
import { messageForRollbackError } from '../version-history/errorMessages.js';
import { useDesignDocStore } from '../../state/designDocStore.js';
import { useWorkspaceStore } from '../../state/workspaceStore.js';
import { useAuthStore } from '../../state/authStore.js';
import { supabase } from '../../adapters/supabase/client.js';
import { createSupabaseVersionHistoryAdapter } from '../../adapters/versions/supabase.js';
import { NewDocumentModal } from '../workspace/NewDocumentModal.js';

/**
 * De editor-route (/projects/:projectId/documents/:documentId).
 * Zorgt dat:
 *   1. Workspace geïnitialiseerd is (bij directe URL/refresh).
 *   2. Het document wordt geopend via useWorkspaceStore.openDocument — die
 *      detacht oude adapters en attach nieuwe voor deze doc.
 *   3. Bij unmount / navigatie weg → closeDocument (detacht adapters,
 *      cancelt pending saves).
 *   4. Header met breadcrumb naar dashboard/project + "+ Nieuw document" +
 *      "Uitloggen" — zodat de user niet vastzit in de editor.
 */
export function EditorView() {
  const { projectId, documentId } = useParams<{ projectId: string; documentId: string }>();

  const status = useWorkspaceStore((s) => s.status);
  const init = useWorkspaceStore((s) => s.init);
  const openDocument = useWorkspaceStore((s) => s.openDocument);
  const closeDocument = useWorkspaceStore((s) => s.closeDocument);
  const openProject = useWorkspaceStore((s) => s.openProject);
  const activeDocumentId = useWorkspaceStore((s) => s.activeDocumentId);
  const activeDocumentTitle = useWorkspaceStore((s) => s.activeDocumentTitle);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const activeProjectName = useWorkspaceStore((s) => s.activeProjectName);
  const documentOpenLoading = useWorkspaceStore((s) => s.documentOpenLoading);
  const projects = useWorkspaceStore((s) => s.projects);

  const doc = useDesignDocStore((s) => s.doc);
  const previewingVersion = useDesignDocStore((s) => s.previewingVersion);
  const restoreVersion = useDesignDocStore((s) => s.restoreVersion);
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  const [openError, setOpenError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewRestoreError, setPreviewRestoreError] = useState<string | null>(null);
  const [previewRestoreConfirm, setPreviewRestoreConfirm] = useState(false);
  const [newDocOpen, setNewDocOpen] = useState(false);

  // Init workspace bij directe URL / refresh.
  useEffect(() => {
    if (status === 'idle') init();
  }, [status, init]);

  // Load doc-lijst voor dit project (zodat de "+ Nieuw document"-modal en
  // een eventuele switcher werken).
  useEffect(() => {
    if (!projectId) return;
    if (status !== 'ready') return;
    if (activeProjectId !== projectId) {
      openProject(projectId);
    }
  }, [projectId, status, activeProjectId, openProject]);

  // Open het document zodra workspace klaar is + params bekend.
  useEffect(() => {
    if (!documentId) return;
    if (status !== 'ready') return;
    if (activeDocumentId === documentId) return;
    let cancelled = false;
    (async () => {
      setOpenError(null);
      const res = await openDocument(documentId);
      if (cancelled) return;
      if (!res.ok) setOpenError(res.error);
    })();
    return () => { cancelled = true; };
  }, [documentId, status, activeDocumentId, openDocument]);

  // Cleanup bij unmount: sluit het document (detacht adapters, cancels save).
  useEffect(() => {
    return () => {
      closeDocument();
    };
  }, [closeDocument]);

  // Één versions-adapter voor de lifetime van dit editor-mount. Bewust
  // niet re-instantiëren per doc-switch — de adapter is stateless en
  // krijgt project_document_id per methode-call.
  const versionsAdapter: VersionHistoryAdapter = useMemo(
    () =>
      createSupabaseVersionHistoryAdapter({
        client: supabase,
        onLockVersionUpdate: (n) =>
          useDesignDocStore.setState({ currentLockVersion: n }),
      }),
    [],
  );

  const handleRequestRestorePreviewed = () => {
    setPreviewRestoreError(null);
    setPreviewRestoreConfirm(true);
  };

  const handleConfirmRestorePreviewed = async () => {
    if (!previewingVersion) return;
    const result = await restoreVersion(previewingVersion);
    if (!result.ok) {
      setPreviewRestoreError(messageForRollbackError(result.error));
    }
    setPreviewRestoreConfirm(false);
  };

  if (!projectId || !documentId) return <Navigate to="/projects" replace />;

  if (status === 'idle' || status === 'loading-orgs' || status === 'loading-projects') {
    return <FullscreenNote>Werkruimte laden…</FullscreenNote>;
  }
  if (status === 'error') {
    return (
      <FullscreenNote>
        Werkruimte kon niet worden geladen.{' '}
        <Link to="/" style={crumbLink}>Terug</Link>
      </FullscreenNote>
    );
  }
  if (openError) {
    return (
      <FullscreenNote>
        Document kon niet worden geopend: {openError}.{' '}
        <Link to={`/projects/${projectId}`} style={crumbLink}>Terug naar project</Link>
      </FullscreenNote>
    );
  }
  if (documentOpenLoading || activeDocumentId !== documentId || !doc?.id) {
    return <FullscreenNote>Document openen…</FullscreenNote>;
  }

  const currentProject =
    projects.find((p) => p.id === projectId) ?? { name: activeProjectName ?? projectId };

  return (
    <div style={fullscreen}>
      <header style={header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6b7280', minWidth: 0 }}>
          <Link to="/projects" style={crumbLink}>Dashboard</Link>
          <span>›</span>
          <Link to={`/projects/${projectId}`} style={crumbLink}>{currentProject.name}</Link>
          <span>›</span>
          <span style={{ color: '#111827', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {activeDocumentTitle ?? '…'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" onClick={() => setNewDocOpen(true)} style={btnGhost}>
            + Nieuw document
          </button>
          <Link to={`/projects/${projectId}`} style={{ ...btnGhost, textDecoration: 'none' }}>
            Projectoverzicht
          </Link>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{user?.email}</span>
          <button type="button" onClick={() => signOut()} style={btnGhost}>
            Uitloggen
          </button>
        </div>
      </header>

      <div style={mainRow}>
        <ChatPane onOpenVersionHistory={() => setHistoryOpen(true)} />
        <PreviewPane onRequestRestorePreviewed={handleRequestRestorePreviewed} />
      </div>

      <VersionHistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        adapter={versionsAdapter}
        projectDocumentId={doc.id}
      />

      {previewRestoreConfirm && previewingVersion ? (
        <div style={confirmBackdrop} role="dialog" aria-modal="true">
          <div style={confirmBox}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              Versie {previewingVersion.version_number} herstellen?
            </div>
            <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>
              De huidige toestand wordt automatisch bewaard als nieuwe versie.
              Deze rollback is later ook weer ongedaan te maken door terug te keren
              naar die bewaarde versie.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setPreviewRestoreConfirm(false)} style={btnGhost}>
                Annuleren
              </button>
              <button type="button" onClick={handleConfirmRestorePreviewed} style={btnPrimary}>
                Herstel deze versie
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {previewRestoreError ? (
        <div style={toast} role="alert" onClick={() => setPreviewRestoreError(null)}>
          {previewRestoreError}
          <span style={{ marginLeft: 12, opacity: 0.7 }}>(klik om te sluiten)</span>
        </div>
      ) : null}

      {newDocOpen ? (
        <NewDocumentModal projectId={projectId} onClose={() => setNewDocOpen(false)} />
      ) : null}
    </div>
  );
}

function FullscreenNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#374151',
        background: '#f9fafb',
        fontSize: 14,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {children}
    </div>
  );
}

const fullscreen: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  background: '#f9fafb',
};
const header: React.CSSProperties = {
  padding: '8px 16px',
  background: '#fff',
  borderBottom: '1px solid #e5e7eb',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  minHeight: 44,
};
const mainRow: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  overflow: 'hidden',
};
const crumbLink: React.CSSProperties = {
  color: '#6b7280',
  textDecoration: 'none',
  padding: '4px 6px',
  borderRadius: 4,
};
const btnPrimary: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  border: '1px solid #4f46e5',
  borderRadius: 4,
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};
const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
};
const confirmBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 60,
};
const confirmBox: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  padding: 20,
  width: 'min(420px, 90vw)',
  boxShadow: '0 12px 32px rgba(15,23,42,0.25)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const toast: React.CSSProperties = {
  position: 'fixed',
  bottom: 24,
  right: 24,
  padding: '10px 14px',
  background: '#fef2f2',
  border: '1px solid #fecaca',
  color: '#991b1b',
  borderRadius: 6,
  fontSize: 12,
  boxShadow: '0 8px 24px rgba(15,23,42,0.15)',
  zIndex: 70,
  cursor: 'pointer',
  maxWidth: 400,
};
