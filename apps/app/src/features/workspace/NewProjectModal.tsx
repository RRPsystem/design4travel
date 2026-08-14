import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../../state/workspaceStore.js';

const DOCUMENT_TYPES = [
  { value: 'website', label: 'Website', description: 'Landings- of contentpagina voor het web.' },
  { value: 'offerte', label: 'Offerte', description: 'Reisvoorstel of prijsopgave.' },
  { value: 'roadbook', label: 'Roadbook', description: 'Dag-tot-dag reisprogramma.' },
  { value: 'brochure', label: 'Brochure', description: 'Print-brochure of PDF-flyer.' },
  { value: 'social', label: 'Social', description: 'Post-formaat voor social media.' },
  { value: 'document', label: 'Document', description: 'Generiek meerpagina-document.' },
] as const;

interface Props {
  onClose(): void;
}

/**
 * "Nieuw project"-modal. Roept createProjectWithDocument (atomische Edge
 * Function) aan zodat er nooit een leeg project achterblijft bij faalstap.
 *
 * Per user-brief: het type is het type van het EERSTE document. Volgende
 * docs binnen dit project mogen ander type hebben (project_documents.
 * document_type is per-doc).
 */
export function NewProjectModal({ onClose }: Props) {
  const navigate = useNavigate();
  const createProjectWithDocument = useWorkspaceStore((s) => s.createProjectWithDocument);

  const [projectName, setProjectName] = useState('');
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentType, setDocumentType] = useState<string>('website');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    projectName.trim().length > 0 &&
    documentTitle.trim().length > 0 &&
    !busy;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const res = await createProjectWithDocument({
      project_name: projectName.trim(),
      first_document_type: documentType,
      first_document_title: documentTitle.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(mapError(res.error));
      return;
    }
    // Sluit modal + navigate naar de editor van het net-aangemaakte doc.
    onClose();
    navigate(`/projects/${res.data.project_id}/documents/${res.data.project_document_id}`);
  }

  return (
    <div style={backdrop} role="dialog" aria-modal="true">
      <div style={panel}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Nieuw project</h2>
        <p style={{ margin: '4px 0 12px', color: '#6b7280', fontSize: 12 }}>
          Kies een naam voor het project en het type van het eerste document.
          Je kunt later meer documenten van andere types toevoegen.
        </p>

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={label}>
            Projectnaam
            <input
              type="text"
              value={projectName}
              onChange={(e) => {
                setProjectName(e.target.value);
                if (!documentTitle.trim()) setDocumentTitle(e.target.value);
              }}
              placeholder="bv. Golfreizen Portugal 2027"
              maxLength={200}
              required
              autoFocus
              style={input}
            />
          </label>

          <label style={label}>
            Titel van eerste document
            <input
              type="text"
              value={documentTitle}
              onChange={(e) => setDocumentTitle(e.target.value)}
              placeholder="bv. Homepagina"
              maxLength={200}
              required
              style={input}
            />
          </label>

          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend style={{ ...label, marginBottom: 6 }}>Type van eerste document</legend>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {DOCUMENT_TYPES.map((t) => (
                <label
                  key={t.value}
                  style={{
                    ...typeCard,
                    borderColor: documentType === t.value ? '#4f46e5' : '#e5e7eb',
                    background: documentType === t.value ? '#eef2ff' : '#fff',
                  }}
                >
                  <input
                    type="radio"
                    name="document_type"
                    value={t.value}
                    checked={documentType === t.value}
                    onChange={() => setDocumentType(t.value)}
                    style={{ marginRight: 6 }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{t.label}</div>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>{t.description}</div>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>

          {error ? (
            <div style={{ background: '#fee2e2', color: '#991b1b', padding: 8, borderRadius: 4, fontSize: 12 }}>
              {error}
            </div>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button type="button" onClick={onClose} style={btnGhost} disabled={busy}>
              Annuleren
            </button>
            <button type="submit" style={btnPrimary} disabled={!canSubmit}>
              {busy ? 'Bezig…' : 'Aanmaken'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function mapError(code: string): string {
  switch (code) {
    case 'project_quota_exceeded':
      return 'Je hebt het maximum aantal actieve projecten bereikt (20). Archiveer eerst een project.';
    case 'insufficient_role':
      return 'Je hebt niet de juiste rol om projecten aan te maken.';
    case 'membership_not_active':
      return 'Je bent geen actief lid meer van deze werkruimte.';
    case 'organization_not_active':
      return 'De werkruimte is niet meer actief.';
    case 'no_active_organization':
      return 'Er is geen actieve werkruimte gekoppeld aan je account.';
    default:
      return `Er ging iets mis: ${code}`;
  }
}

const backdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};
const panel: React.CSSProperties = {
  background: '#fff',
  borderRadius: 10,
  padding: 20,
  width: 'min(520px, 92vw)',
  boxShadow: '0 24px 48px rgba(15,23,42,0.35)',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
const label: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#374151',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const input: React.CSSProperties = {
  border: '1px solid #d1d5db',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 14,
  fontFamily: 'inherit',
};
const typeCard: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 4,
  padding: 8,
  border: '1px solid #e5e7eb',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
};
const btnPrimary: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  border: '1px solid #4f46e5',
  borderRadius: 4,
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
const btnGhost: React.CSSProperties = {
  background: 'transparent',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  padding: '8px 12px',
  fontSize: 13,
  cursor: 'pointer',
};
