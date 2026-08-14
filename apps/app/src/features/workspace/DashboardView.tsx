import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../state/authStore.js';
import { useWorkspaceStore } from '../../state/workspaceStore.js';
import type { Project } from '../../adapters/persistence/workspaceApi.js';
import { NewProjectModal } from './NewProjectModal.js';

/**
 * Dashboard: project-lijst per organisatie + Nieuw-project button.
 * Toont actieve projecten in een grid + inklapbare "gearchiveerd"-sectie.
 * Per kaart: openen, hernoemen (inline), dupliceren, archiveren of restoren.
 */
export function DashboardView() {
  const navigate = useNavigate();
  const status = useWorkspaceStore((s) => s.status);
  const errorMessage = useWorkspaceStore((s) => s.errorMessage);
  const projects = useWorkspaceStore((s) => s.projects);
  const activeOrgName = useWorkspaceStore((s) => s.activeOrgName);
  const init = useWorkspaceStore((s) => s.init);
  const signOut = useAuthStore((s) => s.signOut);
  const userEmail = useAuthStore((s) => s.user?.email);

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  useEffect(() => {
    if (status === 'idle') init();
  }, [status, init]);

  const active = projects.filter((p) => p.deleted_at === null);
  const archived = projects.filter((p) => p.deleted_at !== null);

  return (
    <div style={fullscreen}>
      <header style={header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>design4.travel</div>
          {activeOrgName ? (
            <div style={{ fontSize: 12, color: '#6b7280' }}>· {activeOrgName}</div>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{userEmail}</span>
          <button type="button" onClick={() => signOut()} style={btnGhost}>
            Uitloggen
          </button>
        </div>
      </header>

      <main style={main}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Projecten</h1>
          <button type="button" onClick={() => setNewProjectOpen(true)} style={btnPrimary}>
            + Nieuw project
          </button>
        </div>

        {status === 'loading-orgs' || status === 'loading-projects' ? (
          <div style={{ color: '#6b7280' }}>Laden…</div>
        ) : status === 'error' ? (
          <div style={errorBanner}>{mapErrorMessage(errorMessage)}</div>
        ) : active.length === 0 && archived.length === 0 ? (
          <EmptyState onCreate={() => setNewProjectOpen(true)} />
        ) : (
          <>
            {active.length > 0 ? (
              <div style={grid}>
                {active.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    onOpen={() => navigate(`/projects/${p.id}`)}
                  />
                ))}
              </div>
            ) : (
              <div style={{ color: '#6b7280', fontStyle: 'italic', marginBottom: 20 }}>
                Geen actieve projecten. Maak een nieuw project of herstel een
                gearchiveerd project hieronder.
              </div>
            )}

            {archived.length > 0 ? (
              <section style={{ marginTop: 32 }}>
                <button
                  type="button"
                  onClick={() => setArchivedExpanded((v) => !v)}
                  style={{
                    ...btnGhost,
                    width: '100%',
                    justifyContent: 'flex-start',
                    display: 'flex',
                    gap: 8,
                    padding: '8px 12px',
                  }}
                >
                  <span>{archivedExpanded ? '▾' : '▸'}</span>
                  <span>Gearchiveerd ({archived.length})</span>
                </button>
                {archivedExpanded ? (
                  <div style={{ ...grid, marginTop: 12 }}>
                    {archived.map((p) => (
                      <ProjectCard
                        key={p.id}
                        project={p}
                        archived
                        onOpen={() => navigate(`/projects/${p.id}`)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </main>

      {newProjectOpen ? <NewProjectModal onClose={() => setNewProjectOpen(false)} /> : null}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate(): void }) {
  return (
    <div
      style={{
        border: '2px dashed #d1d5db',
        borderRadius: 12,
        padding: 48,
        textAlign: 'center',
        color: '#6b7280',
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, color: '#111827', marginBottom: 6 }}>
        Nog geen projecten.
      </div>
      <div style={{ fontSize: 13, marginBottom: 16 }}>
        Start je eerste project — bijvoorbeeld een landingspagina, een offerte
        of een roadbook.
      </div>
      <button type="button" onClick={onCreate} style={btnPrimary}>
        + Start je eerste project
      </button>
    </div>
  );
}

function ProjectCard({
  project,
  archived,
  onOpen,
}: {
  project: Project;
  archived?: boolean;
  onOpen(): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = useWorkspaceStore((s) => s.renameProject);
  const duplicate = useWorkspaceStore((s) => s.duplicateProject);
  const archive = useWorkspaceStore((s) => s.archiveProject);
  const restore = useWorkspaceStore((s) => s.restoreProject);

  async function submitRename() {
    if (nameDraft.trim().length === 0 || nameDraft === project.name) {
      setRenaming(false);
      setNameDraft(project.name);
      return;
    }
    setBusy(true);
    const res = await rename(project.id, nameDraft.trim());
    setBusy(false);
    if (!res.ok) setError(res.error);
    else { setRenaming(false); setError(null); }
  }

  async function onDuplicate() {
    setMenuOpen(false);
    const newName = window.prompt('Naam voor kopie:', `${project.name} (kopie)`);
    if (!newName || newName.trim().length === 0) return;
    setBusy(true);
    const res = await duplicate(project.id, newName.trim());
    setBusy(false);
    if (!res.ok) alert(`Dupliceren mislukt: ${res.error}`);
  }

  async function onArchive() {
    setMenuOpen(false);
    if (!window.confirm(`'${project.name}' archiveren?`)) return;
    setBusy(true);
    const res = await archive(project.id);
    setBusy(false);
    if (!res.ok) alert(`Archiveren mislukt: ${res.error}`);
  }

  async function onRestore() {
    setBusy(true);
    const res = await restore(project.id);
    setBusy(false);
    if (!res.ok) alert(`Herstellen mislukt: ${res.error}`);
  }

  const updatedLabel = formatRelative(project.updated_at);

  return (
    <div
      style={{
        ...cardStyle,
        opacity: archived ? 0.7 : 1,
      }}
    >
      <div
        onClick={() => !renaming && !archived && onOpen()}
        style={{ cursor: renaming || archived ? 'default' : 'pointer', flex: 1 }}
      >
        {renaming ? (
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') { setRenaming(false); setNameDraft(project.name); }
            }}
            autoFocus
            style={{
              fontSize: 15, fontWeight: 600, width: '100%',
              border: '1px solid #4f46e5', borderRadius: 4, padding: 4,
            }}
          />
        ) : (
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
            {project.name}
          </div>
        )}
        <div style={{ fontSize: 11, color: '#6b7280' }}>
          <span style={typeBadge}>{project.document_type}</span> · {updatedLabel}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {archived ? (
          <button type="button" onClick={onRestore} style={btnGhost} disabled={busy}>
            {busy ? 'Bezig…' : 'Herstel'}
          </button>
        ) : (
          <>
            <button type="button" onClick={onOpen} style={btnPrimary} disabled={busy}>
              Openen
            </button>
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                style={btnGhost}
                disabled={busy}
              >
                ⋯
              </button>
              {menuOpen ? (
                <div
                  style={{
                    position: 'absolute',
                    top: '100%',
                    right: 0,
                    marginTop: 4,
                    background: '#fff',
                    border: '1px solid #e5e7eb',
                    borderRadius: 6,
                    boxShadow: '0 8px 24px rgba(15,23,42,0.15)',
                    zIndex: 10,
                    minWidth: 140,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => { setMenuOpen(false); setRenaming(true); }}
                    style={menuItem}
                  >
                    Hernoemen
                  </button>
                  <button type="button" onClick={onDuplicate} style={menuItem}>
                    Dupliceren
                  </button>
                  <button type="button" onClick={onArchive} style={{ ...menuItem, color: '#b91c1c' }}>
                    Archiveren
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
      {error ? (
        <div style={{ fontSize: 11, color: '#991b1b', marginTop: 4 }}>{error}</div>
      ) : null}
    </div>
  );
}

function mapErrorMessage(code: string | null): string {
  if (!code) return 'Er ging iets mis.';
  if (code === 'no_active_organization') {
    return 'Er is geen actieve werkruimte gekoppeld aan je account. Neem contact op met de beheerder.';
  }
  return `Er ging iets mis: ${code}`;
}

function formatRelative(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'net';
  if (min < 60) return `${min}m geleden`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}u geleden`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d geleden`;
  return new Date(iso).toLocaleDateString('nl-NL');
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
  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: 16,
};
const cardStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 120,
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
const menuItem: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  padding: '8px 12px',
  fontSize: 13,
  cursor: 'pointer',
  color: '#111827',
};
const errorBanner: React.CSSProperties = {
  background: '#fee2e2',
  border: '1px solid #fecaca',
  color: '#991b1b',
  padding: '10px 14px',
  borderRadius: 6,
  fontSize: 13,
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
const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
};
