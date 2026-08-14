import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useWorkspaceStore } from '../../state/workspaceStore.js';
import { NewDocumentModal } from './NewDocumentModal.js';

/**
 * Overzicht van documenten binnen één project.
 * Als het project maar 1 doc heeft → auto-redirect naar de editor.
 * Anders: doclijst gegroepeerd op type + Nieuw-document button.
 */
export function ProjectView() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const openProject = useWorkspaceStore((s) => s.openProject);
  const projects = useWorkspaceStore((s) => s.projects);
  const documents = useWorkspaceStore((s) => s.documents);
  const documentsLoading = useWorkspaceStore((s) => s.documentsLoading);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const status = useWorkspaceStore((s) => s.status);
  const init = useWorkspaceStore((s) => s.init);

  const [openError, setOpenError] = useState<string | null>(null);
  const [newDocOpen, setNewDocOpen] = useState(false);

  // Init workspace als de user direct via URL binnenkomt (refresh).
  useEffect(() => {
    if (status === 'idle') init();
  }, [status, init]);

  // Laad documenten van dit project.
  useEffect(() => {
    if (!projectId) return;
    if (status !== 'ready') return;
    if (activeProjectId !== projectId) {
      openProject(projectId).then((res) => {
        if (!res.ok) setOpenError(res.error);
      });
    }
  }, [projectId, status, activeProjectId, openProject]);

  const project = projects.find((p) => p.id === projectId);

  if (!projectId) return <Navigate to="/projects" replace />;

  if (status === 'idle' || status === 'loading-orgs' || status === 'loading-projects') {
    return <FullscreenNote>Laden…</FullscreenNote>;
  }
  if (status === 'error') {
    return <FullscreenNote>Er ging iets mis bij het laden van de werkruimte.</FullscreenNote>;
  }
  if (!project) {
    return (
      <FullscreenNote>
        Project niet gevonden of geen toegang.{' '}
        <Link to="/projects" style={{ color: '#4f46e5' }}>Terug naar dashboard</Link>
      </FullscreenNote>
    );
  }
  if (project.deleted_at !== null) {
    return (
      <FullscreenNote>
        Dit project is gearchiveerd. Herstel het eerst vanuit het dashboard.{' '}
        <Link to="/projects" style={{ color: '#4f46e5' }}>Terug naar dashboard</Link>
      </FullscreenNote>
    );
  }
  if (documentsLoading || (activeProjectId !== projectId && !openError)) {
    return <FullscreenNote>Documenten laden…</FullscreenNote>;
  }
  if (openError) {
    return <FullscreenNote>Documenten konden niet worden geladen: {openError}</FullscreenNote>;
  }

  // Als er precies 1 doc is: direct doorlink naar editor.
  if (documents.length === 1) {
    return <Navigate to={`/projects/${projectId}/documents/${documents[0]!.id}`} replace />;
  }

  return (
    <div style={fullscreen}>
      <header style={header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6b7280' }}>
          <Link to="/projects" style={crumbLink}>Dashboard</Link>
          <span>›</span>
          <span style={{ color: '#111827', fontWeight: 600 }}>{project.name}</span>
        </div>
        <button type="button" onClick={() => setNewDocOpen(true)} style={btnPrimary}>
          + Nieuw document
        </button>
      </header>

      <main style={main}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px' }}>{project.name}</h1>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>
          {documents.length === 0
            ? 'Nog geen documenten. Voeg er een toe om te beginnen.'
            : `${documents.length} document${documents.length === 1 ? '' : 'en'}.`}
        </p>

        {documents.length === 0 ? (
          <div
            style={{
              marginTop: 24,
              border: '2px dashed #d1d5db',
              borderRadius: 12,
              padding: 48,
              textAlign: 'center',
              color: '#6b7280',
            }}
          >
            <button type="button" onClick={() => setNewDocOpen(true)} style={btnPrimary}>
              + Voeg je eerste document toe
            </button>
          </div>
        ) : (
          <div style={{ ...grid, marginTop: 20 }}>
            {documents.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => navigate(`/projects/${projectId}/documents/${d.id}`)}
                style={docCard}
              >
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{d.title}</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>
                  <span style={typeBadge}>{d.document_type}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>

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
  minHeight: '100vh',
  background: '#f9fafb',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 24px',
  background: '#fff',
  borderBottom: '1px solid #e5e7eb',
};
const main: React.CSSProperties = {
  padding: '24px 32px',
  maxWidth: 1200,
  margin: '0 auto',
};
const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 16,
};
const docCard: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 14,
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const typeBadge: React.CSSProperties = {
  display: 'inline-block',
  background: '#f3f4f6',
  color: '#374151',
  padding: '1px 8px',
  borderRadius: 999,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 600,
};
const crumbLink: React.CSSProperties = {
  color: '#6b7280',
  textDecoration: 'none',
};
const btnPrimary: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  border: '1px solid #4f46e5',
  borderRadius: 4,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
